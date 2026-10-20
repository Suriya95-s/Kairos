// src/router/classify.js
// The cognition router (4.1): what kind of thing did the user just say?
//
// Every utterance arriving at the daemon — typed, spoken, or piped — lands here
// first. The answer decides whether it gets a two-second answer or a twenty-
// minute mission, and getting that wrong in either direction is the difference
// between a colleague and a tool: spawn a mission for "what time is it" and it
// is exhausting; answer "build me a REST API" with a paragraph and it is
// useless.
//
// Keyword fast-path first, exactly like the existing routing/router.js one
// level down. Most utterances are unambiguous, and a local model round-trip to
// classify "thanks" is latency spent for nothing. The LLM is the fallback for
// the genuinely ambiguous middle, and it is optional — with no model reachable
// the router still works, just with more `clarify`.
//
// Every decision is logged. That log is the training set for C9 (the router
// that learns from its own corrections), and it is the only way to know whether
// accuracy is drifting.

import fs from 'node:fs';
import path from 'node:path';

import { selectProfile } from '../missions/profiles.js';

/**
 * What the user wants.
 *
 * The first four are the D-plan set. `control` is an addition: "stop that
 * mission" is not a mission, not a question, and not ambiguous — routing it
 * as anything else would mean the only way to stop work is to find its id.
 */
export const INTENTS = Object.freeze(['reflex', 'tool_call', 'mission', 'clarify', 'control']);

/** Confidence below this goes to the LLM (when one is available). */
export const LLM_THRESHOLD = 0.34;

// ── Control ─────────────────────────────────────────────────────────────────
// Matched before anything else and with explicit phrases only. A greedy "stop"
// rule would eat "stop the server from crashing", which is a mission.

const CONTROL_PATTERNS = [
  { re: /^(stop|halt|abort|cancel|kill)\b.{0,24}\b(that|this|it|the|current|running|my)?\s*(mission|task|job|run|work|agent)?\s*$/i, action: 'stop' },
  { re: /^(stop|cancel|abort)\s+(m-[a-z0-9]+)\b/i,                     action: 'stop' },
  { re: /^(pause|hold on|wait)\b.{0,20}$/i,                            action: 'pause' },
  { re: /^(resume|continue|carry on|keep going|go on)\b.{0,20}$/i,      action: 'resume' },
  { re: /^(never ?mind|forget it|scrap that|belay that)\b.{0,20}$/i,    action: 'stop' },
  { re: /^(status|what('?s| is) (the )?status|how('?s| is) it going|what are you (doing|working on))\b.{0,30}$/i, action: 'status' },
  { re: /^(list|show)\s+(my\s+)?(missions|jobs|tasks|runs)\s*$/i,       action: 'status' },
];

// ── Weighted signals ────────────────────────────────────────────────────────
// [pattern, weight]. Multi-word phrases outweigh single words, because a bare
// "build" appears as a noun ("the build is slow") far more often than the
// phrase "build a" does.

const MISSION_SIGNALS = compile([
  ['build a', 5], ['build me', 5], ['create a', 5], ['write a', 4], ['implement', 5],
  ['refactor', 5], ['migrate', 5], ['set up', 4], ['scaffold', 5], ['bootstrap', 4],
  ['add a', 4], ['add support', 4], ['add tests', 4], ['fix the bug', 5], ['fix all', 4],
  // "fix the bug" was covered but "fix the failing test" was not, and a bare
  // "add X" (error handling, logging, a guard) matched nothing. Low weight on
  // 'add ' so the specific forms above and the calendar errands still win.
  ['fix the', 3], ['fix ', 2], ['add ', 2],
  // `['optimi', 3]` used to live here and could never match anything:
  // compile() adds \b at both ends when the pattern starts and ends
  // alphanumeric, so it looked for the whole word "optimi". A prefix cannot be
  // written as a bare signal — it has to be spelled out.
  ['make it', 3], ['make a', 4], ['port ', 3], ['rewrite', 5],
  ['optimize', 3], ['optimise', 3],
  ['clean up', 3], ['deploy', 4], ['integrate', 4], ['generate a', 4],
  ['rename', 4], ['update the', 3],
  ['and then', 2], ['step by step', 2], ['end to end', 2], ['from scratch', 3],
  ['in ~/', 3], ['in ./', 3], ['repository', 2], ['codebase', 2], ['the project', 2],
  ['all the files', 3], ['every file', 3], ['test suite', 2], ['pull request', 3],
  // Surfaced by the fixture set: "stop the server from crashing" reads as a
  // control phrase to a naive matcher, but it is a debugging job.
  ['crashing', 3], ['crashes', 3], ['from crashing', 4], ['on startup', 2],
  ['so it handles', 3], ['broken on', 3],
]);

