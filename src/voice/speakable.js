// src/voice/speakable.js
// Rendering for the ear (8.3).
//
// Text written for a screen is nearly unlistenable. Markdown becomes "asterisk
// asterisk important asterisk asterisk", a file path becomes a stream of
// slashes, and a code block becomes ninety seconds of punctuation. Reading the
// screen output aloud is the single easiest way to make a voice interface feel
// broken, and it is what happens by default.
//
// So a spoken variant is produced deliberately, and it is *shorter* rather than
// merely different. Someone listening cannot skim; they cannot re-read a
// sentence they missed. Length costs far more in the ear than on a screen.
//
// The other half of 8.3: mission progress is spoken at **milestones only**. A
// mission emits hundreds of step events, and narrating them is the difference
// between a colleague who says "done, tests pass" and one who reads their
// keystrokes aloud.

/** Roughly how many characters of speech fit in a comfortable answer. */
export const SPEAKABLE_LIMIT = 420;

/** Mission actions worth saying out loud. Everything else stays visual. */
const SPOKEN_MISSION_ACTIONS = Object.freeze(['running', 'ended', 'blocked']);

/**
 * Convert display text to something worth hearing.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @returns {string}
 */
export function toSpeakable(text, { limit = SPEAKABLE_LIMIT } = {}) {
  let s = String(text || '');
  if (!s.trim()) return '';

  // Code blocks are never speakable. Say that one exists and move on — a
  // listener who wants the code will look at the screen.
  s = s.replace(/```[\s\S]*?```/g, ' (there is a code block on screen) ');
  s = s.replace(/`([^`]+)`/g, '$1');

  // Markdown emphasis and headings: strip the marks, keep the words.
  s = s.replace(/^#{1,6}\s+/gm, '');
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  // Trailing punctuation must be allowed after the closing mark. Requiring
  // whitespace left the underscores in `_urgent_.` — which is by far the more
  // common shape, since emphasis usually ends a clause.
  s = s.replace(/(^|\s)[*_]([^*_\n]+)[*_](?=[\s.,;:!?)]|$)/g, '$1$2');
  s = s.replace(/~~([^~]+)~~/g, '$1');

  // Links: the text is the content, the URL is noise in the ear.
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // Bullets and numbered lists become spoken clauses rather than symbols.
  s = s.replace(/^\s*[-*+]\s+/gm, '');
  s = s.replace(/^\s*\d+[.)]\s+/gm, '');

  // URLs BEFORE paths. A URL is made of slash-separated segments, so the path
  // rule below would collapse it to its last segment first and leave nothing
  // for this rule to recognise.
  s = s.replace(/https?:\/\/\S+/g, 'a link');

  // Paths and identifiers: a listener needs the last part, not the tree.
  s = s.replace(/(?:[A-Za-z]:)?(?:[\\/][\w.-]+){2,}/g, (m) => {
    const parts = m.split(/[\\/]/).filter(Boolean);
    return parts.length > 1 ? `${parts[parts.length - 1]}` : m;
  });

  // Table rows are hopeless spoken; say so rather than reciting pipes.
  if (/^\s*\|.*\|\s*$/m.test(s)) {
    s = s.replace(/(?:^\s*\|.*\|\s*$\n?)+/gm, ' (there is a table on screen) ');
  }

  s = s.replace(/\s*\n\s*\n\s*/g, '. ').replace(/\s*\n\s*/g, ' ');
  s = s.replace(/\s{2,}/g, ' ').replace(/\.\s*\./g, '.').trim();

  return truncateAtSentence(s, limit);
}

/**
 * Cut at a sentence boundary, never mid-word.
 *
 * A spoken answer that stops mid-sentence sounds like a crash. Better to end
 * early and cleanly, and say that there is more.
 */
export function truncateAtSentence(text, limit) {
  if (text.length <= limit) return text;
  const window = text.slice(0, limit);
  const lastStop = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '));
  if (lastStop > limit * 0.5) return `${window.slice(0, lastStop + 1)} There's more on screen.`;
  const lastSpace = window.lastIndexOf(' ');
  return `${window.slice(0, lastSpace > 0 ? lastSpace : limit)}… There's more on screen.`;
}

/**
 * Should this mission event be spoken?
 *
 * Steps are never spoken. This is the rule that decides whether the system
 * sounds like a colleague or like someone reading their keystrokes aloud.
 */
export function shouldSpeakMissionEvent(payload = {}) {
  return SPOKEN_MISSION_ACTIONS.includes(payload.action);
}

/**
 * A spoken sentence for a mission milestone, or '' for anything not worth
 * interrupting a room over.
 */
export function speakMissionEvent(payload = {}) {
  if (!shouldSpeakMissionEvent(payload)) return '';
  const title = shorten(payload.title || payload.missionId || 'the job', 60);

  switch (payload.action) {
    case 'running':
      return `Starting: ${title}.`;
    case 'blocked':
      return `${title} is waiting — ${shorten(payload.blockedReason || 'blocked', 80)}.`;
    case 'ended': {
      const reason = payload.exitReason || payload.state;
      if (reason === 'completed') return `Finished: ${title}.`;
      if (reason === 'max_steps') return `${title} ran out of steps before finishing.`;
      if (reason === 'repair_stalled') return `${title} got stuck and stopped.`;
      if (reason === 'interrupted') return `${title} was interrupted. It can pick up where it left off.`;
      return `${title} stopped: ${shorten(String(reason || 'unknown'), 40)}.`;
    }
    default:
      return '';
  }
}

/**
 * Phrase an approval request for speech.
 *
 * Kept explicit and unhurried: this is the one thing where being misheard has
 * consequences, so the tool and the risk are both said plainly, and the tier is
 * translated into English rather than spoken as "T3".
 */
export function speakApproval({ tool, tier, reason } = {}) {
  const gravity = tier === 'T3'
    ? 'This cannot be undone.'
    : 'This affects something outside this machine.';
  return `Permission needed: ${humanizeTool(tool)}. ${gravity} ${shorten(reason || '', 100)} Say approve or deny.`;
}

function humanizeTool(tool) {
  return String(tool || 'an action')
    .replace(/__/g, ' ')
    .replace(/_/g, ' ')
    .trim();
}

function shorten(text, n) {
  const s = String(text || '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
