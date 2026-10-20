// src/router/dispatch.js
// What actually happens to an utterance (4.4).
//
// classify.js decides *what kind* of thing was said; this decides what to *do*
// about it, which is a different question the moment a mission is already
// running. The same five words mean different things depending on whether the
// system is busy:
//
//   "also add tests"   idle → start a mission
//                      busy → steer the running one, do not start a second
//   "fix it"           idle → clarify, there is no antecedent
//                      busy → steering; "it" is obviously the running mission
//   "what is a monad"  idle → answer
//                      busy → answer, in parallel, WITHOUT disturbing the mission
//
// The last one is the important one. A question during a mission must not
// interrupt it — the user asking something while work happens is normal, and a
// system that pauses a twenty-minute job to answer "what's a monad" is broken.
//
// The rule, stated once: while a mission is running, an *instruction* steers it
// and a *question* is answered alongside it.

import { classify, classifyWithLlm, logDecision } from './classify.js';
import { reflex, escalationPrompt } from '../reflex/engine.js';

/** What the dispatcher decided to do. */
export const ACTIONS = Object.freeze([
  'answered',      // a reflex answer
  'started',       // a new mission
  'proposed',      // a mission was offered, awaiting confirmation
  'steered',       // injected into a running mission
  'controlled',    // stop/pause/resume/status
  'clarify',       // asked the user what they meant
]);

/**
 * Route one utterance.
 *
 * Everything the dispatcher needs is injected, so this is testable without a
 * daemon, a model, or a filesystem.
 *
 * @param {string} text
 * @param {object} deps
 * @param {string}   deps.sessionId
 * @param {string}   [deps.workspace]
 * @param {object[]} [deps.runningMissions]  missions currently active in this session
 * @param {object}   [deps.conversation]     Conversation instance
 * @param {function} [deps.startMission]     async ({task, profile, workspace}) => mission
 * @param {function} [deps.controlMission]   async (action, missionId) => any
 * @param {function} [deps.steerMission]     async (missionId, message) => any
 * @param {function} [deps.runReflex]        override the reflex engine (tests)
 * @param {boolean}  [deps.autoStart]        start escalated missions without asking
 * @param {object}   [deps.reflexOpts]
 * @returns {Promise<object>} {action, text, mission?, decision}
 */
export async function dispatch(text, {
  sessionId,
  workspace = null,
  runningMissions = [],
  conversation = null,
  startMission = null,
  controlMission = null,
  steerMission = null,
  runReflex = null,
  autoStart = false,
  reflexOpts = {},
  logDir = null,
  useLlmClassifier = false,
  classifyLlm = null,
  degraded = null,
  memory = null,
  askGraph = null,
} = {}) {
  const utterance = String(text || '').trim();
  const missionRunning = runningMissions.length > 0;
  const context = { missionRunning, hasWorkspace: !!workspace };

  // ── The graph plane (G3) ────────────────────────────────────────────
  // "ask <domain> <question>" routes through the ontology graph, not the
  // reflex: retrieval is a traversal over evidence-backed nodes, the answer
  // cites node ids, and an ungrounded reply falls back to plain facts.
  // askGraph returns null for an unknown domain, and the utterance falls
  // through to the normal pipeline — "ask yourself why" stays a question.
  const askMatch = askGraph && utterance.match(/^ask\s+([a-z0-9][a-z0-9-]{0,40})\s+(.+)$/i);
  if (askMatch) {
    const graphOut = await askGraph(askMatch[1].toLowerCase(), askMatch[2]);
    if (graphOut) {
      if (conversation) conversation.userSaid(sessionId, utterance, { intent: 'graph_ask' });
      const message = graphOut.answer
        || `The ${askMatch[1]} graph has nothing matching that${graphOut.reason ? ` — ${graphOut.reason}` : ''}.`;
      if (conversation) conversation.assistantSaid(sessionId, message, { action: 'answered' });
      return {
        action: 'answered', text: message,
        decision: { intent: 'graph_ask', domain: askMatch[1].toLowerCase() },
        graph: {
          plan: graphOut.plan?.id || null, release: graphOut.plan?.release || null,
          grounded: !!graphOut.grounded, cites: graphOut.cites || [],
          ...(graphOut.floor ? { floor: graphOut.floor } : {}),
        },
      };
    }
  }

  // Keyword first, always. The model is consulted only for the genuinely
  // ambiguous middle, and only when the caller opted in — the daemon does,
  // because asking "what did you mean?" is a worse answer than spending 200ms
  // to find out. Unit tests do not, so they stay offline and fast.
  const decision = (useLlmClassifier || classifyLlm)
    ? await classifyWithLlm(utterance, { ...context, llm: classifyLlm || undefined })
    : classify(utterance, context);
  logDecision(decision, { text: utterance, sessionId, dir: logDir });

  if (conversation && utterance) conversation.userSaid(sessionId, utterance, { intent: decision.intent });

  const say = (action, message, extra = {}) => {
    if (conversation && message) conversation.assistantSaid(sessionId, message, { action });
    return { action, text: message, decision, ...extra };
  };

  // ── Control ─────────────────────────────────────────────────────────
  if (decision.intent === 'control') {
    return handleControl({ decision, runningMissions, controlMission, steerMission, utterance, say });
  }

  // ── Clarify ─────────────────────────────────────────────────────────
  if (decision.intent === 'clarify') {
    return say('clarify', clarifyPrompt(utterance, { hasWorkspace: !!workspace }));
  }

  // ── Instruction while busy → steer, don't start a rival mission ────
  if (missionRunning && decision.intent === 'mission') {
    // Same workspace means a second mission would queue behind the first
    // anyway (S5), so steering gets the change applied now rather than after
    // the current job finishes. Different workspace is genuine parallel work.
    const sameWorkspace = runningMissions.some(m => !workspace || m.workspace === workspace);
    if (sameWorkspace && steerMission) {
      const target = runningMissions[0];
      await steerMission(target.id, utterance);
      return say('steered', `Passed that to the running mission (${target.id}).`, { missionId: target.id });
    }
  }

  // ── Question while busy → answer in parallel ───────────────────────
  // Deliberately falls through to the normal reflex path: a running mission is
  // not a reason to stop answering, and the reflex touches nothing the mission
  // is working on (read-only tools, no writes).

  if (decision.intent === 'reflex' || decision.intent === 'tool_call') {
    // S3: when the kernel already knows the endpoint is down, answer from the
    // canned local path instead of rediscovering it. Attempting the call costs
    // the retry backoff — about six seconds — to learn what we knew before we
    // started, and the user is sitting there for all of it.
    if (degraded) {
      return say('answered',
        `I can't answer that right now — ${degraded}. Missions still queue and will run when it's back.`,
        { degraded });
    }
    const engine = runReflex || reflex;
    const history = conversation ? conversation.history(sessionId, 10) : [];
    // P5.5: the reflex sees global + session scope only. It has no gates, so it
    // must not be able to surface a private project's memory into a chat reply.
    const recalled = memory
      ? safeRecallText(memory, { layer: 'reflex', query: utterance, sessionId, workspace })
      : '';
    const r = await engine(utterance, { sessionId, workspace, history, recall: recalled, ...reflexOpts });

    if (r.escalation?.proposed) {
      return proposeOrStart({ r, decision, workspace, sessionId, startMission, autoStart, conversation, say });
    }
    if (r.degraded && !r.text) {
      // Honest degradation (S3) rather than silence or a fabricated answer.
      return say('answered', `I can't answer right now — ${r.degraded}.`, { degraded: r.degraded });
    }
    return say('answered', r.text, { toolUsed: r.toolUsed, latencyMs: r.latencyMs, truncated: r.truncated });
  }

  // ── A new mission ───────────────────────────────────────────────────
  if (decision.intent === 'mission') {
    if (!startMission) return say('clarify', 'I can\'t start missions from here.');
    const mission = await startMission({
      task: utterance,
      profile: decision.profile,
      workspace,
      urgency: decision.urgency,
    });
    if (conversation) conversation.missionEvent(sessionId, { action: 'running', missionId: mission?.id, title: utterance });
    return { action: 'started', text: `Started ${mission?.id}.`, mission, decision };
  }

  return say('clarify', clarifyPrompt(utterance, { hasWorkspace: !!workspace }));
}

