# Advanced Agent Loop — Overall Workflow

A single-process autonomous agent that runs for hundreds of steps without a framework.
No graph, no state machine — just a loop that decides, executes, records, and persists.

---

## Architecture Overview

```
CLI → autoDetect → runLoop
         │
         ▼
   ┌─────────────────────────────────────────────┐
   │                 Main Loop                   │
   │                                             │
   │  1. Stage check + compaction                │
   │  2. Route → category → tools (≤4)           │
   │  3. Build 5-layer context                   │
   │  4. LLM call (chatCompletion)               │
   │  5. Multi-pass JSON parse                   │
   │  6. Anti-stall guards + stage gate          │
   │  7. Execute tool                            │
   │  8. Record to working memory                │
   │  9. Checkpoint (persist state)              │
   └─────────────────────────────────────────────┘
         │
         ▼
   finish / max_steps / budget_exceeded / error
```

---

## Step-by-Step Walkthrough

### 1. Startup (`src/cli.js`)

```
node src/cli.js --workspace <dir> --task "..."
```

- Reads env vars: `AGENT_API_KEY` (or `OPENAI_API_KEY`), `AGENT_BASE_URL`, `AGENT_MODEL`
- Auto-selects model profile from `config.js` (temperature, output limits, etc.)
- Calls `/v1/models` to auto-detect `max_model_len` from the server → scales `contextWindow`, `maxOutputTokens`, `workingMemoryWindow`, `compactionThresholdChars`, `compactionIntervalSteps`
- Initialises `.agent/` directory structure (plan, progress, checkpoint, memory logs)
- Bootstraps identity layer: `SOUL.md`, `AGENTS.md`, `USER.md`, `MEMORY.md`
- If task file is `.md`, copies it into `.agent/task-reference-<name>.md` for in-loop reading
- Calls `runLoop()`

### 2. Each Loop Step

#### Step 2a — Stage check + compaction
The stage system (`src/stages.js`) tracks 6 phases:
```
intake → discovery → planning → execution → verification → finalization
```
Each stage has a tool allowlist and advancement condition. Transitions happen automatically when conditions are met (e.g., all workspace artifacts exist → advance from execution to verification).

If working memory exceeds `config.compactionThresholdChars` (or by interval), the oldest entries are summarised by the LLM and appended to `.agent/context-summary.md`. Working memory is trimmed to the window.

#### Step 2b — Routing (`src/routing/`)
```
route(taskText, lastStep, stepIndex)
  → category  (filesystem | execution | planning | memory | identity | skills)
  → getExposedTools(category, frozenTool)
  → ≤4 tool definitions
```
The router uses pure keyword + rule scoring — no LLM, no async. Tool count is capped at 4 to minimise prompt token consumption on quantized models.

**Freeze mechanism:** After executing tool X, the next step exposes only `[X, finish]`. This keeps the model focused before re-routing freely.

#### Step 2c — 5-layer context assembly (`src/context.js`)

| Layer | Content |
|-------|---------|
| 1 Identity | `SOUL.md` + `AGENTS.md` operating rules |
| 2 Knowledge | Task, memory summary, learnings |
| 3 State | Plan status, focus chain, context summary, stage status |
| 4 Session | Recent actions (working memory window), stale-file alerts |
| 5 Guidance | Error warnings, focus prompts, think guard, runtime hints, stage guidance |

The LLM never sees raw conversation history. All context is rebuilt from files on every step — the key to long-running stability.

#### Step 2d — LLM call (`src/llm.js`)
```
POST /v1/chat/completions
{ model, messages, temperature, max_tokens }
```
Retries on network errors and 429/5xx with exponential backoff (2s → 4s, up to 3 attempts).

The model must respond with exactly one JSON object:
```json
{"thought":"...", "tool":"<name>", "args":{...}}
```

#### Step 2e — Multi-pass parse (`src/loop.js: parseAction`)

