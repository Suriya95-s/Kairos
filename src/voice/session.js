// src/voice/session.js
// Voice as a surface (8.1 / 8.2), not as a subsystem.
//
// The design constraint that shapes everything here: **the router must not know
// that voice exists**. A spoken utterance becomes an ordinary `utterance` event
// on the bus, identical to one typed into the CLI except for `source:
// 'user.voice'`. If voice needed its own routing, its own memory rules or its
// own approval path, then every future surface would need those too, and the
// four already built would drift apart.
//
// No engine is bundled. STT and TTS are injected — a local Whisper-class model
// is the privacy default the plan calls for, but shipping a binary, downloading
// a model, or defaulting to a cloud API are all decisions for the person who
// owns the machine and the microphone. What is built is the state machine
// around them, which is the part that is easy to get subtly wrong.
//
// Barge-in is the reason this is a state machine at all. When the user speaks
// while the system is talking, three things must happen in order: stop
// speaking *immediately*, discard the rest of the utterance being spoken, and
// route what they said as an interruption (P4.4). Getting the order wrong means
// talking over someone, which is the rudest thing an assistant can do.

/**
 * Levenshtein distance, bounded by the two-row trick.
 *
 * Small and self-contained on purpose: this runs on two short words once per
 * utterance, so the cost is irrelevant and a dependency would not be.
 */
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(substitution, previous[j] + 1, current[j - 1] + 1);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}

/**
 * Renderings of a wake word that a transcriber has actually produced.
 *
 * Every entry here was observed on real hardware, not imagined. That matters:
 * the alternative to a list of measured facts is a wider edit-distance budget,
 * and slack applied uniformly to a six-letter word starts matching ordinary
 * English. This is the narrow fix — it accepts exactly what the model does,
 * and nothing else.
 */
export const WAKE_ALIASES = Object.freeze({
  kairos: Object.freeze(['kyros', 'chiros', 'cairos', 'karos', 'okayrose', 'okrose', 'kaniyarous']),
});

/**
 * Reduce a word to roughly what it sounds like.
 *
 * Four live runs produced four spellings of the same spoken word — "Kyros",
 * "Chiros", "Okay Rose", "Kaniyarou's" — while the *command* after it came back
 * verbatim every time. That asymmetry is the whole problem: an invented name has
 * no dictionary entry, so the decoder spells it freshly each time, and adding one
 * alias per observation never catches up. All four are homophones, so comparing
 * sound converges where comparing spelling does not.
 *
 * The initial letter is kept and only later vowels are dropped. Without that
 * anchor "across" reduces to the same skeleton as "kairos" and starts waking the
 * assistant, which the existing guard tests caught immediately.
 */
export function phoneticSkeleton(word) {
  let s = String(word).toLowerCase().replace(/[^a-z]/g, '');
  if (!s) return '';
  s = s.replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/ch/g, 'k')
    .replace(/c/g, 'k').replace(/q/g, 'k').replace(/x/g, 'ks').replace(/z/g, 's');
  const skeleton = s[0] + s.slice(1).replace(/[aeiouyh]/g, '');
  return skeleton.replace(/(.)\1+/g, '$1');
}

/** What the voice surface is doing right now. */
export const VOICE_STATES = Object.freeze([
  'idle',        // not listening — push-to-talk released, or wake word off
  'waiting',     // listening for the wake word only
  'listening',   // capturing an utterance
  'thinking',    // utterance dispatched, awaiting an answer
  'speaking',    // rendering a reply aloud
]);

export class VoiceSession {
  /**
   * @param {object} opts
   * @param {function} [opts.stt]      async ({signal}) => {text, confidence}
   * @param {function} [opts.tts]      async (text, {signal}) => void
   * @param {function} [opts.onUtterance] async (text, meta) => reply
   * @param {object}   [opts.bus]
   * @param {string}   [opts.wakeWord]
   * @param {number}   [opts.minConfidence]
   * @param {function} [opts.now]
   */
  constructor({
    stt = null, tts = null, onUtterance = null, bus = null,
    wakeWord = null, minConfidence = 0.5, sessionId = null, now = Date.now,
    wakeTolerance = 2, wakeAliases = null,
  } = {}) {
    this._stt = stt;
    this._tts = tts;
    this._onUtterance = onUtterance;
    this._bus = bus;
    this._wakeWord = wakeWord ? String(wakeWord).toLowerCase() : null;
    this._wakeTolerance = wakeTolerance;
    // Compared against the first words joined together, so the targets are
    // stored the same way: lowercase, letters and digits only.
    const bare = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    const aliases = wakeAliases ?? (this._wakeWord ? WAKE_ALIASES[this._wakeWord] ?? [] : []);
    this._wakeTargets = this._wakeWord
      ? [...new Set([bare(this._wakeWord), ...aliases.map(bare)])].filter(Boolean)
      : [];
    this._wakeSounds = new Set(this._wakeTargets.map(phoneticSkeleton).filter(Boolean));
    this._minConfidence = minConfidence;
    this._sessionId = sessionId;
    this._now = now;

    this.state = 'idle';
    this._speakController = null;
    this._listenController = null;
    this.bargeIns = 0;
    this.utterances = 0;
    this.history = [];
  }

