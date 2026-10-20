#!/usr/bin/env node
// eval/router-coverage.js
// Find utterances the router has no opinion about at all.
//
// This exists because of a specific failure. The fixture set sat at 100%
// accuracy while the verb "check" appeared in no signal table, so "check the
// build status" — an entirely ordinary instruction — scored zero on every
// intent and fell through to clarify. The router answered "what do you mean?"
// to a sentence a person had just said out loud.
//
// The fixture set could not have caught it. Fixtures are written by whoever
// wrote the classifier, so they encode what that person thought of, and they
// are scored on *accuracy* — the percentage right out of the cases that exist.
// A word nobody thought of is not a wrong answer, it is an absent question, and
// accuracy is structurally blind to it.
//
// So this measures something different: **coverage**. It runs a corpus of
// realistic utterances and looks for the fingerprint of "nothing matched",
// which classify() marks with a confidence of exactly 0.15. That number is a
// deliberate signal rather than a score, and it is the one thing that reliably
// distinguishes "I considered this and I am unsure" from "I have never heard of
// any word in this sentence".
//
// Anything genuinely ambiguous belongs in ACCEPTABLY_VAGUE with a reason, so
// the gate stays meaningful instead of being widened whenever it fires.

import { classify } from '../src/router/classify.js';

/** The value classify() assigns when no signal matched anywhere. */
const NOTHING_MATCHED = 0.15;

/**
 * Utterances that *should* fall through, with the reason.
 *
 * These are bare noun phrases with no verb. "build status" could mean show it,
 * watch it, or explain it, and asking is better than guessing — a router that
 * confidently picks one is worse than one that asks.
 */
const ACCEPTABLY_VAGUE = new Map([
  ['build status', 'noun phrase, no verb — show it? watch it? explain it?'],
  ['test results', 'noun phrase, no verb'],
  ['the error log', 'noun phrase, no verb'],
]);

/** Things a person might plausibly say to this system. */
const CORPUS = [
  // Inspecting state
  'check the build status', 'verify the tests pass', 'confirm the deploy worked',
  'look at the error log', 'look up the config value', 'review the changes',
  'inspect the database schema', 'see if the server is up', 'test the connection',
  'validate the config file', 'diff the two files', 'compare these versions',
  'count the failing tests', 'summarize the log file',

  // Yes/no questions about live state
  'is the build passing', 'is the daemon running', 'are the tests green',
  'did the deploy finish', 'has the mission completed', 'was the commit pushed',
  'do we have any failing tests',

  // Bare noun phrases
  'build status', 'test results', 'the error log', 'my calendar today',

  // Doing things
  'deploy to staging', 'restart the daemon', 'install the dependencies',
  'update the readme', 'rename this variable', 'delete the temp files',
  'commit these changes', 'push to main', 'revert that change',
  'refactor this function', 'write a test for the parser', 'fix the failing test',
  'add error handling here', 'implement the retry logic', 'build the project',
  'clean up the imports', 'optimize this query', 'migrate the schema',

  // Errands
  'remind me to call the dentist', 'schedule a meeting for tuesday',
  'email the team about the release', 'add lunch to my calendar',
  'cancel my 3pm', 'text sarah that i am running late',

  // Questions
  'what is the difference between these', 'why did the build fail',
  'how do i configure the vault', 'explain the router to me',
  'what does this error mean', 'when should i use a mission',

  // Control
  'stop', 'pause that', 'cancel the current mission', 'resume', 'never mind',

  // Conversational
  'thanks', 'good morning', 'that worked', 'perfect', 'no that is wrong',
];

function main() {
  const json = process.argv.includes('--json');
  const verbose = process.argv.includes('--verbose');

  const rows = CORPUS.map((text) => {
    const result = classify(text);
    const confidence = typeof result.confidence === 'number' ? result.confidence : NaN;
    return {
      text,
      intent: result.intent,
      confidence,
      dead: result.intent === 'clarify' && Math.abs(confidence - NOTHING_MATCHED) < 1e-9,
    };
  });

  const dead = rows.filter(r => r.dead);
  const unexpected = dead.filter(r => !ACCEPTABLY_VAGUE.has(r.text));
  // An entry that no longer falls through is not a failure, but leaving it in
  // the allowlist would hide the next real one.
  const staleAllowances = [...ACCEPTABLY_VAGUE.keys()]
    .filter(text => !dead.some(d => d.text === text));

  if (json) {
    console.log(JSON.stringify({
      corpus: CORPUS.length,
      dead: dead.length,
      unexpected: unexpected.map(r => r.text),
      staleAllowances,
      rows: verbose ? rows : undefined,
    }, null, 2));
  } else {
    console.log(`Router coverage — ${CORPUS.length} realistic utterances\n`);
    if (verbose) {
      for (const r of rows) {
        console.log(`${r.dead ? '!!' : '  '} ${r.text.padEnd(42)} ${String(r.intent).padEnd(10)} ${r.confidence.toFixed(2)}`);
      }
      console.log('');
    }
    console.log(`  matched nothing : ${dead.length}`);
    console.log(`  of those, allowed: ${dead.length - unexpected.length}`);

    if (unexpected.length) {
      console.log(`\nFAILED — ${unexpected.length} utterance(s) match no signal at all:`);
      for (const r of unexpected) console.log(`  "${r.text}"`);
      console.log('\nEither add a signal for it, or add it to ACCEPTABLY_VAGUE with a reason.');
    }
    if (staleAllowances.length) {
      console.log(`\nStale allowances (now handled — remove them):`);
      for (const t of staleAllowances) console.log(`  "${t}"`);
    }
    if (!unexpected.length && !staleAllowances.length) console.log('\nPASSED');
  }

  process.exit(unexpected.length || staleAllowances.length ? 1 : 0);
}

main();