Six-stage pipeline, tried in order:

1. **Direct JSON parse** — fast path, handles clean responses
2. **Conservative repair** — closes missing trailing `}` / `]` (refuses to invent string content)
3. **JSON extraction from mixed text** — scans for balanced `{...}` objects in prose, repairs each candidate
4. **Fenced-block unwrap** — strips ` ```json ` / ` ``` ` wrappers anywhere in text
5. **MiniMax XML tool calls** — parses `<minimax:tool_call>` format
6. **Structured failure classification** — `PROSE_ONLY_RESPONSE`, `TRUNCATED_STRING`, `FENCED_JSON_INVALID`, `MULTIPLE_JSON_OBJECTS`, `SCHEMA_INVALID`, `NO_JSON_FOUND`

Classification-specific feedback is sent back to the model on the next step via `buildParseRecoveryGuidance()`.

#### Step 2f — Anti-stall guards
- **Think guard**: blocks two consecutive `think` calls
- **Loop detection**: same tool + same args for 3+ steps in a row → intervention
- **Parse error streak**: 3+ consecutive parse failures → forced think injection + recovery guidance
- **Consecutive error cap**: 8+ errors → terminate
- **Stage-misaligned action block**: actions inappropriate for the current stage are blocked with feedback
- **Stage reset safety valve**: 4+ consecutive stage-misaligned blocks → force stage back to execution

#### Step 2g — `finish` and sandbox verification (`src/sandbox-verifier.js`)

When the agent calls `finish`, the sandbox verifier runs before the loop exits. It uses a 3-source evidence model with hard rules:

```
finish tool called
  │
  ├─ snapshotWorkspace() diff (SHA256 per file, skip .agent/ node_modules/ .git/)
  ├─ Hard rule: 0 changes + 0 meaningful actions → FAIL
  ├─ Task verification commands (bash blocks under ## Verification / ## Verification Commands /
  │   ## Required Verification Commands / ## Validation Commands / ## Done Criteria headings)
  │     Any fail → FAIL immediately | All pass → PASS immediately
  ├─ Spot-checks: node --check (JS) / python3 -m py_compile (Python) per changed file
  │              + pre-existing _smoke_test.* / *.test.js / *.spec.js (auth-tests)
  │     Auth-test fails → FAIL immediately (no LLM override)
  │     All pass + strong verification signal in action log → PASS immediately
  │     (strong = real test runner ran, or output shows "SMOKE OK" / "N tests passed"
  │      — generic "config OK" from inline -c one-liners does NOT qualify)
  ├─ LLM judge: [workspace diff] + [action log] + [spot-check results] → {"verified": bool}
  └─ Rule-based fallback (LLM unavailable): checks + file diff → conservative FAIL/PASS
```

If `verified: false`, `finish` returns an error string and the loop continues — the agent must fix the problem. Set `AGENT_REQUIRE_SMOKE_TEST=false` to skip verification for non-build tasks.

See **[SANDBOX.md](SANDBOX.md)** for full implementation details.

#### Step 2h — Tool execution (`src/tools/` + `src/routing/toolRegistry.js`)
Tools are dispatched by name from the registry. Tool aliases are resolved first:

| Alias | Resolves to |
|-------|-------------|
| `bash` | `run_command` |
| `shell` | `run_command` |
| `ls` | `list_dir` |

Each tool handler returns a string result. Errors are caught and returned as `{ result, error: true }` — the loop never crashes on a tool failure.

#### Step 2i — Working memory (`src/memory.js`)
Every step is pushed to `WorkingMemory`. Args are truncated at storage time (500 chars) and further at display time (200 chars) to prevent checkpoint bloat. The context display uses head+tail truncation (400+400 chars) so long results show both the start and the final summary line.

