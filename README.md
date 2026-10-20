# Advanced Agent Loop

A production-oriented autonomous agent framework that runs for hundreds of steps without a framework. No LangChain, no LlamaIndex, no graph runtime — just a while-loop, file I/O, and fetch.

Built to work with any OpenAI-compatible LLM endpoint (vLLM, Ollama, OpenAI, Anthropic).

## Quick Start

You only need **3 environment variables** to run — everything else auto-detects and auto-scales:

```bash
# Clone (zero npm dependencies — just Node.js 18+)
git clone <repo-url>
cd Advanced-agent-loop

# Set your LLM endpoint (any OpenAI-compatible server: vLLM, Ollama, OpenAI, etc.)
export OPENAI_BASE_URL="http://your-llm-server:8000/v1"
export OPENAI_MODEL="your-model-id"
export AGENT_API_KEY="your-key"

# Run with a task
node src/cli.js --workspace ./my-project --task "Build a REST API with Express"

# Run with a task file
node src/cli.js --workspace ./my-project --task-file instructions.md

# Resume after crash or server restart
node src/cli.js --workspace ./my-project --resume

# Dry run (show config without executing)
node src/cli.js --workspace ./my-project --task "..." --dry-run
```

That's it. The agent auto-detects the model's context window from the server and scales all memory, compaction, and output parameters accordingly. No need to edit any source files.

A `.env.example` file is included for reference — copy it to `.env` if you prefer file-based config.

---

## How It Works

Each step, the agent:

1. Builds a structured prompt from files (not conversation history)
2. Calls the LLM, which returns one JSON action: `{"thought":"...", "tool":"read_file", "args":{"path":"x.js"}}`
3. Executes the tool and records the result
4. Checkpoints state to disk (crash-safe)
5. Repeats until `finish` or budget exhausted

The LLM never holds state between calls. Context is rebuilt from `.agent/*.md` files every step. Whether you're on step 5 or step 500, the prompt is the same size — only the compacted summary grows denser.

---

## Architecture

```
src/
  cli.js            Entry point, auto-detect, bootstrap
  loop.js           Main execution loop + JSON parser + anti-stall guards
  context.js        5-layer context assembly (identity, knowledge, state, session, guidance)
  config.js         Centralized config with model profiles and env var overrides
  llm.js            LLM API calls with retry and exponential backoff
  stages.js         6-phase execution lifecycle (intake → finalization)
  memory.js         Working memory (sliding window of recent steps)
  compaction.js     LLM-assisted summarization of old memory
  memory-store.js   Persistent memory logs (daily rotation)
  state.js          File I/O for checkpoint, progress, task state
  identity.js       Bootstrap SOUL.md, AGENTS.md, USER.md, MEMORY.md
  plan.js           Plan parsing and subtask tracking
  skills.js         Dynamic skill system (agent creates its own tools)
  sandbox-verifier.js  3-source task completion verifier (diff + action log + spot-checks)
  tools/
    filesystem/     read_file, write_file, edit_file, list_dir, search_files, glob, patch
    execution/      run_command, webfetch, websearch, lsp
    planning/       update_plan, add_learning, think, finish, todowrite, todoread
    memory/         save_memory, search_memory, update_memory
    identity/       update_identity
    skills/         create_skill
    utils/          truncation, contract validation, guidance helpers
  routing/
    toolRegistry.js Tool definitions, categories, alias resolution
    router.js       Keyword + rule scoring (no LLM, pure logic)
    toolManager.js  Tool exposure (max 4 per step), freeze mode
    loopController.js Testable loop with injectable LLM
```

### Key Systems

**5-Layer Context Assembly** — The prompt is built from files, not history:

| Layer | Source | Purpose |
|-------|--------|---------|
| Identity | `SOUL.md`, `AGENTS.md` | Who the agent is, operating rules |
| Knowledge | Task file, `MEMORY.md`, learnings | What it knows |
| State | `plan.md`, `context-summary.md`, focus chain | Where it is |
| Session | Working memory (last N steps) | What just happened |
| Guidance | Runtime hints, error feedback, stage gates | What to do next |

**Stage-Based Execution** — 6-phase lifecycle with tool gates:

```
intake → discovery → planning → execution → verification → finalization
```

Each stage controls which tools are available and what conditions must be met to advance. The system parses required files from the task description and tracks their creation.

**Multi-Pass JSON Parser** — Handles messy model output:

1. Direct `JSON.parse`
2. Conservative repair (close missing `}` / `]`)
3. Extract JSON from prose/mixed text
4. Unwrap markdown fences
5. Parse XML tool calls (MiniMax models)
6. Classify failure type for targeted recovery feedback

**Crash Recovery** — `checkpoint.json` is written after every step. Resume with `--resume` to continue from the exact point of interruption — no re-planning, no lost work.

---

## Configuration

### Environment Variables

**Required (minimum to run):**

| Variable | Description |
|----------|-------------|
| `OPENAI_BASE_URL` | LLM API endpoint (e.g. `http://your-vllm:8000/v1`) |
| `OPENAI_MODEL` | Model ID as it appears on your server |
| `AGENT_API_KEY` | API key (also accepts `OPENAI_API_KEY`; leave empty if server has no auth) |

