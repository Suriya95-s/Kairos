// src/views/voice.js — the Voice view (page 6).
//
// What the microphone is doing, live: every utterance with its speaker score,
// what the wake gate did with it, what Kairos answered, and — while the
// synthesiser is talking — a small waveform so "speaking" is visible from
// across the room. The voice loop runs in its own process; everything here
// arrives over the daemon bus as `voice` events (src/kernel/daemon.js
// noteVoice), so this view works from any attached terminal.
//
// The animation respects reducedMotion(): a static note replaces the moving
// waveform, because accessibility floors are floors.

import {
  boxTop, boxBot, boxRow,
  C, gr, bold, padEnd, visLen, reducedMotion,
} from '../render.js';
import { state } from '../state.js';

/** Ring-buffer cap for voice events. Enough to scroll back a conversation. */
export const VOICE_EVENT_CAP = 100;

/**
 * Fold one adapted `voice` event into state.voice. Called by the app's event
 * handler; pure over its inputs so it is testable without a daemon.
 * @param {object} voice   state.voice (mutated copy returned)
 * @param {object} ev      {phase, text, score, threshold, verified, reason, timing}
 * @param {number} [nowMs]
 */
export function foldVoiceEvent(voice, ev, nowMs = Date.now()) {
  const v = { ...voice };
  const entry = { ts: nowMs, ...ev };

  switch (ev.phase) {
    case 'speaking':
      v.speaking = true;
      v.speakingText = ev.text || '';
      break;
    case 'spoke':
      v.speaking = false;
      v.speakingText = '';
      break;
    case 'answer':
      v.lastAnswer = entry;
      v.events = [entry, ...v.events].slice(0, VOICE_EVENT_CAP);
      break;
    case 'heard':
      v.lastHeard = entry;
      v.events = [entry, ...v.events].slice(0, VOICE_EVENT_CAP);
      break;
    default:  // 'ignored' and anything a newer CLI invents
      v.events = [entry, ...v.events].slice(0, VOICE_EVENT_CAP);
      break;
  }
  return v;
}

// ── The speaking waveform ────────────────────────────────────────────────────
// Deterministic in the frame index — no clock, no randomness — so a test can
// assert frame 3 exactly. Two superimposed waves give it an organic wobble.

const BARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇'];

/** One waveform string of `width` bars for animation frame `frame`. */
export function waveform(frame, width = 24) {
  let out = '';
  for (let i = 0; i < width; i++) {
    const a = Math.sin((i + frame) * 0.9) + Math.sin((i * 0.5 - frame) * 0.6);
    const idx = Math.round(((a + 2) / 4) * (BARS.length - 1));
    out += BARS[Math.max(0, Math.min(BARS.length - 1, idx))];
  }
  return out;
}

// ── Rendering ────────────────────────────────────────────────────────────────

function scoreStr(ev) {
  if (ev.score == null) return '';
  const col = ev.verified ? C.green : C.red;
  const bar = ev.threshold != null ? gr(`/${ev.threshold}`) : '';
  return `${col}${Number(ev.score).toFixed(2)}${C.reset}${bar} `;
}

function clockStr(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return gr(`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`);
}

/** One activity line. Exported for tests. */
export function voiceEventLine(ev, width) {
  let icon, body;
  switch (ev.phase) {
    case 'heard':
      icon = `${C.green}✓${C.reset}`;
      body = `you: ${ev.text || ''}`;
      break;
    case 'answer':
      icon = `${C.cyan}♪${C.reset}`;
      body = `kairos: ${ev.text || ''}`;
      break;
    case 'ignored':
      if (ev.reason === 'unrecognized voice') {
        icon = `${C.red}✗${C.reset}`;
        body = `stranger — score below the gate`;
      } else if (ev.reason === 'no wake word') {
        icon = `${C.yellow}○${C.reset}`;
        body = `no wake word: "${ev.text || ''}"`;
      } else {
        icon = gr('·');
        body = ev.reason || 'nothing heard';
      }
      break;
    default:
      icon = gr('·');
      body = `${ev.phase}${ev.text ? `: ${ev.text}` : ''}`;
  }
  const t = ev.timing?.totalMs != null ? ` ${gr(`[${(ev.timing.totalMs / 1000).toFixed(1)}s]`)}` : '';
  const line = `${clockStr(ev.ts)}  ${icon} ${scoreStr(ev)}${body}`;
  // Clip to width, keeping the timing tag if there is room for it.
  return visLen(line) + visLen(t) <= width ? line + t : line.slice(0, Math.max(0, width * 2));
}