#### Step 2j — Checkpoint (`src/state.js`)
At the end of every step, state is written to `.agent/checkpoint.json`:
```json
{
  "step": 42,
  "workingMemory": [...],
  "consecutiveErrors": 0,
  "compactionCount": 2,
  "stageState": { "currentStage": "execution", ... },
  ...
}
```
Pass `--resume` to pick up where a crashed session left off.

---

## File Layout

```
src/
  cli.js            Entry point — arg parsing, auto-detect, run
  config.js         All configurable constants, model profiles, env var overrides
  loop.js           Main agent loop + parseAction + anti-stall guards
  context.js        5-layer context assembly (system prompt + user message)
  llm.js            chatCompletion() with retry + exponential backoff
  memory.js         WorkingMemory class (sliding window)
  memory-store.js   Persistent memory log (.agent/memory/YYYY-MM-DD.md)
  compaction.js     LLM-assisted summarisation of old working memory
  state.js          File I/O helpers (.agent/* read/write)
  identity.js       bootstrapIdentity(), buildIdentityBlock()
  plan.js           Plan parsing and subtask tracking
  skills.js         Dynamic skill system (agent-created tools)
  stages.js         Stage-based execution (6 phases, tool gates, locked targets)
  tools.js          Compatibility stub → re-exports from tools/index.js
  tools/
    filesystem/     read_file, write_file, edit_file, list_dir,
                    search_files, glob, patch
    execution/      run_command, webfetch, websearch, lsp
    planning/       update_plan, add_learning, think, finish,
                    todowrite, todoread
    memory/         save_memory, search_memory, update_memory
    identity/       update_identity
    skills/         create_skill
    utils/          truncateResult, withToolGuidance, contract validation
  routing/
    toolRegistry.js Static tool registry, category map, alias resolution
    router.js       Keyword + rule scorer → category string
    toolManager.js  Tool exposure (MAX_TOOLS=4), freeze mode
    loopController.js Self-contained routed loop (testable with mock LLM)

tests/
  parseAction.test.js  57-test suite: JSON parsing, fences, repair, file types
  parser.test.md       Test specification document

.agent/                   Runtime state (gitignored, created per workspace)
  checkpoint.json         Crash-recovery snapshot
  task.md                 Current task
  plan.md                 Structured plan with checkboxes
  progress.md             Step-by-step log with timestamps
  context-summary.md      Compacted history (grows incrementally)
  focus-chain.md          Human-editable priority steering
  learnings.md            Accumulated learnings
  memory/                 Daily persistent memory logs + tracking JSON
  skills/                 Custom skills created at runtime
```

---

## Running the Agent

```bash
# Fresh task (inline)
AGENT_API_KEY="..." \
OPENAI_BASE_URL="http://<vllm-host>/v1" \
OPENAI_MODEL="<model-id>" \
node src/cli.js --workspace ./my-project --task "Fix the failing tests"

# Fresh task (from file)
node src/cli.js --workspace ./my-project --task-file task.txt

# Markdown task file (copied into .agent/ as reference)
node src/cli.js --workspace ./my-project --task-file instructions.md

# Resume after crash or server restart
node src/cli.js --workspace ./my-project --resume

# Dry run (show config, don't execute)
node src/cli.js --workspace ./my-project --task "..." --dry-run
```

## Running Tests

```bash
# Parser test suite (57 tests, no API key needed)
node --test tests/parseAction.test.js

# Full test suite (190+ tests)
node --test tests/parseAction.test.js tests/edge-to-edge.test.js

# Tetris smoke test (run from repo root)
python3 _smoke_test.py

# Snake smoke test (run from snake-ws/)
cd snake-ws && python3 _smoke_test.py
```

## Test Implementations

The loop has been pressure-tested through two complete game implementations. These live in the repo as evidence of multi-step autonomous runs:

| Folder | Task | Status | Tests |
|--------|------|--------|-------|
| `tetris/` | 3-phase Tetris (core + optimizations + leaderboard) | Complete | `_smoke_test.py` (root) |
| `snake-ws/` | 4-phase Snake (core + AI solver + leaderboard + replay) | Complete | `snake-ws/_smoke_test.py` |