async function handleControl({ decision, runningMissions, controlMission, steerMission, utterance, say }) {
  const { action, target } = decision.control || {};

  // "fix it" mid-mission classifies as control/steer — the vague reference has
  // an obvious antecedent.
  if (action === 'steer') {
    if (!runningMissions.length) return say('clarify', 'There\'s nothing running to apply that to.');
    const m = runningMissions[0];
    if (steerMission) await steerMission(m.id, utterance);
    return say('steered', `Passed that to ${m.id}.`, { missionId: m.id });
  }

  if (action === 'status') {
    if (!runningMissions.length) return say('controlled', 'Nothing running right now.');
    const lines = runningMissions.map(m => `${m.id} — ${m.state}${m.title ? `: ${m.title}` : ''}`);
    return say('controlled', lines.join('\n'), { missions: runningMissions });
  }

  // stop / pause / resume
  const targets = target
    ? runningMissions.filter(m => m.id === target)
    : runningMissions;

  if (!targets.length) {
    return say('controlled', target
      ? `I don't see a mission ${target}.`
      : 'Nothing running to ' + action + '.');
  }
  if (controlMission) {
    for (const m of targets) await controlMission(action, m.id);
  }
  const verb = action === 'stop' ? 'Stopping' : action === 'pause' ? 'Pausing' : 'Resuming';
  return say('controlled', `${verb} ${targets.map(m => m.id).join(', ')}.`, {
    missionIds: targets.map(m => m.id),
  });
}

async function proposeOrStart({ r, decision, workspace, sessionId, startMission, autoStart, conversation, say }) {
  const esc = r.escalation;
  if (!autoStart || !startMission) {
    // The default, and the important one: propose. Silently converting a
    // question into twenty minutes of autonomous file editing is exactly the
    // behaviour that makes an agent untrustworthy.
    return say('proposed', escalationPrompt(esc), { proposal: esc });
  }
  const mission = await startMission({
    task: esc.task,
    profile: esc.profile,
    workspace,
    urgency: decision.urgency,
  });
  if (conversation) conversation.missionEvent(sessionId, { action: 'running', missionId: mission?.id, title: esc.task });
  return { action: 'started', text: `Started ${mission?.id}.`, mission, decision, proposal: esc };
}

/**
 * Recall, but never at the cost of the answer.
 *
 * Memory is an enhancement to a reply, not a precondition for one: a corrupt or
 * locked database must degrade to a reply without context rather than turn
 * every question into an error (S3's "memory service down" case).
 */
function safeRecallText(memory, opts) {
  try {
    return memory.recallText(opts) || '';
  } catch {
    return '';
  }
}

function clarifyPrompt(utterance, { hasWorkspace }) {
  if (!utterance) return 'Sorry — I didn\'t catch that.';
  if (!hasWorkspace) return `Which project should I do that in? I don't have a working directory for this session.`;
  return `I'm not sure what you'd like me to do with that — can you say a bit more?`;
}