const RESEARCH_SIGNALS = compile([
  ['summarize', 4], ['summarise', 4], ['compare', 4], ['research', 5],
  ['investigate', 4], ['analyze', 3], ['analyse', 3], ['review the', 4],
  ['write up', 4], ['report on', 4], ['find out', 3], ['look into', 4],
  ['pros and cons', 4], ['trade-off', 3], ['tradeoff', 3], ['evaluate', 3],
  ['audit', 4], ['document', 3],
  ['figure out', 4], ['work out why', 4], ['get to the bottom of', 4],
  ['tell me where', 3], ['find the pattern', 3],
]);

const ERRAND_SIGNALS = compile([
  ['remind me', 5], ['schedule', 4], ['book ', 4], ['email ', 4], ['send ', 3],
  ['add to my calendar', 5], ['put on my calendar', 5], ['message ', 3],
  ['order ', 3], ['cancel my', 4], ['reschedule', 4], ['text ', 3],
  ['set a timer', 5], ['set an alarm', 5], ['notify', 3],
  // "add the sprint review to my calendar" — the object sits between the verb
  // and the destination, so the destination has to score on its own.
  ['calendar', 4], ['my inbox', 3], ['invite', 3],
]);

const REFLEX_SIGNALS = compile([
  ['what is', 4], ['what are', 4], ['what does', 4], ['what happens', 4],
  ['why is', 4], ['why does', 4], ['why did', 4], ['how do i', 4], ['how does', 4],
  ['how can i', 4], ['when should', 3], ['which is', 3], ['who ', 2],
  ['explain', 5], ['tell me about', 5], ['what do you think', 5], ['do you know', 4],
  ['remind me what', 5], ['remind me how', 5], ['is it', 3], ['are there', 3],
  ['should i', 4], ['can you explain', 5], ['difference between', 4],
  ['thanks', 5], ['thank you', 5], ['hello', 5], ['hi ', 3], ['hey', 4],
  ['good morning', 5], ['nice work', 4], ['cool', 3], ['nevermind', 3],
  ['yes', 3], ['no ', 2], ['ok', 3], ['okay', 3], ['sounds good', 4],
  // Yes/no questions about live state. `is it` was here; `is the` — which is
  // how people actually phrase it about a named thing — was not, so "is the
  // build passing" matched nothing at all.
  ['is the', 3], ['are the', 3], ['has the', 3], ['was the', 3], ['do we have', 3],
  // Acknowledgements, alongside the ones already here ('nice work', 'cool').
  ['that worked', 4], ['perfect', 4],
]);

const TOOL_CALL_SIGNALS = compile([
  ['show me the', 4], ['show the', 4], ['list the', 4], ['list all', 4],
  ['open ', 3], ['cat ', 4], ['print the', 3], ['display the', 3],
  ['read the file', 5], ['what\'s in', 4], ['whats in', 4],
  ['tail the', 4], ['grep', 4], ['search for', 3], ['find the file', 4],
  ['how many', 3], ['when did', 3], ['last commit', 4], ['git status', 5],
  ['run the test', 4], ['run the', 3], ['show me', 3],
  // "check X" means "go and look at X", which is a tool call, not a question
  // answerable from memory. Absent until a real spoken utterance found it:
  // every phrasing of "check the build status" scored zero on every intent and
  // fell through to clarify — the router asking "what do you mean?" in reply to
  // an ordinary instruction. The 105-case fixture set was at 100% and simply
  // never contained the word, which is the limit of a fixture set written by
  // the same person who wrote the classifier.
  ['check the', 3], ['check my', 3], ['check if', 3], ['check whether', 3],
  ['check on', 3], ['check for', 3], ['check ', 2],
  // The rest of the same class, found by auditing a corpus of realistic
  // utterances for the 0.15 "nothing matched" fingerprint rather than waiting
  // for them to turn up one spoken sentence at a time. All of these mean "go
  // and look" or "run this one thing", which is a tool call.
  ['look at the', 3], ['look up', 3], ['inspect', 3], ['see if', 3],
  ['verify', 3], ['validate', 3], ['diff ', 3], ['count the', 3], ['test the', 3],
  ['restart', 3], ['install the', 3], ['delete the', 3], ['commit ', 3],
  ['push to', 3], ['revert', 3],
]);

