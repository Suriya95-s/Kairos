# Compaction Logic — Kairos Agent Loop

A study of how the agent loop compresses its work history so it can run for
hundreds of steps without overflowing the model's context window.

**Source files studied**
- `src/loop.js` — the orchestration; *when* compaction fires (§2)
- `src/memory.js` — `WorkingMemory`, the sliding window that feeds it (§3)
- `src/compaction.js` — `compactMemory()`, the 4-phase pipeline (§4)
- `src/context.js` — how the compacted summary is injected back (§5)
- `src/identity.js` — flush + recovery prompts (§5)
- `src/config.js` — the tunable thresholds (§6)

---

## 1. The core idea

> **The LLM never sees raw conversation history. Every step it sees a prompt
> re-assembled from files.** (`src/context.js` header)

Working memory is a **sliding window of the last N steps in full detail**. Steps
older than the window are *not* simply dropped — they are **summarized by an LLM
into a dense, structured `context-summary.md`**, which is then injected back into
every future prompt as reference material. This is what lets the agent run
"long" while staying inside a fixed token budget: old detail is traded for a
bounded summary, and the source of truth is the files on disk, not the chat log.

```
┌─────────────────────────────────────────────────────────────┐
│ entries[]  (full WorkingMemory, persisted in checkpoint.json)│
│                                                             │
│  step 1 ... step (n-N)  │  step (n-N+1) ............ step n  │
│  ◄────── OLD ──────────►│◄──── WORKING WINDOW (N) ─────────► │
│       getOld()          │          getRecent()              │
│         │                                                    │
│         ▼                                                    │
│   compactMemory() ──► context-summary.md ──► every prompt    │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. When compaction fires (`src/loop.js:411`)

At the top of every step, before building the prompt:

```js
// ── 1. Compaction Check ──
const needsCompaction = memory.needsCompaction() ||
  shouldCompactByInterval(step, lastCompactionStep, config.compactionIntervalSteps);

if (needsCompaction && memory.getOld().length > 0) { ... }
```

Compaction triggers on **either** of two conditions, and **only** if there are
actually old (out-of-window) entries to compact:

| Trigger | Defined in | Condition |
|---|---|---|
| **Size-based** | `memory.needsCompaction()` (`memory.js:76`) | total chars of *old* entries' results `> compactionThresholdChars` (20 000) |
| **Interval-based** | `shouldCompactByInterval()` (`compaction.js:400`) | `step - lastCompactionStep >= compactionIntervalSteps` (15) |

So compaction happens **whichever comes first**: a noisy run that produces a lot
of output text trips the size trigger early; a quiet run still compacts at least
every 15 steps so the summary never goes stale.

### After a successful compaction (`loop.js:427-435`)
```js
memory.trimToWindow();        // physically drop old entries from working memory
lastCompactionStep = step;    // reset the interval clock
compactionCount++;
memoriesFlushed += flushedCount;
postCompaction = true;        // ← next prompt gets the recovery prompt (§5)
fileWriteCounters = {};        // reset write-thrash counters for the new window
```

### Failure handling (`loop.js:436-439`)
If `compactMemory()` throws, the loop logs it and **sets `lastCompactionStep = step`
anyway** — a deliberate *cooldown* so a persistently-failing compaction can't
retry-thrash on every single step. The run continues uncompacted.

> Note: `compactMemory` has its own internal fallback (§4, Phase 3), so reaching
> this outer `catch` is rare — it would take an exception outside the LLM call.

### A second, independent guard (`loop.js:569-584`)
Separate from history compaction, there's a **context-size hard guard** that runs
*after* the prompt is assembled. If the built prompt exceeds
`contextWindow × charsPerToken × contextHardLimitRatio` (≈90% of the window), it
progressively **halves the displayed working-memory window** and rebuilds — a
lossless, display-only trim (the entries stay in memory for normal compaction).
This protects against a single giant step blowing the window between compactions.

---

## 3. The data structure: `WorkingMemory` (`src/memory.js`)

A thin wrapper over `entries[]` with the window math:

| Method | Purpose |
|---|---|
| `push(entry)` | Append a step; **truncates string args at 500 chars** at storage time (keeps `checkpoint.json` lean), and flags exact-duplicate consecutive actions with `_duplicate`. |
| `getRecent(n)` | Last `n` entries — the working window shown in full. |
| `getOld(n)` | Everything *before* the last `n` — the compaction candidates. |
| `trimToWindow(n)` | Physically slice to the last `n` (called after compaction commits). |
| `needsCompaction()` | `true` if old-entries' result chars `> compactionThresholdChars`. |
| `formatForCompaction(old)` | One line per step: `Step N: action(args≤200) → [ERROR:] result≤500`. |
| `formatForContext(n)` | Rich markdown for the prompt; collapses duplicate streaks into `repeated ×K`; head+tail truncation of results >1000 chars. |

`n` defaults to `config.workingMemoryWindow` (**20**). The window is the single
knob that defines "old vs recent."

---

## 4. The pipeline: `compactMemory()` (`src/compaction.js:295`)

Called as:
```js
const { usage, flushedCount, mode } =
  await compactMemory(formatted, fromStep, toStep, oldEntries, compactionAnchor);
