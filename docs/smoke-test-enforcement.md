# Smoke Test Enforcement — Implementation Guide

The agent loop enforces runtime smoke tests at **3 layers**: prompt instructions, a hard programmatic gate, and LLM-based verification.

---

## Layer 1: Prompt Instructions (soft — tells the model what to do)

### System Prompt — Rule 16 (`src/context.js`, line ~62)

The system prompt includes a rule telling the model to write and run a `_smoke_test.py` (or `_smoke_test.js`) after creating any application:

```
16. Runtime smoke test: after creating an application, ALWAYS write a file called `_smoke_test.py`
    (or `_smoke_test.js`) in the workspace root and run it. The smoke test must:
    - Import modules using PACKAGE imports (e.g. `from snake_game.snake import Snake`),
      NOT relative imports from inside the package directory
    - Instantiate key classes and call their main methods
    - NOT use any interactive features (no GUI, no curses.wrapper, no input(), no blocking I/O)
    - Print "SMOKE OK" at the end if everything passes
    - Run from the workspace root: `python3 _smoke_test.py` (NOT `cd package && python3 ...`)
    If the smoke test crashes, read the traceback, fix the bug with `edit_file`, and re-run
    until it prints "SMOKE OK". Never call `finish` until the smoke test passes.
```

### Verification Stage Guidance (`src/stages.js`, line ~566)

The verification stage guidance repeats the requirement with even more emphasis:

```
IMPORTANT — Runtime Smoke Test: You MUST write a file called _smoke_test.py ...
If the smoke test crashes, read the traceback, fix the bug with edit_file,
and re-run until "SMOKE OK" prints.
Only set stage_status: complete AFTER _smoke_test.py prints "SMOKE OK".
```

This layer is **soft** — the model can ignore instructions. That's why layers 2 and 3 exist.

---

## Layer 2: Hard Gate (blocks finish without smoke test evidence)

### Location: `src/loop.js` — finish handler (after completion guard, before `verifyCompletion`)

Before the LLM-based verification is even called, the loop scans working memory for concrete evidence that a smoke test was run:

```javascript
const smokeTestEvidence = memory.entries.some(e =>
  e.action === 'run_command' && !e.error &&
  (String(e.args?.command || '').includes('_smoke_test') ||
   String(e.result || '').includes('SMOKE OK'))
);
```

**Detection criteria** (either must match):
1. A successful `run_command` where the command string contains `_smoke_test`
2. A successful `run_command` where the output contains `SMOKE OK`

**If no evidence is found**, finish is **blocked entirely**:

```javascript
if (!smokeTestEvidence) {
  const smokeMsg = 'Finish BLOCKED: No runtime smoke test detected. You MUST write a
    _smoke_test.py file in the workspace root, run it with run_command, and get "SMOKE OK"
    output BEFORE calling finish...';
  log(`Smoke test gate: BLOCKED (attempt ${verificationFailures + 1})`);
  runtimeGuidance = smokeMsg;
  memory.push({
    step,
    subStep: 'smoke_test_gate',
    action: 'verification_failed',
    args: {},
    result: smokeMsg,
    error: true,
    timestamp: Date.now(),
  });
  verificationFailures++;
  consecutiveErrors = 1;
  saveState();
  continue;  // back to main loop — finish never reaches verifyCompletion()
}
```

This is a **hard programmatic check** — no LLM involved, cannot be talked around or bypassed by the model.

---

## Layer 3: LLM Verification (checks quality after smoke test passes)

### Location: `src/context.js` — `buildVerificationMessages()`

Once the hard gate passes (layer 2), the LLM verifier also checks smoke test evidence:

```javascript
const smokeTestRan = memory ? memory.entries.some(e =>
  e.action === 'run_command' && !e.error &&
  (String(e.args?.command || '').includes('_smoke_test') ||
   String(e.result || '').includes('SMOKE OK'))
) : false;
```

This flag is included in the verification prompt as:
- `"PASSED — A smoke test was executed successfully."` or
- `"NOT RUN — No runtime smoke test was detected..."`

The verifier's system prompt says:
```
IMPORTANT: For application tasks, a runtime smoke test must have been run.
If no smoke test was run, verification MUST fail.
```

This layer catches cases where the smoke test ran but had issues (e.g., it ran but didn't test enough, or the test itself was flawed).

---

## Why the Hard Gate Was Necessary

Before the hard gate existed, only layers 1 (prompt) and 3 (LLM verification) were in place. The problem:

1. Model calls `finish` without writing a smoke test
2. LLM verifier rejects it (layer 3 works correctly)
3. Model calls `finish` again — rejected again
4. After **3 total rejections**, `verifyCompletion()` force-accepts to prevent infinite loops:

```javascript
if ((priorFailures + 1) >= MAX_TOTAL_FAILURES) {
  log(`Verification forced-accept after ${priorFailures + 1} total failures.`);
  return true;  // force-accept
}
```

The model could brute-force through by calling `finish` 3-4 times in a row.

### Fix

The hard gate (layer 2) blocks finish **before** `verifyCompletion()` runs, so the force-accept counter increments but the LLM verification call is never made. The model is forced to actually write and run the test.

Additionally, the force-accept threshold was raised from **3 → 6** (`AGENT_VERIFY_MAX_FAILURES` env var) as extra protection.

---

## Escalating Failure Messages

After repeated verification failures, the feedback message escalates:

```javascript
const escalation = verificationFailures >= 2
  ? `CRITICAL (attempt ${verificationFailures + 1}): Your finish was rejected AGAIN.
     You MUST: 1) Write _smoke_test.py that imports key classes using package imports,
     2) Run it with run_command, 3) Fix any errors until it prints "SMOKE OK",
     4) ONLY THEN call finish.`
  : 'Your completion was not verified. Before calling finish again: 1) Write and run
     a _smoke_test.py, 2) Update the plan, 3) Verify output, 4) Include evidence.';
```

---

## Flow Diagram

```
Model calls finish
       │
       ▼
┌──────────────────┐
│ Stage check       │──▶ Not in finalization? BLOCK (continue loop)
│ (stages.js)       │
└──────────────────┘
       │ pass
       ▼
┌──────────────────┐
│ Completion guard  │──▶ Missing outputs/contracts? BLOCK (continue loop)
│ (stages.js)       │
└──────────────────┘
       │ pass
       ▼
┌──────────────────┐
│ Smoke test gate   │──▶ No _smoke_test or SMOKE OK in memory? BLOCK (continue loop)
│ (loop.js - NEW)   │     Does NOT call verifyCompletion() — force-accept can't trigger
└──────────────────┘
       │ pass
       ▼
┌──────────────────┐
│ LLM verification  │──▶ LLM says not verified? BLOCK (continue loop)
│ (loop.js)         │     After 6 failures → force-accept
└──────────────────┘
       │ pass
       ▼
   Task completed ✓
```

---

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `AGENT_VERIFY_MAX_FAILURES` | `6` | Force-accept threshold (was 3, raised to 6) |

---

## Files Modified

| File | What was changed |
|------|-----------------|
| `src/context.js` | Rule 16 in system prompt; `smokeTestRan` detection in `buildVerificationMessages()` |
| `src/stages.js` | Verification stage guidance with smoke test instructions |
| `src/loop.js` | Hard smoke test gate before `verifyCompletion()`; escalating failure messages; force-accept threshold 3→6 |