**Tetris** (`tetris/`): 9 files — `config.py`, `piece.py`, `board.py`, `game.py`, `renderer.py`, `leaderboard.py`, `main.py`, `__init__.py`, `perf_notes.txt`. Includes ghost caching, dirty-cell rendering, and pre-computed line-clear candidates.

**Snake** (`snake-ws/snake/`): 8 files — `config.py`, `direction.py`, `snake.py`, `food.py`, `board.py`, `game.py`, `main.py`, `__init__.py`. Hamiltonian-path AI solver, replay recording, and leaderboard with date column.

---

## Configuration

All values have sensible defaults, can be overridden via environment variables, and are auto-scaled from the model's `max_model_len` at startup.

| Env var | Default | Purpose |
|---------|---------|---------|
| `AGENT_API_KEY` / `OPENAI_API_KEY` | — | API key (required unless server allows anonymous) |
| `AGENT_BASE_URL` / `OPENAI_BASE_URL` | `http://localhost:8000/v1` | LLM endpoint |
| `AGENT_MODEL` / `OPENAI_MODEL` | `gpt-oss-120b` | Model ID |
| `AGENT_CONTEXT_WINDOW` | auto-detected | Token context limit (overrides auto-detect) |
| `AGENT_MAX_OUTPUT` | auto-scaled | Max output tokens |
| `AGENT_MAX_STEPS` | `0` (unlimited) | Hard step cap |
| `AGENT_MEMORY_WINDOW` | auto-scaled | Working memory window (steps) |
| `AGENT_COMPACT_THRESHOLD` | auto-scaled | Chars before compaction triggers |
| `AGENT_COMPACT_INTERVAL` | auto-scaled | Steps between compaction checks |
| `AGENT_TEMPERATURE` | profile-based | Model temperature |
| `AGENT_MAX_ERRORS` | `8` | Consecutive errors before termination |
| `AGENT_ENABLE_STAGES` | `true` | Enable/disable stage-based execution |
| `AGENT_PROFILE` | auto-matched | Force a specific model profile |

### Model Profiles (auto-matched from model ID)

| Profile | Context | Output | Temperature | Notes |
|---------|---------|--------|-------------|-------|
| `gpt-oss-120b` | 32k | 6144 | 0.15 | Best reasoning + JSON discipline |
| `minimax-m2.1-reap` | 16k | 2949 | 0.20 | Good reasoning, limited context |
| `qwen2.5-coder-32b` | 32k | 4096 | 0.10 | Code-specialized, strong JSON |
| `qwen3-coder-30b` | 16k | 2949 | 0.10 | Best local (1-3s/step, requires `AGENT_NO_THINKING=1`) |
| `qwen3-30b` | 32k | 4096 | 0.20 | MoE, fast inference (requires `AGENT_NO_THINKING=1`) |
| `qwen3-8b` | 32k | 2048 | 0.20 | Smallest local model (limited reasoning) |
| `claude` | 200k | 8192 | 0.10 | Best overall (API cost) |
| `gpt-4o` | 128k | 4096 | 0.10 | Good all-around (API cost) |

---

## Key Design Principles

1. **Rebuild from files, not memory** — context is assembled from `.agent/*.md` on every step; the LLM never holds state between calls.

2. **Fail safely** — every tool handler wraps its logic in try/catch; errors are returned as strings, never thrown to the loop.

3. **Persist aggressively** — checkpoint after every step; `--resume` recovers instantly from any crash.

4. **Route to focus** — the routing layer caps tools at 4 per step, reducing prompt entropy on small models without limiting capability.

5. **Stage-gated execution** — 6-phase lifecycle prevents premature finishing and enforces verification before completion.

6. **No framework** — no LangChain, no LlamaIndex, no graph. Just a while-loop, file I/O, and fetch. The simplest thing that works.