```

The lifecycle is **FLUSH → COMPRESS → SUMMARIZE → RECOVER**, with resilience
patterns borrowed from OpenClaw/Kilo (deterministic fallback, hard size cap,
mode metadata on every write).

First it computes the **hard size cap** for the resulting summary, scaled to the
context window:
```js
// 15% of context tokens × charsPerToken, clamped to [2 000, 40 000] chars
const maxSummaryChars =
  Math.min(40000, Math.max(2000, Math.floor(config.contextWindow * 0.15 * config.charsPerToken)));
```

### Phase 1 — Pre-compaction memory FLUSH (`:300`)
If `memoryFlushEnabled`, `flushMemories(rawOldEntries)` (`memory-store.js:476`)
walks the entries about to be destroyed and persists durable facts to the memory
store *before* they're lost:
- `read_file` of >20 lines → a `world` memory ("file exists, was examined")
- `run_command` → an `experience` memory; **failed commands keep full output**
  (tracebacks/diffs up to `FLUSH_DETAIL_CHARS`), successes stay terse
- `write_file` / `edit_file` → a `world` memory recording the path

It returns `flushedCount`, surfaced in logs and the run result. This is the
"write it down before you forget" safety net — the summary may compress detail,
but hard-won facts already live in persistent files.

### Phase 2 — COMPRESS the input (`:306`)
`compressRawEntries()` collapses **consecutive `parse_error` / `loop_guard`
streaks** into a single synthetic entry
(`[K consecutive parse_error entries collapsed]`) before anything is sent to the
LLM. This strips low-signal noise so the summarizer spends its budget on real
work. The result is re-formatted by `formatCompressedEntries()`.

### Phase 2b — RMT segmentation for huge traces (`:312`)
If `rmtEnabled` and `shouldInvokeRmt({ traceChars })` says the input is too big
for one pass, `segmentText()` chops it into overlapping windows and builds a
**condensed multi-segment preview** (first 800 chars of each segment) so the main
LLM call sees a manageably-sized input instead of choking on the full trace.

### Phase 3 — LLM SUMMARIZE, with deterministic fallback (`:324`)
The LLM is prompted with `COMPACTION_SYSTEM_PROMPT`, which demands a **fixed
7-section structure**:

1. **Task Anchor** — one-sentence restatement of the goal
2. **Files Changed** — every file created/modified/deleted
3. **Commands Run** — important commands + outcomes
4. **Key Decisions** — architecture/library/approach choices
5. **Current State** — what works, what's broken, what's partial
6. **Learnings** — discoveries about the codebase
7. **Where I Left Off** — exact state of the last subtask (for seamless resume)

The user message stitches together: the **previous summary** (≤2000 chars, so it
*replaces* rather than accumulates), the **runtime anchor** (current stage,
locked target, blocker, missing outputs, verification snapshot — see below), and
the **new steps to summarize**, with an instruction to keep output under
`maxSummaryChars × 0.9`. The call uses `temperature: 0.1` for determinism, and
the response is stripped of `<think>`/`<thinking>` preambles.

```js
try {
  const response = await chatCompletion(messages, { temperature: 0.1 });
  newSummary = response.content.replace(/<think>...<\/think>/, '').trim();
  mode = 'llm';
} catch (err) {
  // LLM failed — deterministic fallback. Compaction must NEVER fully fail.
  newSummary = buildFallbackSummary(rawOldEntries, fromStep, toStep, existingSummary, anchor);
  mode = 'fallback';
}
```

**`buildFallbackSummary()` (`:196`)** is a no-LLM, pure-JS reconstruction: it
carries the Task Anchor forward from the old summary, then deterministically
walks the raw entries to rebuild Files Changed (deduped), Commands Run (deduped
by normalized command + status), unresolved Errors, Key Decisions, and a
"Where I Left Off" from the last 3 actions. The whole point is that **a summary
always gets written**, even if the summarizer model is down.

#### The runtime anchor (`buildRuntimeAnchorSection`, `:122`)
Injected ground truth so the summarizer can't bake in a wrong diagnosis:
current stage, locked target root, current blocker, missing outputs, next
required action, last milestone, recent recovery event — plus a
**Verification Snapshot** (`buildCompactionAnchor` in `verification.js`) listing
which check commands currently **PASS/FAIL**. This stops the classic failure
where the summary asserts "`board.py` is broken" when `board.py` actually passes
and `game.py` is the real culprit.

### Post-processing — invariants, traces, palace, hard cap

1. **`enforceCompactionInvariants()` (`:151`)** guarantees structural sections
   exist regardless of what the LLM returned: prepends the **Runtime Anchor** and
   **LMMA Route** blocks if missing, and ensures **Current State** and
   **Where I Left Off** sections are present (`ensureSection` only adds a heading
   if absent — it never duplicates).
2. **`compactRouteTraces()` (`:261`)** — if LMMA route traces exceed 80, keeps
   the last 40 and compresses the rest into a "frequent banks" one-liner.
3. **Palace consolidation (`:369`)** — if the memory-palace is active, runs a
   decay+archive pass (α=0.01) and appends a consolidation note.
4. **Hard size cap (`:381`)** — if the final summary still exceeds
   `maxSummaryChars`, it's hard-truncated with a
   `... [summary truncated at size limit]` marker. This is the anti-re-bloat
   backstop: the summary can never itself grow unbounded.

### The write (`:387`)
```js
writeContextSummary(
  `<!-- Compacted at step ${toStep}, <ISO ts>, compaction_mode=${mode}, flushed=${flushedCount} -->\n${newSummary}`
);
return { summary, usage, flushedCount, mode };
```
Every summary is stamped with `compaction_mode=llm|fallback` and the flush count.
That `mode` marker matters downstream (§5).

---

## 5. How the summary is injected back (`src/context.js`)

Compaction is only half the loop — the summary has to re-enter the prompt
usefully on every subsequent step.

**Bounded injection (`boundContextSummary`, `:190`).** The summary budget scales
with the window (`clamp(contextWindow × 0.15, 1800, 24000)` chars). If the
summary is bigger, it keeps **head (45%) + tail (55%)** with a
`... [NNNN chars truncated — see context-summary.md for full history] ...` marker
in the middle — the head holds the Task Anchor/Files Changed, the tail holds
"Where I Left Off," which are the two most decision-relevant ends. It's injected
under **"## Previous Work Reference"** with an explicit *"Reference only. Do NOT
summarize this back to the user"* guard (`:386`).

**Fallback annotation (`getCompactionAnnotation`, `:210`).** If the summary's
`compaction_mode=fallback` marker is present, a warning is prepended:
*"⚠️ generated by fallback compaction mode. Re-verify critical details from
source files."* — the agent is told to trust the lossy summary less.

**Staleness nudge (`:388`).** If `step - lastCompactionStep > 30`, it adds
*"⚠️ Context summary is N steps old. Re-check plan and key files before major
edits."*

**Pre-compaction FLUSH prompt (`buildFlushPrompt`, `identity.js:381`).** When the
loop knows compaction is imminent (`preCompactionFlush: true`), the prompt warns
*"This is your LAST CHANCE to save important context"* and pushes the agent to
call `save_memory`. (In the current loop this flag is passed `false` at the call
site — the automated `flushMemories` in Phase 1 is the active path — but the
prompt machinery exists for model-driven flushing.)

**Post-compaction RECOVER prompt (`buildRecoveryPrompt`, `identity.js:355`).**
The step *after* a compaction, `postCompaction` is `true`, so the prompt injects
a recovery block: re-anchor on SOUL/AGENTS/USER/MEMORY, use the summary +
runtime status to pick **one concrete next tool call**, and *"You have NOT lost
any files or progress — only the detailed step-by-step memory was compressed."*
It's **suppressed mid-repair** (when the last action was a `write_file`/`edit_file`/
`patch`, or `narrativeRecoverySuppressed`) so it doesn't interrupt an in-flight
edit. The flag is consumed (cleared) immediately after the prompt is built
(`loop.js:587`).

---

## 6. The tunable knobs (`src/config.js`)

| Config | Env var | Default | Role |
|---|---|---|---|
| `workingMemoryWindow` | `AGENT_MEMORY_WINDOW` | **20** | Steps kept in full detail; the old/recent boundary. |
| `compactionThresholdChars` | `AGENT_COMPACT_THRESHOLD` | **20 000** | Size trigger: old-entry chars above this → compact. |
| `compactionIntervalSteps` | `AGENT_COMPACT_INTERVAL` | **15** | Interval trigger: compact at least every N steps. |
| `memoryFlushEnabled` | — | **true** | Enable Phase-1 pre-compaction flush. |
| `contextWindow` | `AGENT_CONTEXT_WINDOW` | profile (16k–200k) | Drives summary-size + injection budgets. |
| `charsPerToken` | `AGENT_CHARS_PER_TOKEN` | **3.5** | Char↔token estimate for all budget math. |
| `contextHardLimitRatio` | `AGENT_CONTEXT_HARD_LIMIT_RATIO` | **0.9** | The §2 post-build hard guard threshold. |
| `rmtEnabled` | `AGENT_ENABLE_RMT` | **true** | Enable Phase-2b segmentation of huge traces. |
| `palaceEnabled` | `AGENT_USE_PALACE` | **false** | Enable palace consolidation in post-processing. |

Derived (not direct config):
- **Summary write cap** = `clamp(contextWindow × 0.15 × charsPerToken, 2000, 40000)` chars.
- **Summary inject budget** = `clamp(contextWindow × 0.15, 1800, 24000)` chars.

---

## 7. End-to-end trace of one compaction

1. Step `n` begins. `memory.needsCompaction()` is `true` (old results > 20k chars).
2. `getOld()` returns steps `1 … n-20`; `getRecent()` keeps the last 20.
3. `buildCompactionAnchor()` snapshots stage + which checks PASS/FAIL.
4. `compactMemory()`:
   - **Flush** durable facts from the old entries → memory store (`flushedCount`).
   - **Compress** parse_error/loop_guard streaks; **RMT-segment** if huge.
   - **Summarize** via LLM into the 7-section structure (or **fallback** to pure-JS).
   - **Enforce invariants**, fold in route-trace/palace notes, **hard-cap** size.
   - Write `context-summary.md` stamped `compaction_mode=…, flushed=…`.
5. `memory.trimToWindow()` drops the old entries; `lastCompactionStep = n`;
   `compactionCount++`; `postCompaction = true`.
6. Step `n+1`'s prompt carries the bounded summary as **"Previous Work
   Reference"** plus the **recovery prompt** — the agent re-orients from files
   and runtime truth, not from a chat log it no longer has.

---

## 8. Design principles, distilled

- **Files are the source of truth, not the conversation.** Compaction is safe
  *because* progress already lives on disk — the summary is a navigational aid,
  not the system of record.
- **Compaction must never fully fail.** Two triggers, a deterministic fallback,
  invariant enforcement, and an outer cooldown all guarantee forward progress.
- **Bounded everywhere.** Input is compressed/segmented; output is hard-capped on
  write *and* head/tail-bounded on inject — the summary can't re-bloat the window.
- **Ground the summarizer.** A runtime anchor + verification snapshot stop the
  LLM from baking a wrong diagnosis into long-lived state.
- **Flush before destroy, recover after.** Save durable facts pre-compaction;
  re-anchor the agent post-compaction (without interrupting an in-flight edit).