**Optional (all have sensible defaults — only set if you need to override):**

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_CONTEXT_WINDOW` | auto-detected from server | Override context window (tokens) |
| `AGENT_MAX_OUTPUT` | auto-scaled | Max output tokens per step |
| `AGENT_TEMPERATURE` | `0.2` (or profile-based) | Model temperature |
| `AGENT_MAX_STEPS` | `0` (unlimited) | Hard step limit |
| `AGENT_MEMORY_WINDOW` | auto-scaled | Steps kept in working memory |
| `AGENT_COMPACT_THRESHOLD` | auto-scaled | Char threshold for compaction |
| `AGENT_COMPACT_INTERVAL` | auto-scaled | Steps between compaction checks |
| `AGENT_MAX_ERRORS` | `8` | Consecutive errors before termination |
| `AGENT_ENABLE_STAGES` | `true` | Enable/disable 6-phase stage system |
| `AGENT_REQUIRE_SMOKE_TEST` | `true` | Require smoke test before finish (set `false` for chatbot/non-build tasks) |
| `AGENT_ALLOWED_COMMANDS` | — | Extra shell command prefixes to allow (comma-separated) |
| `AGENT_NO_THINKING` | — | Set `1` to suppress thinking tokens (needed for Qwen3, some MiniMax models) |

**Config priority:** env var (highest) > auto-detect from server > model profile > hardcoded fallback

### Model Profiles

Profiles are auto-matched from the model ID. Override with `AGENT_PROFILE`:

| Profile | Context | Max Output | Temp | Best For |
|---------|---------|------------|------|----------|
| `gpt-oss-120b` | 32k | 6144 | 0.15 | Multi-file projects, complex reasoning |
| `minimax-m2.1-reap` | 16k | 2949 | 0.20 | Reasoning tasks, limited context |
| `qwen2.5-coder-32b` | 32k | 4096 | 0.10 | Pure coding tasks |
| `qwen3-coder-30b` | 16k | 2949 | 0.10 | Best local model (1-3s/step); set `AGENT_NO_THINKING=1` |
| `qwen3-30b` | 32k | 4096 | 0.20 | Fast MoE inference; set `AGENT_NO_THINKING=1` |
| `qwen3-8b` | 32k | 2048 | 0.20 | Smallest local option (limited reasoning) |
| `claude` | 200k | 8192 | 0.10 | Best overall (API) |
| `gpt-4o` | 128k | 4096 | 0.10 | General purpose (API) |

### Auto-Scaling

At startup, `cli.js` queries `/v1/models` to read the model's `max_model_len`, then scales:

- `contextWindow` = detected value
- `maxOutputTokens` = proportional (capped at 8192)
- `workingMemoryWindow` = proportional (7–50 steps)
- `compactionThresholdChars` = proportional
- `compactionIntervalSteps` = proportional (7–30)

All auto-scaled values can be overridden by their env vars.

---

## Using as a Plugin / Integrating into Your Own Agent

This system is designed to be modular. Here's how to adapt it:

### Swap the LLM Backend

Just set the 3 required environment variables — no source file editing needed:

```bash
# Any OpenAI-compatible endpoint works
OPENAI_BASE_URL="http://localhost:11434/v1"  # Ollama
OPENAI_MODEL="llama3"
AGENT_API_KEY=""                              # empty if no auth required
```

The context window and output limits are auto-detected from the server at startup. If your model's name matches a known profile (e.g. contains "qwen3", "claude", "gpt-4o"), tuned temperature and output limits are applied automatically.

Optionally, you can add a new model profile in `src/config.js` under `MODEL_PROFILES` to fine-tune defaults for your specific model — but this is not required.

### Add Custom Tools

Create a new file in the appropriate `src/tools/` subdirectory:

```javascript
// src/tools/filesystem/my_tool.js
export default {
  name: 'my_tool',
  description: 'Does something useful',
  parameters: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'The input' }
    },
    required: ['input']
  },
  handler: async ({ input }, { workspace }) => {
    // Your logic here
    return `Result: ${input}`;
  }
};
```

Then register it in `src/tools/index.js` and add it to a category in `src/routing/toolRegistry.js`.

### Customize the Identity Layer

The agent bootstraps 4 markdown files in each workspace:

| File | Purpose | Customize For |
|------|---------|---------------|
| `SOUL.md` | Agent persona, boundaries, core truths | Changing the agent's personality or constraints |
| `AGENTS.md` | Operating protocol, startup ritual, error recovery rules | Modifying how the agent plans and recovers |
| `USER.md` | User profile, preferences | Setting user context before a run |
| `MEMORY.md` | Curated long-term knowledge | Pre-loading knowledge about a project |

Edit the templates in `src/identity.js` to change defaults, or create these files in your workspace before running — the agent won't overwrite them.

### Modify the Stage System

The 6-phase lifecycle is defined in `src/stages.js`:

- **`STAGE_ORDER`** — change the phase sequence
- **`shouldAdvanceStage()`** — change advancement conditions per stage
- **`filterToolsByStage()`** — change which tools are available per stage
- **`parseLockedTargets()`** — change how required files are detected from the task
- **`parseRequiredCommands()`** — change how verification commands are extracted

Disable stages entirely with `AGENT_ENABLE_STAGES=false`.

### Use the Loop Programmatically

```javascript
import { runLoop } from './src/loop.js';
import { setWorkspace } from './src/state.js';
import { setLLMLogDir } from './src/llm.js';