function pipelineLines(p) {
  if (!p) return [gr('probing the voice pipeline…')];
  const part = (label, ok, detail) =>
    `${ok ? C.green + '●' : C.red + '○'}${C.reset} ${label}${detail ? gr(` ${detail}`) : ''}`;
  // Two rows, model on its own: it is the fact the owner most wants, and a
  // one-row layout clipped it first on a 100-column terminal.
  return [
    [
      part('mic', p.recorder, p.recorderName),
      part('stt', p.whisper, p.whisperModel),
      part('speaker', p.speaker, p.voiceprint ? `enrolled ${p.threshold ?? ''}` : p.speaker ? 'no print' : ''),
      part('tts', p.tts, p.ttsName),
    ].join(gr('  ·  ')),
    part('model', p.model != null, p.model || 'none — kairos llm add'),
  ];
}

function brainLine(b) {
  if (!b) return '';
  const pct = (n) => `${Math.round((n ?? 0) * 100)}%`;
  return `${gr('brain:')} arousal ${C.cyan}${pct(b.arousal)}${C.reset}  load ${pct(b.load)}  confidence ${pct(b.confidence)}`;
}

/**
 * Render the Voice view.
 * @param {number} W terminal width
 * @param {number} H rows available
 * @returns {string[]}
 */
export function renderVoice(W, H) {
  const v = state.voice;
  const lines = [];
  const row = (content = '') => lines.push(boxRow('  ' + content, W));
  const iW = W - 6;

  lines.push(boxTop(W, 'VOICE'));
  row();

  // ── Status ────────────────────────────────────────────────────
  if (v.speaking) {
    if (reducedMotion()) {
      row(`${C.cyan}${bold('♪ speaking')}${C.reset}  ${gr(clip(v.speakingText, iW - 14))}`);
    } else {
      const wave = waveform(v.animFrame ?? 0, Math.min(28, Math.max(8, iW - 14)));
      row(`${C.cyan}${wave}${C.reset}  ${bold('speaking')}`);
      row(gr(`  ${clip(v.speakingText, iW - 4)}`));
    }
  } else {
    row(`${C.green}●${C.reset} ${bold('listening')}  ${gr('say the wake word, then talk')}`);
  }
  row();

  // ── Pipeline ──────────────────────────────────────────────────
  for (const l of pipelineLines(v.pipeline)) row(l);
  const brain = brainLine(v.brain);
  if (brain) row(brain);
  row();

  // ── Activity ──────────────────────────────────────────────────
  row(gr(`─ ACTIVITY ${'─'.repeat(Math.max(0, iW - 11))}`));
  const used = lines.length + 2; // + boxBot + one spare
  const roomFor = Math.max(1, H - used);
  if (!v.events.length) {
    row(gr('nothing heard yet — the voice loop reports here as it runs'));
    row(gr(`start it with:  kairos voice listen`));
  } else {
    for (const ev of v.events.slice(0, roomFor)) row(voiceEventLine(ev, iW));
  }

  while (lines.length < H - 1) row();
  lines.push(boxBot(W));
  return lines.slice(0, H);
}

function clip(s, n) {
  const str = String(s || '');
  return str.length <= n ? str : str.slice(0, Math.max(0, n - 1)) + '…';
}

// ── Pipeline probe ───────────────────────────────────────────────────────────
// Local checks against the same discovery functions the voice CLI itself uses,
// so this view can never disagree with `kairos voice check`. Runs when the view
// opens; spawning ffmpeg per render would be absurd.

export async function probeVoicePipeline() {
  const out = {
    recorder: false, recorderName: '',
    whisper: false, whisperModel: '',
    speaker: false, voiceprint: false, threshold: null,
    tts: false, ttsName: '',
    model: null,
  };
  try {
    const { detectRecorder } = await import('../../../../src/voice/capture.js');
    const { backend } = await detectRecorder();
    out.recorder = !!backend;
    out.recorderName = backend?.command || '';
  } catch { /* absent is already the default */ }
  try {
    const { findWhisper } = await import('../../../../src/voice/transcribe.js');
    const w = findWhisper();
    out.whisper = !!w;
    out.whisperModel = w?.model ? w.model.replace(/^.*[\\/]/, '') : '';
  } catch { /* absent */ }
  try {
    const { findSpeakerEngine, loadVoiceprint } = await import('../../../../src/voice/verify.js');
    out.speaker = !!findSpeakerEngine();
    const print = loadVoiceprint();
    out.voiceprint = !!print;
    out.threshold = print?.threshold ?? null;
  } catch { /* absent */ }
  try {
    const { probeSystemTts } = await import('../../../../src/voice/tts.js');
    const p = await probeSystemTts();
    out.tts = !!p.ok;
    out.ttsName = p.ok ? p.command : '';
  } catch { /* absent */ }
  try {
    const { loadModels } = await import('../../../../src/kernel/models.js');
    const reg = loadModels();
    out.model = reg.active ? `${reg.active} (${reg.models[reg.active]?.model ?? '?'})` : null;
  } catch { /* absent */ }
  return out;
}
