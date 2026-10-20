// src/voice/pcm.js
// Raw audio arithmetic. Small, boring, and the source of the bugs that are
// hardest to see, because wrong audio does not throw — it just sounds wrong,
// or endpoints in the wrong place, and there is nothing in a log to explain it.
//
// Two of those bugs are designed out here rather than commented about later:
//
//   1. **Chunk boundaries are not sample boundaries.** A pipe delivers whatever
//      bytes have arrived, which is regularly an odd number. Reading 16-bit
//      samples from a buffer that starts half a sample late turns the whole
//      remainder of the stream into noise, and the level meter into nonsense.
//      FrameSplitter carries the remainder instead.
//
//   2. **A WAV header must be written after the length is known.** Streaming
//      capture does not know how long the utterance is until it is over, so the
//      header is built at the end, from the actual byte count.

/** signed 16-bit little-endian is what every backend here is asked for. */
export const BYTES_PER_SAMPLE = 2;

const FULL_SCALE = 32768;

/**
 * How much of a buffer is pinned against the rails.
 *
 * The third distinct way audio can be wrong without anything throwing, and the
 * one that cost the most to find. RMS cannot see clipping — a clipped frame's
 * energy simply looks high — so amplification that flattens the tops of the
 * waveform passes every check in the pipeline and arrives at the transcriber as
 * a percussive noise. Whisper's answer to that is "(drumming)", "(popping)",
 * "[MUSIC PLAYING]", delivered with the same confidence as a transcript, and the
 * owner concludes the microphone is broken.
 *
 * Measured on samples rather than frames for the same reason.
 *
 * @param {Buffer} pcm
 * @returns {{clipped: number, clipping: boolean, peakSample: number}}
 */
export function clippingOf(pcm) {
  const usable = pcm.length - (pcm.length % BYTES_PER_SAMPLE);
  if (usable <= 0) return { clipped: 0, clipping: false, peakSample: 0 };

  let clipped = 0;
  let peak = 0;
  for (let i = 0; i < usable; i += BYTES_PER_SAMPLE) {
    const value = Math.abs(pcm.readInt16LE(i));
    if (value > peak) peak = value;
    // Within 0.2 dB of full scale. A converter that has run out of headroom
    // returns the rail value repeatedly, so counting exact maxima alone would
    // miss the shoulders of the same distortion.
    if (value >= 32000) clipped++;
  }
  const total = usable / BYTES_PER_SAMPLE;
  return {
    clipped: Math.round((clipped / total) * 1e6) / 1e6,
    clipping: clipped > 0,
    peakSample: Math.round((peak / FULL_SCALE) * 10000) / 10000,
  };
}

/**
 * Normalized RMS energy of one frame of s16le PCM, in 0..1.
 *
 * RMS rather than peak: a single click has a large peak and carries no speech,
 * and gating on peaks means every keyboard press opens the microphone.
 *
 * @param {Buffer} frame
 * @returns {number}
 */
export function rmsOfFrame(frame) {
  const usable = frame.length - (frame.length % BYTES_PER_SAMPLE);
  if (usable <= 0) return 0;

  let sum = 0;
  for (let i = 0; i < usable; i += BYTES_PER_SAMPLE) {
    const sample = frame.readInt16LE(i);
    sum += sample * sample;
  }
  return Math.sqrt(sum / (usable / BYTES_PER_SAMPLE)) / FULL_SCALE;
}

/** Level in dBFS, for anything that wants to draw a meter. */
export function toDbfs(level) {
  return level <= 0 ? -Infinity : 20 * Math.log10(level);
}

/**
 * Cut a byte stream into fixed-size frames, keeping the leftovers.
 *
 * The leftover carry is the entire point of the class. Everything else is
 * bookkeeping.
 */
export class FrameSplitter {
  /** @param {number} frameBytes must be a whole number of samples */
  constructor(frameBytes) {
    if (!Number.isInteger(frameBytes) || frameBytes <= 0) {
      throw new Error('frameBytes must be a positive integer');
    }
    if (frameBytes % BYTES_PER_SAMPLE !== 0) {
      throw new Error('frameBytes must be a whole number of samples');
    }
    this.frameBytes = frameBytes;
    this._carry = Buffer.alloc(0);
  }

  /**
   * @param {Buffer} chunk
   * @returns {Buffer[]} whole frames, possibly none
   */
  push(chunk) {
    const buf = this._carry.length ? Buffer.concat([this._carry, chunk]) : chunk;
    const frames = [];
    let offset = 0;
    while (buf.length - offset >= this.frameBytes) {
      // subarray, not slice-copy: these frames are read once for their energy
      // and then either dropped or concatenated, so a copy per frame is pure
      // waste at fifty frames a second.
      frames.push(buf.subarray(offset, offset + this.frameBytes));
      offset += this.frameBytes;
    }
    // The tail must be copied. `buf` may be the caller's chunk, and the stream
    // is free to reuse that memory once this returns.
    this._carry = Buffer.from(buf.subarray(offset));
    return frames;
  }

  /** Whatever did not fill a frame, zero-padded. Called when the stream ends. */
  flush() {
    if (this._carry.length === 0) return null;
    const frame = Buffer.alloc(this.frameBytes);
    this._carry.copy(frame);
    this._carry = Buffer.alloc(0);
    return frame;
  }

  get pending() { return this._carry.length; }
}

/**
 * Wrap raw PCM in a WAV container.
 *
 * Needed because command-line transcribers overwhelmingly take a file, not a
 * stream, and want to be told the sample rate rather than guess it. whisper.cpp
 * in particular refuses anything that is not 16kHz mono.
 *
 * @param {Buffer} pcm  s16le samples
 * @param {object} [format]
 * @returns {Buffer}
 */
export function pcmToWav(pcm, { sampleRate = 16000, channels = 1, bitDepth = 16 } = {}) {
  const blockAlign = channels * (bitDepth / 8);
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  // Everything after this field: 36 header bytes + the samples.
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);

  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);          // PCM fmt chunk size
  header.writeUInt16LE(1, 20);           // format 1 = uncompressed PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);

  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

/**
 * Generate PCM. Used by the tests, and by anyone who wants to check their
 * endpointing thresholds without saying "testing, testing" into a laptop.
 *
 * @param {object} opts
 * @param {number} opts.ms
 * @param {number} [opts.amplitude] 0..1
 * @param {number} [opts.freq]      0 for noise-free silence
 */
export function synthPcm({ ms, amplitude = 0, freq = 220, sampleRate = 16000 } = {}) {
  const samples = Math.round((ms / 1000) * sampleRate);
  const buf = Buffer.alloc(samples * BYTES_PER_SAMPLE);
  for (let i = 0; i < samples; i++) {
    const value = amplitude === 0
      ? 0
      : Math.sin((2 * Math.PI * freq * i) / sampleRate) * amplitude * (FULL_SCALE - 1);
    buf.writeInt16LE(Math.round(value), i * BYTES_PER_SAMPLE);
  }
  return buf;
}
