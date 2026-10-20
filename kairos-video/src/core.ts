// Scene data model + deterministic timing. Every duration is computed from
// content length here, so Root.tsx and Scene.tsx can never disagree.

export type TermLine = {
  t: 'cmd' | 'out' | 'ok' | 'warn' | 'dim';
  s: string;
};

export type SceneData = {
  id: string;
  kicker: string; // small category label, e.g. "SECURITY"
  title: string; // scene headline
  bubbles: string[]; // the Kairos chatbot's narration, typed live
  term: TermLine[]; // the terminal demo, typed live
};

export const FPS = 30;

const NARR_START = 16;
const NARR_CPF = 2.6; // narration chars per frame
const BUBBLE_GAP = 14;
const TERM_START = 26;
const CMD_CPF = 1.7; // command chars typed per frame
const CMD_PAUSE = 12; // beat after a command before its output
const OUT_FPL = 4; // frames per output line
const HOLD = 84; // reading time at the end of a scene

export type Span = { start: number; end: number };

export function bubbleSpans(bubbles: string[]): Span[] {
  const spans: Span[] = [];
  let t = NARR_START;
  for (const b of bubbles) {
    const end = t + Math.ceil(b.length / NARR_CPF);
    spans.push({ start: t, end });
    t = end + BUBBLE_GAP;
  }
  return spans;
}

export function termSpans(term: TermLine[]): Span[] {
  const spans: Span[] = [];
  let t = TERM_START;
  for (const line of term) {
    if (line.t === 'cmd') {
      const end = t + Math.ceil(line.s.length / CMD_CPF);
      spans.push({ start: t, end });
      t = end + CMD_PAUSE;
    } else {
      spans.push({ start: t, end: t + OUT_FPL });
      t += OUT_FPL;
    }
  }
  return spans;
}

export function sceneDuration(s: SceneData): number {
  const b = bubbleSpans(s.bubbles);
  const tm = termSpans(s.term);
  const lastB = b.length ? b[b.length - 1].end : 0;
  const lastT = tm.length ? tm[tm.length - 1].end : 0;
  return Math.max(lastB, lastT) + HOLD;
}