/** Utterances that name no object at all, or refer to a context we don't have. */
const VAGUE_PATTERNS = [
  /^(fix|do|try|handle|sort|deal with)\s+(it|that|this|those|them|again)\b/i,
  /^(the|that|this)\s+(usual|same|other one|thing)\b/i,
  /^(you know|the thing|whatever|something)\b/i,
  /^(again|more|another one|redo)\s*$/i,
  /^(it|that|this|they)\s+(doesn'?t|does not|isn'?t|is not|won'?t)\s+work\b/i,
];

const URGENT_PATTERNS = /\b(now|asap|urgent|immediately|right away|quickly|hurry)\b/i;
const RELAXED_PATTERNS = /\b(when you can|whenever|no rush|later|sometime|eventually|at some point)\b/i;

const POLITENESS = /^\s*(please|could you|can you|would you|hey|ok|okay|so|um|well|now)[,\s]+/i;

/** Wh-words are interrogative wherever they lead a sentence. */
const WH_LEAD = /^(what|why|how|when|who|whom|whose|which|where)\b/i;

/**
 * Auxiliaries are only interrogative when a subject follows them.
 *
 * Treating a leading auxiliary as a question on its own is wrong in a way that
 * matters: "do something" is an imperative, and reading it as a question sent
 * it to the reflex — which then spent six seconds discovering the model was
 * down, to answer something the user had asked it to *do*.
 */
// An auxiliary followed by a SUBJECT PRONOUN is unambiguously interrogative:
// there is no imperative reading of "do you know" or "is it ready".
const AUX_PRONOUN = /^(is|are|was|were|do|does|did|can|could|should|would|will|have|has|am)\s+(i|you|we|they|he|she|it|there)\b/i;

// An auxiliary followed by a DETERMINER is ambiguous — "do the tests pass?" is
// a question, "do the migration" is an order — so it only counts as a question
// when a question mark says so.
const AUX_DETERMINER = /^(is|are|was|were|do|does|did|can|could|should|would|will|have|has)\s+(this|that|these|those|my|our|your|the|a|an)\b/i;

function detectQuestion(raw, leadText) {
  if (String(raw).trim().endsWith('?')) return true;
  if (WH_LEAD.test(leadText)) return true;
  if (AUX_PRONOUN.test(leadText)) return true;
  // AUX_DETERMINER deliberately requires the question mark, which the check
  // above already handled — so reaching here means it is an imperative.
  return false;
}

/** Strip leading politeness so the imperative verb lands at position 0. */
function lead(text) {
  let out = String(text || '').trim();
  // Twice: "hey can you build X" has two layers.
  for (let i = 0; i < 2; i++) out = out.replace(POLITENESS, '').trim();
  return out;
}

/**
 * Compile a signal pattern to a word-boundary regex.
 *
 * Plain substring matching is wrong here and fails silently: `'ok'` matches
 * inside "broken", `'hi '` inside "this ", `'no '` inside "node ". A boundary
 * is added only where the pattern actually starts/ends with a word character,
 * so patterns that deliberately carry punctuation or a trailing space
 * ("in ~/", "node ", "what's in") keep working.
 */
function compileSignal([pattern, weight]) {
  const esc = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pre = /^[a-z0-9]/i.test(pattern) ? '\\b' : '';
  const post = /[a-z0-9]$/i.test(pattern) ? '\\b' : '';
  return {
    pattern,
    weight,
    re: new RegExp(pre + esc + post, 'i'),
    leadRe: new RegExp('^' + esc + post, 'i'),
  };
}

// A function declaration, not a const arrow: the signal tables are built at
// module top-level ABOVE this point, and a const would be in its temporal dead
// zone when they run. `node --check` does not catch that — only importing does.
function compile(table) { return table.map(compileSignal); }

function scoreSignals(text, leadText, signals) {
  let score = 0;
  const hits = [];
  for (const { re, leadRe, weight, pattern } of signals) {
    if (!re.test(text)) continue;
    // A signal at position 0 is the utterance's actual verb, not an incidental
    // mention. "build a REST API" vs "the build a colleague set up is slow".
    const bonus = leadRe.test(leadText) ? 3 : 0;
    score += weight + bonus;
    hits.push(pattern);
  }
  return { score, hits };
}

/**
 * Classify an utterance.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {boolean} [opts.missionRunning] a mission is active in this session —
 *        changes what a bare follow-up most likely means (4.4)
 * @param {boolean} [opts.hasWorkspace]   a workspace is known; without one a
 *        mission cannot start and "clarify" is the honest answer
 * @returns {object} decision
 */
export function classify(text, { missionRunning = false, hasWorkspace = true } = {}) {
  const raw = String(text || '').trim();
  if (!raw) {
    return decision('clarify', { confidence: 1, method: 'rule', reason: 'empty utterance' });
  }

  const lower = raw.toLowerCase();
  const leadText = lead(lower);
  const words = leadText.split(/\s+/).filter(Boolean);
  const isQuestion = detectQuestion(raw, leadText);

  // ── 1. Control, first and on explicit phrases only ──────────────────
  for (const { re, action } of CONTROL_PATTERNS) {
    const m = re.exec(leadText);
    if (!m) continue;
    const target = /\bm-[a-z0-9]+\b/i.exec(leadText)?.[0] ?? null;
    return decision('control', {
      confidence: 0.95,
      method: 'rule',
      reason: `control phrase "${m[0].trim()}"`,
      urgency: 'now',
      control: { action, target },
    });
  }

  // ── 2. Vague reference → clarify ────────────────────────────────────
  for (const re of VAGUE_PATTERNS) {
    if (!re.test(leadText)) continue;
    // Mid-mission, "it" has an obvious referent: the running mission. That is
    // steering, not an unanswerable question.
    if (missionRunning) {
      return decision('control', {
        confidence: 0.6,
        method: 'rule',
        reason: 'vague reference while a mission is running — treat as steering',
        urgency: 'now',
        control: { action: 'steer', target: null },
      });
    }
    return decision('clarify', {
      confidence: 0.75,
      method: 'rule',
      reason: 'refers to something with no antecedent',
    });
  }

  // ── 3. Weighted scoring ─────────────────────────────────────────────
  const mission  = scoreSignals(lower, leadText, MISSION_SIGNALS);
  const research = scoreSignals(lower, leadText, RESEARCH_SIGNALS);
  const errand   = scoreSignals(lower, leadText, ERRAND_SIGNALS);
  const reflex   = scoreSignals(lower, leadText, REFLEX_SIGNALS);
  const toolCall = scoreSignals(lower, leadText, TOOL_CALL_SIGNALS);

  // "remind me WHAT the profiles are" is recall, not an errand — the
  // interrogative turns the request verb into a question. Same for "tell me".
  const recallNotErrand = /^(remind|tell)\s+me\s+(what|how|when|why|who|which|where)\b/i.test(leadText);

  const scores = {
    mission:   (recallNotErrand ? 0 : errand.score) + mission.score + research.score,
    reflex:    reflex.score,
    tool_call: toolCall.score,
    clarify:   0,
  };

  // Whether ANY signal fired, tracked before the adjustments below. Deriving
  // "nothing matched" from the adjusted total is wrong: the short-utterance
  // penalty moves it off zero, so an unrecognised fragment would fall through
  // to whichever intent sorts first rather than being flagged unclear.
  const anySignal = mission.hits.length + research.hits.length + errand.hits.length
    + reflex.hits.length + toolCall.hits.length > 0;

  // A question is a question even when it contains build vocabulary. "How do I
  // build a REST API" wants an answer; "build a REST API" wants a REST API.
  if (isQuestion) {
    scores.reflex += 6;
    scores.mission = Math.max(0, scores.mission - 4);
  }

  // Length is real signal in both directions: nobody types 25 words to ask the
  // time, and nobody describes a refactor in three.
  if (words.length >= 12) scores.mission += 2;
  if (words.length >= 20) scores.mission += 2;
  if (words.length <= 4 && !isQuestion) scores.mission -= 2;

  // Nothing recognised. Default to asking rather than guessing: a wrong reflex
  // burns a model call on something we did not understand, and a wrong mission
  // burns twenty minutes.
  if (!anySignal && !isQuestion) {
    // Longer unmatched text is far more likely a real request phrased unusually
    // than a fragment, so it leans toward work while still staying beatable.
    scores.clarify = words.length <= 6 ? 6 : 3;
    if (words.length > 6) scores.mission += 4;
  }

  // Without a workspace a mission literally cannot start, so this is not a
  // nudge — clarify has to win outright. Starting work in the wrong directory
  // is far worse than one extra question.
  if (!hasWorkspace && scores.mission > 0) {
    scores.clarify = scores.mission + 2;
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [topIntent, topScore] = ranked[0];
  const runnerUp = ranked[1][1];

  // Confidence is the margin, not the magnitude: two strong-but-tied signals
  // mean genuine ambiguity, which is exactly when the LLM is worth its latency.
  //
  // Except when the decision came from the no-signal fallback. That clarify
  // score is invented, so its margin is enormous and would read as *certainty*
  // that the utterance is unclear — the opposite of the truth, and it would
  // suppress the LLM escalation on precisely the inputs that need it most.
  const margin = topScore <= 0 ? 0 : Math.min(1, (topScore - runnerUp) / Math.max(topScore, 1));
  const confidence = (!anySignal && topIntent === 'clarify') ? 0.15 : margin;

  const profile = topIntent === 'mission'
    ? selectProfile(raw, {}).name
    : null;

  return decision(topIntent, {
    confidence: Number(confidence.toFixed(3)),
    method: 'keyword',
    reason: describe({ mission, research, errand, reflex, toolCall, isQuestion, words: words.length }),
    urgency: urgencyOf(raw, topIntent),
    profile,
    scores,
  });
}

function urgencyOf(raw, intent) {
  if (URGENT_PATTERNS.test(raw)) return 'now';
  if (RELAXED_PATTERNS.test(raw)) return 'whenever';
  // The user is present and waiting for a conversational answer; a mission is
  // background work by nature.
  if (intent === 'reflex' || intent === 'tool_call' || intent === 'clarify') return 'now';
  return 'soon';
}

function describe({ mission, research, errand, reflex, toolCall, isQuestion, words }) {
  const parts = [];
  if (isQuestion) parts.push('phrased as a question');
  for (const [name, r] of [['mission', mission], ['research', research], ['errand', errand], ['reflex', reflex], ['tool', toolCall]]) {
    if (r.hits.length) parts.push(`${name}:${r.hits.slice(0, 3).join('/')}`);
  }
  parts.push(`${words}w`);
  return parts.join(' ');
}

function decision(intent, extra = {}) {
  return {
    intent,
    profile: null,
    urgency: 'now',
    confidence: 0,
    method: 'rule',
    reason: '',
    control: null,
    scores: null,
    ...extra,
  };
}

// ── LLM fallback ────────────────────────────────────────────────────────────

const LLM_PROMPT = `You classify a single user utterance for an assistant that can either answer immediately or start a long-running autonomous job.

Reply with ONE word, nothing else:
  reflex    - a question, chat, or anything answerable in a sentence or two
  tool_call - a direct request to look something up or show something, one action
  mission   - work that takes many steps: building, refactoring, researching, errands
  clarify   - too vague or underspecified to act on
  control   - stopping, pausing, resuming, or asking the status of existing work

Utterance: `;

/**
 * Classify, escalating to a small LLM when the keyword pass is unsure.
 *
 * The LLM only ever *replaces the intent*; profile and urgency stay with the
 * deterministic pass, because those are cheap to get right by rule and there is
 * no reason to pay for a second opinion on them.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {function} [opts.llm] async (prompt) => string — injectable for tests
 */
export async function classifyWithLlm(text, opts = {}) {
  const first = classify(text, opts);
  if (first.confidence >= LLM_THRESHOLD || first.method === 'rule') return first;

  const llm = opts.llm || defaultLlmClassifier;
  const timeoutMs = opts.timeoutMs ?? LLM_CLASSIFY_TIMEOUT_MS;
  try {
    // The bound belongs to the router, not to one implementation: classification
    // sits in the path of EVERY utterance, and a caller who injects their own
    // model must not be able to make the whole system hang.
    const raw = await withTimeout(llm(LLM_PROMPT + JSON.stringify(String(text))), timeoutMs);
    const answer = String(raw).trim().toLowerCase();
    const picked = INTENTS.find(i => answer.startsWith(i) || answer.includes(i));
    if (!picked) return first;
    return {
      ...first,
      intent: picked,
      method: 'llm',
      reason: `${first.reason} → llm:${picked}`,
      // The deterministic pass was unsure; the LLM is a tiebreak, not an oracle.
      confidence: 0.6,
      profile: picked === 'mission' ? (first.profile || selectProfile(text, {}).name) : null,
      urgency: urgencyOf(text, picked),
    };
  } catch {
    // No model reachable (S3 degraded). The keyword answer stands — a router
    // that stops working when the endpoint is down is worse than one that is
    // occasionally unsure.
    return { ...first, reason: `${first.reason} (llm unavailable)` };
  }
}

/** Hard ceiling on a classification round-trip, whoever provides the model. */
export const LLM_CLASSIFY_TIMEOUT_MS = 1_500;

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('classifier timed out')), ms);
      if (typeof timer.unref === 'function') timer.unref();
    }),
  ]);
}