setWorkspace('/path/to/workspace');
setLLMLogDir('/path/to/workspace');
const result = await runLoop({
  task: 'Build a CLI tool',
  workspace: '/path/to/workspace',
  resume: false,
  onStep: (step, action, toolResult) => {
    console.log(`Step ${step}: ${action.tool}`);
  },
});
// result = { exitReason, summary, totalSteps, totalCharsUsed, compactionCount, memoriesFlushed, skillsCreated }
```

### Customize Context Assembly

Edit `src/context.js` to change what the LLM sees:

- **`buildMessages()`** — main entry, assembles all 5 layers
- **Layer injection points** — add your own sections to identity, knowledge, state, session, or guidance layers
- **Task truncation** — controlled by `AGENT_MAX_TASK_CHARS` env var

### Customize Compaction

Edit `src/compaction.js`:

- **`compactContext()`** — the main compaction function
- **`buildFallbackSummary()`** — local summarization when the LLM is unavailable
- **Threshold tuning** — `AGENT_COMPACT_THRESHOLD` and `AGENT_COMPACT_INTERVAL`

---

## Workspace State

Each workspace gets an `.agent/` directory (gitignored) containing:

```
.agent/
  checkpoint.json       Step counter, working memory, stage state, error streaks
  task.md               Original task
  plan.md               Living plan (agent-maintained, checklist format)
  progress.md           Step-by-step execution log with timestamps
  context-summary.md    Compacted history (grows incrementally)
  focus-chain.md        Human-editable priority steering
  learnings.md          Agent-extracted notes about the project
  memory/
    YYYY-MM-DD.md       Daily memory logs
    files-touched.json  File read/write tracking
    commands-run.json   Shell command history + exit codes
    recovery-events.json Recovery actions taken by the loop
  skills/
    *.md                Agent-created reusable tool definitions
```

All of these are human-readable markdown or JSON. You can inspect, edit, or pre-populate them before a run.

---

## Testing

```bash
# Full test suite (190+ tests, no API key needed)
node --test tests/parseAction.test.js tests/edge-to-edge.test.js

# Parser suite only (57 tests)
node --test tests/parseAction.test.js

# Tetris smoke test (run from repo root)
python3 _smoke_test.py

# Snake smoke test
cd snake-ws && python3 _smoke_test.py
```

Tests cover: JSON parsing (plain, fenced, prose+JSON, thinking blocks, truncated repair, XML tool calls, error classification, file content with backticks/special characters), working memory, compaction, routing, tool execution, security (path traversal, command injection, sandbox escape), stage system, and context assembly.

### Test Implementations (End-to-End Runs)

Two complete game implementations were built by the agent loop and live in the repo as evidence of stable multi-step autonomous runs:

| Folder | Task | Description |
|--------|------|-------------|
| `tetris/` | 3-phase Tetris | Core game + ghost caching + dirty-cell rendering + leaderboard |
| `snake-ws/` | 4-phase Snake | Core game + Hamiltonian AI solver + replay recording + leaderboard |

Both include identity-layer files (`SOUL.md`, `AGENTS.md`, `USER.md`, `MEMORY.md`) that were created and maintained by the agent during the run.

---

## Documentation

| File | Description |
|------|-------------|
| [WORKFLOW.md](WORKFLOW.md) | Step-by-step walkthrough of the entire loop |
| [SANDBOX.md](SANDBOX.md) | Sandbox verifier — detailed implementation flow and decision logic |
| [DESIGN.md](DESIGN.md) | Architecture blueprint, research findings, design decisions |
| [PROJECT_CHARTER.md](PROJECT_CHARTER.md) | Project objectives, scope, milestones |
| [RESEARCH_REPORT.md](RESEARCH_REPORT.md) | OpenClaw/OpenDevin/Cline comparative research |
| [AGENTS.md](AGENTS.md) | Operating protocol (used by the agent at runtime) |
| [SOUL.md](SOUL.md) | Agent identity definition |
| [fixed-bugs.md](fixed-bugs.md) | Detailed bug fix history with code context |

---

## Requirements

- **Node.js 18+** (uses native `fetch`, `node:test`, `node:child_process`)
- **Any OpenAI-compatible LLM endpoint** — vLLM, Ollama, OpenAI API, Anthropic (via proxy), LiteLLM, etc.
- **Zero npm dependencies** — runs on Node.js standard library only
- The model must be able to return JSON tool calls in the format: `{"thought":"...","tool":"...","args":{...}}`
