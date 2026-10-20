// tests/fixtures/router-cases.js
// The router's 100-case fixture set (Phase 4.1).
//
// JARVIS_EVOLUTION_PLAN.md calls this "the deliverable that keeps the router
// honest forever", and that is the right framing: a classifier's accuracy claim
// is meaningless without a fixed set it did not get to choose. Adding a case is
// cheap; changing a case's label to make a number go up is cheating, and any
// relabel should be justified in the commit that does it.
//
// Composition is deliberate. Roughly a third are the easy centre of each class,
// and the rest are the places a keyword classifier actually fails:
//
//   * questions containing imperative build vocabulary ("how do I build…")
//   * imperatives containing question vocabulary ("figure out why X is slow")
//   * nouns that are also verbs ("the build is broken" vs "build the thing")
//   * politeness prefixes hiding the real verb ("hey, could you refactor…")
//   * short fragments that are genuinely unclear vs merely terse
//   * control phrases that must not be confused with work ("stop the server
//     from crashing" is a mission; "stop" is control)
//
// `note` explains why a case is interesting; it appears in the failure output
// so a regression tells you what broke, not just that something did.

/** @typedef {{text: string, intent: string, profile?: string, note?: string}} RouterCase */

/** @type {RouterCase[]} */
export const ROUTER_CASES = [
  // ── mission: build (12) ────────────────────────────────────────────
  { text: 'build a REST API with Express and Postgres', intent: 'mission', profile: 'build' },
  { text: 'create a CLI tool that converts CSV to JSON', intent: 'mission', profile: 'build' },
  { text: 'implement pagination on the products endpoint', intent: 'mission', profile: 'build' },
  { text: 'refactor the auth module to use async/await', intent: 'mission', profile: 'build' },
  { text: 'fix the bug where the cart total is wrong after removing an item', intent: 'mission', profile: 'build' },
  { text: 'add tests for the payment service', intent: 'mission', profile: 'build' },
  { text: 'migrate the database layer from MySQL to Postgres', intent: 'mission', profile: 'build' },
  { text: 'hey, could you refactor the checkout flow when you get a chance', intent: 'mission', profile: 'build',
    note: 'politeness prefix + trailing hedge must not hide the imperative' },
  { text: 'please write a Python script that renames all the images in ./assets', intent: 'mission', profile: 'build' },
  { text: 'set up eslint and prettier for this repo', intent: 'mission', profile: 'build' },
  { text: 'the login page is broken on mobile, fix it and add a regression test', intent: 'mission', profile: 'build',
    note: '"fix it" has a real antecedent in the same sentence — not clarify' },
  { text: 'rewrite the parser so it handles nested quotes correctly', intent: 'mission', profile: 'build' },
  // `['optimi', 3]` sat in the signal table unable to match anything —
  // compile() wraps patterns in \b, so it looked for the literal word "optimi".
  // A prefix cannot be written as a bare signal.
  { text: 'optimize this query', intent: 'mission', profile: 'build' },
  { text: 'rename this variable everywhere it appears', intent: 'mission', profile: 'build' },
  { text: 'fix the failing test in the parser suite', intent: 'mission', profile: 'build' },

  // ── mission: research (10) ─────────────────────────────────────────
  { text: 'summarize what changed in this repo this week', intent: 'mission', profile: 'research' },
  { text: 'compare Fastify and Express for our use case and write it up', intent: 'mission', profile: 'research' },
  { text: 'research the best approach for offline sync in a mobile app', intent: 'mission', profile: 'research' },
  { text: 'investigate why our CI has gotten so slow over the last month', intent: 'mission', profile: 'research',
    note: 'starts with an imperative, contains "why" — must not become reflex' },
  { text: 'audit the dependencies for known vulnerabilities and report back', intent: 'mission', profile: 'research' },
  { text: 'review the codebase and tell me where the tech debt is', intent: 'mission', profile: 'research' },
  { text: 'look into what it would take to support SSO', intent: 'mission', profile: 'research' },
  { text: 'write up the pros and cons of moving to a monorepo', intent: 'mission', profile: 'research' },
  { text: 'document how the memory palace subsystem works', intent: 'mission', profile: 'research' },
  { text: 'analyze the last 200 log entries and find the pattern in the failures', intent: 'mission', profile: 'research' },

  // ── mission: errand (8) ────────────────────────────────────────────
  { text: 'remind me to check the deploy on Friday', intent: 'mission', profile: 'errand' },
  { text: 'schedule a 30 minute sync with the platform team next week', intent: 'mission', profile: 'errand' },
  { text: 'email Bob the release notes once the build passes', intent: 'mission', profile: 'errand' },
  { text: 'book a meeting room for Thursday afternoon', intent: 'mission', profile: 'errand' },
  { text: 'add the sprint review to my calendar', intent: 'mission', profile: 'errand' },
  { text: 'set a timer for 25 minutes', intent: 'mission', profile: 'errand' },
  { text: 'cancel my 3pm and let them know I will reschedule', intent: 'mission', profile: 'errand',
    note: '"cancel my" is an errand, not a control verb — the control rule must not eat it' },
  { text: 'send the invoice to accounting when the PR is merged', intent: 'mission', profile: 'errand' },

  // ── reflex: questions (16) ─────────────────────────────────────────
  { text: 'what is a monad?', intent: 'reflex' },
  { text: 'why does JavaScript have both null and undefined?', intent: 'reflex' },
  { text: 'how do I build a REST API in Express?', intent: 'reflex',
    note: 'the hard one: build vocabulary inside a question. Wants an answer, not an API' },
  { text: 'how does the event bus work in this project?', intent: 'reflex' },
  { text: 'what does this error mean: ECONNREFUSED 127.0.0.1:5432', intent: 'reflex' },
  { text: 'should I use a queue here or just retry?', intent: 'reflex' },
  { text: 'what is the difference between fork and spawn?', intent: 'reflex' },
  { text: 'explain the difference between a session and a mission', intent: 'reflex' },
  { text: 'is Postgres a good fit for time series data?', intent: 'reflex' },
  { text: 'can you explain what the completion guard does?', intent: 'reflex' },
  { text: 'tell me about the trust tier design', intent: 'reflex' },
  { text: 'what do you think of this approach?', intent: 'reflex' },
  { text: 'do you know if Node supports top-level await?', intent: 'reflex' },
  { text: 'remind me what the mission profiles are', intent: 'reflex',
    note: '"remind me" is an errand verb, but "remind me what" is recall — a question' },
  { text: 'which is faster, a Map or an object?', intent: 'reflex' },
  { text: 'when should I use a worker thread instead of a child process?', intent: 'reflex' },

  // ── reflex: conversational (10) ────────────────────────────────────
  { text: 'thanks, that worked', intent: 'reflex' },
  { text: 'thank you', intent: 'reflex' },
  { text: 'hello', intent: 'reflex' },
  { text: 'good morning', intent: 'reflex' },
  { text: 'nice work on that last one', intent: 'reflex' },
  { text: 'ok', intent: 'reflex' },
  { text: 'sounds good', intent: 'reflex' },
  { text: 'hey', intent: 'reflex' },
  { text: 'cool', intent: 'reflex' },
  { text: 'yes', intent: 'reflex' },
  { text: 'perfect', intent: 'reflex' },
  // Yes/no questions about live state. `is it` was covered; `is the` — how
  // people phrase it about a *named* thing — matched nothing at all.
  { text: 'is the build passing', intent: 'reflex' },
  { text: 'are the tests green', intent: 'reflex' },
  { text: 'has the mission completed', intent: 'reflex' },

  // ── tool_call (12) ─────────────────────────────────────────────────
  { text: 'show me the last 50 lines of the log', intent: 'tool_call' },
  { text: 'list the files in src/kernel', intent: 'tool_call' },
  { text: "what's in package.json", intent: 'tool_call' },
  { text: 'read the file src/loop.js', intent: 'tool_call' },
  { text: 'git status', intent: 'tool_call' },
  { text: 'show the last commit', intent: 'tool_call' },
  { text: 'grep for TODO in the src directory', intent: 'tool_call' },
  { text: 'tail the daemon log', intent: 'tool_call' },
  { text: 'open src/config.js', intent: 'tool_call' },
  { text: 'list all the mission profiles', intent: 'tool_call' },
  { text: 'find the file that defines completionGuard', intent: 'tool_call' },
  { text: 'print the current config', intent: 'tool_call' },
  // "check X" — added after a real spoken utterance exposed the gap. Every one
  // of these scored zero on every intent and fell through to clarify, so the
  // router answered an ordinary instruction with "what do you mean?". They are
  // here rather than in a note because a fixture is the only kind of finding
  // that cannot quietly regress.
  { text: 'check the build status', intent: 'tool_call' },
  { text: 'check my email', intent: 'tool_call' },
  { text: 'check if the tests are passing', intent: 'tool_call' },
  { text: 'check whether the daemon is running', intent: 'tool_call' },
  { text: 'check for uncommitted changes', intent: 'tool_call' },
  // The rest of the "go and look" family, found by auditing a corpus for the
  // 0.15 "nothing matched" fingerprint (eval/router-coverage.js). Before this,
  // 30 of 65 ordinary utterances scored zero on every intent.
  { text: 'verify the tests pass', intent: 'tool_call' },
  { text: 'look at the error log', intent: 'tool_call' },
  { text: 'inspect the database schema', intent: 'tool_call' },
  { text: 'see if the server is up', intent: 'tool_call' },
  { text: 'validate the config file', intent: 'tool_call' },
  { text: 'restart the daemon', intent: 'tool_call' },
  { text: 'commit these changes', intent: 'tool_call' },
  { text: 'push to main', intent: 'tool_call' },

  // ── control (12) ───────────────────────────────────────────────────
  { text: 'stop', intent: 'control' },
  { text: 'stop that mission', intent: 'control' },
  { text: 'stop the current run', intent: 'control' },
  { text: 'cancel that', intent: 'control' },
  { text: 'abort', intent: 'control' },
  { text: 'pause', intent: 'control' },
  { text: 'resume', intent: 'control' },
  { text: 'keep going', intent: 'control' },
  { text: 'never mind', intent: 'control' },
  { text: 'what are you working on?', intent: 'control' },
  { text: 'status', intent: 'control' },
  { text: 'list my missions', intent: 'control' },

  // ── clarify (10) ───────────────────────────────────────────────────
  { text: 'fix it', intent: 'clarify', note: 'no antecedent and no running mission' },
  { text: 'do that thing', intent: 'clarify' },
  { text: 'the usual', intent: 'clarify' },
  { text: 'again', intent: 'clarify' },
  { text: 'it doesn\'t work', intent: 'clarify' },
  { text: 'try again', intent: 'clarify' },
  { text: 'handle it', intent: 'clarify' },
  { text: 'the other one', intent: 'clarify' },
  { text: 'whatever you think', intent: 'clarify' },
  { text: 'that thing we discussed', intent: 'clarify' },

  // ── adversarial: verb/noun collisions and near-misses (10) ─────────
  { text: 'the build is broken', intent: 'clarify',
    note: '"build" as a noun with no instruction — a statement of fact, not a request' },
  { text: 'stop the server from crashing on startup', intent: 'mission', profile: 'build',
    note: 'starts with "stop" but is a debugging job, not a control verb' },
  { text: 'why is the build so slow?', intent: 'reflex',
    note: '"build" noun + question — asks for an explanation' },
  { text: 'figure out why the build is so slow and fix it', intent: 'mission', profile: 'build',
    note: 'imperative wrapping a question — this is work, not a chat answer. ' +
          'Profile relabelled research→build during 4.1: the deliverable is a ' +
          'faster build (a code change), not a written finding, so the build ' +
          'profile\'s smoke+artifact gates are the correct ones. The investigation ' +
          'is a means, not the output.' },
  { text: 'can you run the tests', intent: 'tool_call',
    note: 'question-shaped but it is a single concrete action' },
  { text: 'test', intent: 'clarify', note: 'one ambiguous word that is both a noun and a verb' },
  { text: 'is the deploy done?', intent: 'reflex',
    note: 'a status-ish question, but about the world rather than about our own missions' },
  { text: 'add support for webhooks, including retries, signature verification, and a dead letter queue', intent: 'mission', profile: 'build',
    note: 'long multi-clause request — unambiguously a job' },
  { text: 'what should I name this function?', intent: 'reflex' },
  { text: 'deploy to staging', intent: 'mission', profile: 'build',
    note: 'terse but a real action with consequences' },
];

/** Cases whose meaning changes when a mission is already running (4.4). */
export const CONTEXTUAL_CASES = [
  { text: 'fix it', context: { missionRunning: true }, intent: 'control',
    note: 'mid-mission, "it" has an obvious antecedent — this is steering' },
  { text: 'fix it', context: { missionRunning: false }, intent: 'clarify',
    note: 'the same words, no mission, nothing to refer to' },
  { text: 'also add tests', context: { missionRunning: true }, intent: 'mission',
    note: 'a concrete addition still reads as work; the router hands it to steering downstream' },
  { text: 'stop', context: { missionRunning: true }, intent: 'control' },
  { text: 'build a REST API', context: { hasWorkspace: false }, intent: 'clarify',
    note: 'no workspace means no mission can start; asking which one is honest' },
];