async function defaultLlmClassifier(prompt) {
  // `chatCompletion` — llm.js has never exported `callLLM`. The first version
  // of this called that name, threw a TypeError, and was silently swallowed by
  // the catch in classifyWithLlm: the fallback appeared to work and never once
  // consulted a model. Silent degradation, caught only by measuring latency.
  const { chatCompletion } = await import('../llm.js');
  const { default: config } = await import('../config.js');

  // The timeout lives in classifyWithLlm so it covers every model, injected or
  // not. Here we only pick the cheapest one (D7) — classification is the
  // smallest job in the system and must not compete for the strong model.
  const res = await chatCompletion([{ role: 'user', content: prompt }], {
    model: config.cheapModel || config.model,
    maxOutputTokens: 8,
    temperature: 0,
    purpose: 'router.classify',
  });
  return typeof res === 'string' ? res : (res?.content ?? '');
}

// ── Decision log (C9) ───────────────────────────────────────────────────────

/**
 * Append a routing decision to the training log.
 *
 * Every decision, not just the wrong ones: an accuracy claim needs the
 * denominator. `corrected` is filled in later when a user overrides the route,
 * which is what turns this file into supervised data.
 */
export function logDecision(decision, { text, sessionId = null, dir = null, corrected = null } = {}) {
  try {
    const target = dir || defaultLogDir();
    fs.mkdirSync(target, { recursive: true });
    const record = {
      ts: Date.now(),
      sessionId,
      // Truncated: the log is training data, not a transcript, and full
      // utterances make it a second place secrets can land.
      text: String(text || '').slice(0, 500),
      intent: decision.intent,
      profile: decision.profile,
      urgency: decision.urgency,
      confidence: decision.confidence,
      method: decision.method,
      reason: decision.reason,
      corrected,
    };
    fs.appendFileSync(path.join(target, 'decisions.jsonl'), JSON.stringify(record) + '\n');
    return record;
  } catch {
    // Never let the training log break the thing it is observing.
    return null;
  }
}

function defaultLogDir() {
  const override = process.env.KAIROS_HOME;
  const brand = (process.env.KAIROS_BRAND || 'kairos').trim().toLowerCase();
  const home = override && override.trim()
    ? path.resolve(override.trim())
    : path.join(process.env.HOME || process.env.USERPROFILE || '.', `.${brand}`);
  return path.join(home, 'router');
}

/** Read decisions back — the input to measuring drift and to C9 training. */
export function readDecisions({ dir = null, limit = null } = {}) {
  const target = path.join(dir || defaultLogDir(), 'decisions.jsonl');
  let text;
  try { text = fs.readFileSync(target, 'utf-8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn final line */ }
  }
  return limit ? out.slice(-limit) : out;
}