  _setState(next) {
    if (!VOICE_STATES.includes(next)) throw new Error(`invalid voice state "${next}"`);
    const previous = this.state;
    this.state = next;
    this.history.push({ from: previous, to: next, at: this._now() });
    if (this.history.length > 100) this.history.shift();
    return next;
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  /**
   * Begin capturing (push-to-talk pressed, or the wake word fired).
   *
   * If the system is mid-sentence this is a barge-in, and it is handled before
   * anything else: stop talking, then listen. A half-second of continued speech
   * after someone starts talking is exactly what makes voice assistants feel
   * like they are not listening.
   */
  async beginListening({ reason = 'push-to-talk' } = {}) {
    if (this.state === 'speaking') this.bargeIn();
    if (!this._stt) throw new Error('no speech-to-text engine is configured');

    this._setState('listening');
    this._listenController = new AbortController();

    let heard;
    try {
      heard = await this._stt({ signal: this._listenController.signal });
    } catch (err) {
      this._setState('idle');
      if (err?.name === 'AbortError') return { cancelled: true };
      return { error: err?.message || String(err) };
    } finally {
      this._listenController = null;
    }

    const text = String(heard?.text || '').trim();
    const confidence = heard?.confidence ?? 1;

    // The capture layer can reject an utterance as not-the-owner before any
    // transcription happens. Distinct from silence: the owner deserves to know
    // their assistant heard a voice and chose not to obey it, with the score
    // that made the decision.
    if (heard?.rejected === 'speaker') {
      this._setState(this._wakeWord ? 'waiting' : 'idle');
      return { text: '', ignored: 'unrecognized voice', speaker: heard.stats?.speaker ?? null };
    }

    if (!text) { this._setState('idle'); return { text: '', ignored: 'nothing heard' }; }

    // A low-confidence transcript is worse than silence: acting on a misheard
    // instruction is how a voice interface does something nobody asked for.
    if (confidence < this._minConfidence) {
      this._setState('idle');
      const msg = 'Sorry — I didn\'t catch that.';
      await this.speak(msg);
      return { text, confidence, ignored: 'low confidence' };
    }

    const stripped = this._stripWakeWord(text);
    if (stripped === null) {
      this._setState(this._wakeWord ? 'waiting' : 'idle');
      return { text, ignored: 'no wake word' };
    }

    return this.dispatch(stripped, { reason, confidence });
  }

  /**
   * Route a transcript as an ordinary utterance.
   *
   * Exposed separately so a transcript from anywhere — a phone, a test, a
   * different engine — takes exactly the same path.
   */
  async dispatch(text, { reason = 'voice', confidence = 1 } = {}) {
    this.utterances++;
    this._setState('thinking');

    // The bus event is indistinguishable from a typed one apart from `source`.
    // That is the whole point: the router does not branch on voice.
    this._publish(text, confidence);

    if (!this._onUtterance) { this._setState('idle'); return { text, reply: null }; }

    let reply;
    try {
      reply = await this._onUtterance(text, { source: 'user.voice', reason, confidence, sessionId: this._sessionId });
    } catch (err) {
      this._setState('idle');
      return { text, error: err?.message || String(err) };
    }

    const spoken = typeof reply === 'string' ? reply : (reply?.speakable ?? reply?.text ?? '');
    if (spoken) await this.speak(spoken);
    else this._setState('idle');

    return { text, reply, confidence };
  }

  /**
   * Remove the wake word, or reject the utterance when one is required and
   * absent. Returns null to mean "this was not addressed to us".
   */
  _stripWakeWord(text) {
    if (!this._wakeWord) return text;
    const lower = text.toLowerCase();
    const at = lower.indexOf(this._wakeWord);
    // The wake word must be at or near the start. Matching it anywhere would
    // make any sentence that mentions the assistant's name a command.
    // …and it must be a whole word. A bare substring search treats "Kairose" as
    // the wake word followed by "e", which is how a transcript of "Kairose,
    // status" was routed as the request "e status". The approximate matcher
    // below handles that case properly; this fast path must decline it rather
    // than half-consume the word.
    const end = at + this._wakeWord.length;
    if (at !== -1 && at <= 12 && !/[a-z0-9]/.test(lower.charAt(end))) {
      const after = text.slice(end).replace(/^['’]s\b/, '');
      return after.replace(/^[\s,.:;!?-]+/, '').trim() || '';
    }
    return this._stripApproximateWakeWord(text);
  }

  /**
   * Accept the wake word as the transcriber actually rendered it.
   *
   * A wake word is a proper noun, which is the single hardest thing for a
   * speech model to get right: it has no dictionary entry and, in a short
   * utterance, no surrounding context to recover it from. "Kairos" comes back
   * as "Kyros", "Chiros" or "Cairo's" depending on the run.
   *
   * Seeding the decoder with the word was tried first and measured worse — it
   * turned a correct transcript into "Kyros". So the variance is absorbed here
   * instead, where it costs nothing: an edit distance of 2 over the first few
   * words. Only the *first* words are considered, which preserves the property
   * that matters — that mentioning the assistant mid-sentence is not a command.
   */
  _stripApproximateWakeWord(text) {
    if (this._wakeTolerance <= 0) return null;

    const words = text.split(/\s+/);
    const joined = (take) => words.slice(0, take).join('').toLowerCase().replace(/[^a-z0-9]/g, '');
    const rest = (take) => words.slice(take).join('').length === 0
      ? ''
      : words.slice(take).join(' ').replace(/^[\s,.:;!?-]+/, '').trim();
    const maxTake = Math.min(3, words.length);

    // Whisper does not only misspell the wake word, it re-segments it: "Kairos"
    // came back from real hardware as "Okay Rose" — two dictionary words that
    // sound like the one word that was said. A matcher comparing tokens one at a
    // time cannot see that however generous its budget, so the first few words
    // are also tried joined together.
    //
    // Known renderings are matched *exactly*, and deliberately so. Giving each
    // alias its own edit budget multiplies the false-accept surface instead of
    // narrowing it: "carols at christmas" sits two edits from the observed
    // rendering "cairos", and started waking the assistant the moment the alias
    // was allowed to match approximately. Longest match first, so a two-word
    // rendering is not half-consumed by a one-word near-miss.
    for (let take = maxTake; take >= 1; take--) {
      if (this._wakeTargets.includes(joined(take))) return rest(take);
    }

    // Then by sound, also exactly. A three-consonant name has homophones —
    // "cross", "course" and "cars" all reduce to the same skeleton as "kairos" —
    // so an utterance *starting* with one of those does wake it. That is the
    // accepted cost: the false-reject rate this replaces was five runs out of
    // five, and a false wake costs one wrong answer rather than a dead surface.
    for (let take = maxTake; take >= 1; take--) {
      if (this._wakeSounds.has(phoneticSkeleton(joined(take)))) return rest(take);
    }

    // The edit budget applies to the wake word alone.
    for (let take = 1; take <= maxTake; take++) {
      const bare = joined(take);
      if (!bare) continue;
      if (Math.abs(bare.length - this._wakeWord.length) > this._wakeTolerance) continue;
      if (editDistance(bare, this._wakeWord) <= this._wakeTolerance) return rest(take);
    }

    const tokens = words.slice(0, 2);
    let consumed = 0;
    for (const token of tokens) {
      consumed += 1;
      const bare = token.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!bare) continue;
      // A length guard first: it is cheap, and it stops short words from
      // landing inside the distance budget by accident.
      if (Math.abs(bare.length - this._wakeWord.length) > this._wakeTolerance) continue;
      if (editDistance(bare, this._wakeWord) > this._wakeTolerance) continue;

      const after = words.slice(consumed).join(' ');
      return after.replace(/^[\s,.:;!?-]+/, '').trim() || '';
    }
    return null;
  }

  // ── Output ────────────────────────────────────────────────────────────────

  /**
   * Say something. Resolves when finished, or immediately when barged in on.
   * Text is rendered speakable first — screen output read aloud is unlistenable.
   */
  async speak(text) {
    const { toSpeakable } = await import('./speakable.js');
    const spoken = toSpeakable(text);
    if (!spoken) { this._setState('idle'); return { spoken: '' }; }
    if (!this._tts) { this._setState('idle'); return { spoken, skipped: 'no tts engine' }; }

    this._setState('speaking');
    this._speakController = new AbortController();
    try {
      await this._tts(spoken, { signal: this._speakController.signal });
      return { spoken };
    } catch (err) {
      if (err?.name === 'AbortError') return { spoken, interrupted: true };
      return { spoken, error: err?.message || String(err) };
    } finally {
      this._speakController = null;
      // Only fall back to idle if a barge-in has not already moved us on to
      // listening — otherwise the state would flap and drop the interruption.
      if (this.state === 'speaking') this._setState('idle');
    }
  }

  /**
   * Stop talking immediately.
   *
   * Synchronous by design: the abort must land before the caller does anything
   * else, because "stop talking" that takes a tick is a system that talks over
   * you. It also feeds the P4.4 interruption path — a barge-in IS a user
   * message arriving mid-activity.
   */
  bargeIn() {
    if (this.state !== 'speaking') return false;
    this.bargeIns++;
    try { this._speakController?.abort(); } catch { /* already gone */ }
    this._setState('idle');
    this._publishEvent('barge_in', {});
    return true;
  }

  /** Cancel an in-flight capture (push-to-talk released early). */
  cancelListening() {
    if (this.state !== 'listening') return false;
    try { this._listenController?.abort(); } catch { /* already gone */ }
    this._setState('idle');
    return true;
  }

  /** Arm wake-word listening. */
  arm() { this._setState(this._wakeWord ? 'waiting' : 'idle'); return this.state; }

  _publish(text, confidence) {
    this._publishEvent('utterance', { text, confidence }, 'utterance');
  }

  _publishEvent(action, payload, kind = 'observation') {
    if (!this._bus) return;
    try {
      this._bus.publish({
        source: 'user.voice',
        kind,
        sessionId: this._sessionId,
        urgency: 'now',
        payload: kind === 'utterance' ? payload : { action, ...payload },
      });
    } catch { /* a surface must never break the bus it reports to */ }
  }

  status() {
    return {
      state: this.state,
      wakeWord: this._wakeWord,
      utterances: this.utterances,
      bargeIns: this.bargeIns,
      hasStt: !!this._stt,
      hasTts: !!this._tts,
    };
  }
}

/**
 * Wrap a command-line STT engine (whisper.cpp and friends).
 *
 * A local binary is the privacy default the plan asks for: audio never leaves
 * the machine. Nothing is bundled — the user points this at the engine they
 * already trust.
 */
export function commandLineStt({ command, args = [], parse = null, spawnFn = null }) {
  return async ({ signal } = {}) => {
    const { spawn } = spawnFn ? { spawn: spawnFn } : await import('node:child_process');
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { windowsHide: true });
      let out = '';
      let err = '';
      child.stdout?.on('data', d => { out += d; });
      child.stderr?.on('data', d => { err += d; });
      signal?.addEventListener('abort', () => { try { child.kill(); } catch {} }, { once: true });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (signal?.aborted) {
          const e = new Error('aborted'); e.name = 'AbortError'; return reject(e);
        }
        if (code !== 0) return reject(new Error(`stt exited ${code}: ${err.slice(-200)}`));
        resolve(parse ? parse(out) : { text: out.trim(), confidence: 1 });
      });
    });
  };
}

/** Wrap a command-line TTS engine. Abort kills the process — that is barge-in. */
export function commandLineTts({ command, args = () => [], spawnFn = null }) {
  return async (text, { signal } = {}) => {
    const { spawn } = spawnFn ? { spawn: spawnFn } : await import('node:child_process');
    return new Promise((resolve, reject) => {
      const child = spawn(command, args(text), { windowsHide: true });
      signal?.addEventListener('abort', () => { try { child.kill(); } catch {} }, { once: true });
      child.on('error', reject);
      child.on('exit', () => {
        if (signal?.aborted) {
          const e = new Error('aborted'); e.name = 'AbortError'; return reject(e);
        }
        resolve();
      });
    });
  };
}
