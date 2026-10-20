# Kairos — User Manual

> Everything you need to run tasks, read the TUI, and control the agent.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [First-time Setup](#2-first-time-setup)
3. [Starting Kairos](#3-starting-kairos)
4. [The TUI at a Glance](#4-the-tui-at-a-glance)
5. [Sending Your First Prompt](#5-sending-your-first-prompt)
6. [Steering the Agent Mid-Run](#6-steering-the-agent-mid-run)
7. [All Keyboard Shortcuts](#7-all-keyboard-shortcuts)
8. [All Slash Commands](#8-all-slash-commands)
9. [Changing Model / Server](#9-changing-model--server)
10. [The Four Views](#10-the-four-views)
11. [HITL — Human-in-the-Loop Approvals](#11-hitl--human-in-the-loop-approvals)
12. [Pausing and Resuming](#12-pausing-and-resuming)
13. [Quitting](#13-quitting)
14. [Common Errors and Fixes](#14-common-errors-and-fixes)
15. [Environment Variables Reference](#15-environment-variables-reference)

---

## 1. Prerequisites

| Requirement | Version | Check |
|------------|---------|-------|
| Node.js | 18 or higher | `node --version` |
| LLM server | OpenAI-compatible (`/v1/chat/completions`) | vLLM, Ollama, LM Studio, OpenAI API |
| Terminal | Any — works best 120×30 or larger | |

The agent and TUI are in:
```
Advanced-agent-loop4/
```
Run all commands from inside this directory.

---

## 2. First-time Setup

### Step 1 — Make kairos executable

```bash
chmod +x kairos
```

### Step 2 — Configure your LLM server

Open the TUI settings by running:
```bash
./kairos
```
This opens the TUI in **launcher mode**. Press `/` then type `settings` and press Enter.

Or set it directly via environment variables (see [Section 15](#15-environment-variables-reference)).

### Step 3 — Fix WSL2 networking (if your LLM is on another machine)

If your vLLM server is on a LAN machine like `10.17.x.x` and you're running from WSL2:

**Option A — Mirrored Networking (Windows 11, permanent fix):**
```
# In Windows, create or edit: C:\Users\<you>\.wslconfig
[wsl2]
networkingMode=mirrored
```
Then in PowerShell: `wsl --shutdown`, then reopen your terminal.

**Option B — SSH tunnel (any Windows version):**
```bash
ssh -L 8000:10.17.0.225:8000 user@10.17.0.225
# Then set your server URL to: http://localhost:8000/v1
```

**Option C — Run kairos from Windows PowerShell directly** (no WSL2 networking issues).

> Kairos will tell you exactly which fix to use if it can't reach the server — it checks before starting.

---

## 3. Starting Kairos

### Method A — Type task in terminal (most common)

```bash
./kairos "Explain the CUDA kernel launch pipeline for matrix multiply"
```

What happens:
1. Kairos checks LLM is reachable — exits immediately with instructions if not
2. Agent starts in background, SSE server starts on port 5180
3. TUI opens automatically and connects
4. Dots print while waiting for the server: `....`
5. TUI shows **RUNNING** and the live step feed begins

### Method B — Open TUI first, type task inside

```bash
./kairos
```

The splash screen appears with the KAIROS logo. Type your task and press **Enter**. The agent spawns and the TUI connects automatically.

### Method C — Resume a previous session

```bash
./kairos --resume
```

Continues from `.agent/checkpoint.json` (the agent's last saved state).

### Method D — Task from a file

```bash
./kairos --task-file my-task.txt
```

---

## 4. The TUI at a Glance

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ KAIROS │ ● RUNNING  ep-a3f9b12  Step 7  stage:execution  $0.002  p95: 2.1s │
├──── STEPS ──────────────┬──── OUTPUT ───────────────┬──── INFO ─────────────┤
│ ✔  1  read_file         │ > Step 7: bash_exec        │ ▸ TASK                │
│    src/main.py          │                            │   Explain CUDA kernel │
│ ✔  2  bash_exec         │  [1] Running tests...      │ ▸ STAGE               │
│    pytest tests/        │  ✓ 12 passing              │   execution           │
│ ✔  3  write_file        │                            │ ▸ MODEL               │
│    src/utils.py         │                            │   qwen3               │
│ ⠸  7  bash_exec         │                            │ ▸ MEMORY              │
│    pytest tests/        │                            │   4 events            │
├─────────────────────────┴────────────────────────────┴───────────────────────┤
│ > type a command or /help                                                     │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Header bar** — Status (RUNNING/PAUSED/DONE/ERROR), step number, stage, cost, latency.

**STEPS panel (left)** — Every tool call the agent has made. Spinner `⠸` = currently running. `✔` = done. `✗` = errored.

**OUTPUT panel (center)** — Result of the selected/active step. Scrollable.

**INFO panel (right)** — Current task, stage, model, memory event count.

**Command bar (bottom)** — Always-active input. Type `/` to autocomplete commands or type text to steer.

---

## 5. Sending Your First Prompt

### From the terminal

```bash
./kairos "Refactor src/utils.py to use dataclasses instead of dicts"
```

The task is passed directly to the agent. Watch it run in the TUI.

### From inside the TUI (launcher mode)

Run `./kairos` with no arguments. On the splash screen, type your task and press **Enter**.

### From inside the TUI when agent is already running

Type your message in the command bar at the bottom and press **Enter**. This sends a **steering message** to redirect the running agent.

> **Note:** Steering adds your message as `[HUMAN STEERING]: your message` into the agent's next context. The agent reads it at the start of the next step and can change direction.

---

## 6. Steering the Agent Mid-Run

Steering lets you redirect, correct, or guide the agent while it's working — without stopping it.

### Method 1 — Type in the command bar

Just type directly (no `/` prefix) and press **Enter**:
```
focus only on the auth module for now, skip the DB changes
```

### Method 2 — `/steer` command

```
/steer rewrite using async/await, not callbacks
```

### Method 3 — `S` hotkey

Press **S** from anywhere in the TUI. An overlay opens:
- Type your message
- Press **Enter** to send, **Esc** to cancel

### What the agent receives

Your message is injected into the next step as:
```
[HUMAN STEERING]: focus only on the auth module for now, skip the DB changes
```
The agent reads this before deciding its next action.

---

## 7. All Keyboard Shortcuts

### Global (work from any view)

| Key | Action |
|-----|--------|
| `1` or `F1` | Switch to Live view |
| `2` or `F2` | Switch to HITL view |
| `3` or `F3` | Switch to Memory view |
| `4` or `F4` | Switch to Metrics view |
| `S` | Open steer overlay (send message to agent) |
| `P` | Pause agent (press again to resume) |
| `M` | Open model picker |
| `?` | Toggle keyboard help overlay |
| `Q` or `Ctrl+C` | Quit TUI (agent keeps running in background) |
| `/` | Start a slash command in the command bar |

### Live View (view 1)

| Key | Action |
|-----|--------|
| `↑` / `↓` | Scroll steps list up/down |
| `Enter` | Pin selected step (lock output panel to it) |
| `Esc` | Unpin (return to live step) |
| `PgUp` / `PgDn` | Scroll output panel 10 lines |
| `End` | Jump to live output (stop scrolling) |
| `Home` | Jump to top of steps |

### HITL View (view 2)

| Key | Action |
|-----|--------|
| `A` | Approve the current pending action |
| `D` | Deny — opens deny reason input |
| `←` / `→` | Cycle through multiple pending requests |
| `Esc` | Return to Live view |

### Memory View (view 3)

| Key | Action |
|-----|--------|
| `T` | Temporal mode (chronological events) |
| `R` | Rooms mode (grouped by path/domain) |
| `F` | Search mode |
| `Tab` | Switch focus between Events / Skills / Reflections panels |
| `↑` / `↓` | Scroll |

### Metrics View (view 4)

| Key | Action |
|-----|--------|
| `E` | Export metrics to `.agent/tui-export.json` |

### Settings Overlay

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate fields |
| `Enter` | Edit selected field (or cycle Provider) |
| `Backspace` | Delete character while editing |
| `H` | Show/hide API key |
| `Esc` | Close settings (saves automatically) |

---

## 8. All Slash Commands

Type `/` in the command bar to see autocomplete suggestions. Press **Tab** to cycle, **Enter** to run.

| Command | What it does |
|---------|-------------|
| `/live` | Switch to Live view |
| `/hitl` | Switch to HITL view |
| `/memory` | Switch to Memory view |
| `/metrics` | Switch to Metrics view |
| `/run <task>` | Start a new agent with this task (launcher mode) |
| `/steer <text>` | Send steering message to running agent |
| `/pause` | Pause the agent |
| `/resume` | Resume a paused agent |
| `/model` | Open model picker |
| `/model <name>` | Switch to a specific model immediately |
| `/settings` | Open settings overlay |
| `/apikey <key>` | Set API key directly |
| `/clear` | Clear step history display |
| `/status` | Show a toast with current status/cost |
| `/export` | Export metrics to JSON |
| `/reconnect` | Reconnect TUI to agent SSE server |
| `/help` | Show keyboard reference overlay |
| `/quit` | Exit TUI |

---

## 9. Changing Model / Server

### From the TUI

1. Press **M** or type `/model` — opens the model picker
2. Use `↑` / `↓` to select, `Enter` to confirm
3. Or type `/model qwen3` to switch directly

To change the **server URL** or **API key**:
- Type `/settings`, navigate to the field, press `Enter` to edit

Settings are saved automatically to `.agent/tui-settings.json` and loaded next time.

### From the terminal before starting

```bash
AGENT_MODEL=qwen3 AGENT_BASE_URL=http://localhost:8000/v1 ./kairos "your task"
```

### Add a custom model

In the model picker, press `N` to open the "Add Custom Model" form. Fill in:
- **Model ID** — exact model name the server expects (e.g. `qwen3-instruct`)
- **Display name** — label shown in picker
- **Endpoint** — full URL if different from the saved server URL
- **Provider** — `vllm`, `ollama`, `openai`, or `anthropic`

Press `S` or navigate to Save and press `Enter`.

---

## 10. The Four Views

### View 1 — Live (default)

Three-panel view: steps on the left, output in the center, session info on the right.

- **Steps** shows every tool call. The spinner `⠋⠙⠹` on the top item means it's the current step.
- **Output** auto-follows the latest step. Pin a step with `Enter` to inspect it — the output freezes on that step until you unpin with `Esc`.
- **Info** shows task, stage, model, and memory event count.

### View 2 — HITL (Human-in-the-Loop)

Appears automatically when the agent requests approval for a dangerous action (file deletion, shell command, etc.). Shows:
- Tool name and arguments
- Agent's reasoning
- Time remaining before it auto-times out
- `A` to approve, `D` to deny with a reason

### View 3 — Memory

The agent's persistent memory across sessions. Three panels:
- **Events** — every memory-worthy action (tool calls, discoveries, errors)
- **Skills** — reusable skill files the agent has created for itself (`.agent/skills/`)
- **Reflections** — post-session summaries with scores

Use `T` / `R` / `F` to switch modes. `Tab` to move between the three panels.

### View 4 — Metrics

Counters for the current session:
- Steps, cost, tokens
- Error count, hallucinations detected
- Compaction events, HITL approval/denial counts
- p50/p95 latency

Press `E` to export everything to `.agent/tui-export.json`.

---

## 11. HITL — Human-in-the-Loop Approvals

HITL is **off by default**. Enable it if you want the agent to ask for approval before taking actions.

### Enable HITL

```bash
AGENT_HITL_REQUIRED=1 ./kairos "your task"
```

When enabled, the agent pauses before each tool call and waits for your approval. The TUI switches to view 2 automatically and shows a badge: `HITL N pending [2]` in the header.

### Approve / Deny

- Press `A` to approve — the agent continues
- Press `D` to open the deny input, type a reason (optional), press `Enter` — the agent skips the action and continues with your reason in context

### Without HITL

Steering still works (you can redirect a running agent anytime). HITL is only needed if you want to approve every individual tool call.

---

## 12. Pausing and Resuming

**Pause** — press `P` while the agent is running. The current step finishes, then the agent holds until you resume.

**Resume** — press `P` again (toggles). Or type `/resume`.

The header shows `● PAUSED` in yellow when paused. The agent will not start new steps but the TUI stays connected and responsive.

---

## 13. Quitting

| Action | Key | What happens to the agent |
|--------|-----|---------------------------|
| Quit TUI only | `Q` | Agent keeps running in background |
| Kill both | `Ctrl+C` | TUI exits and kills agent process |
| Quit via command | `/quit` | Same as `Q` |

After pressing `Q`:
```
TUI closed. Agent still running in background (pid 12345).
  Log : .agent/kairos.log
  Stop: kill 12345
  Reconnect: node apps/tui/index.js --port 5180
```

To reconnect to a running agent:
```bash
node apps/tui/index.js --port 5180
```

---

## 14. Common Errors and Fixes

### "Cannot reach LLM server"

```
ERROR: Cannot reach LLM server at http://10.17.0.225:8000/v1
```

You're on WSL2 and the LLM is on another LAN machine. See [Section 2 Step 3](#step-3--fix-wsl2-networking-if-your-llm-is-on-another-machine).

### "Agent exited before TUI could connect"

The agent crashed immediately. Read the log:
```bash
tail -30 .agent/kairos.log
```
Common causes: wrong server URL, missing model, disk full.

### TUI shows "DISCONNECTED" and won't connect

The SSE server (port 5180) isn't running. Either:
- The agent is not started yet — run `./kairos "task"`
- The agent crashed — check `.agent/kairos.log`
- Port conflict — try `AGENT_HITL_WEB_PORT=5181 ./kairos "task"`

To reconnect manually once the agent is running:
```
/reconnect
```

### Agent runs but shows "LLM error: fetch failed" repeatedly

The agent started but can't reach the LLM mid-run. Check:
1. Is the vLLM server still running on the other machine?
2. Did your WSL2 session restart (losing tunnel/routing)?
3. Run `nc -z 10.17.0.225 8000` to confirm reachability

### "steering message sent" but agent doesn't change direction

This was a known bug — now fixed. If you see it on an old version, update and the steering gate is removed.

### TUI opens but shows garbage / broken borders

Your terminal likely doesn't support Unicode box drawing. Set `TERM=xterm-256color` before running, or use a modern terminal (Windows Terminal, iTerm2, Alacritty).

---

## 15. Environment Variables Reference

All variables can be set before running kairos, or saved via `/settings` in the TUI.

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_BASE_URL` | `http://localhost:11434/v1` | LLM server URL (OpenAI-compatible) |
| `AGENT_MODEL` | `qwen2.5-coder:32b` | Model name |
| `AGENT_API_KEY` | `ollama` | API key (use `EMPTY` for local servers that require a placeholder) |
| `AGENT_PROVIDER` | `ollama` | `ollama` / `vllm` / `openai` / `anthropic` |
| `AGENT_NO_THINKING` | (auto) | Set to `1` to disable thinking tokens (Qwen3 models set this automatically) |
| `AGENT_TEMPERATURE` | `0.1` | LLM sampling temperature |
| `AGENT_MAX_STEPS` | `0` (unlimited) | Hard stop after N steps |
| `AGENT_MAX_ERRORS` | `3` | Stop after N consecutive errors |
| `AGENT_CONTEXT_WINDOW` | `16384` | Context window size in tokens |
| `AGENT_HITL_REQUIRED` | `0` | Set to `1` to require approval before each tool call |
| `AGENT_HITL_WEB_PORT` | `5180` | Port for SSE server (TUI connection) |
| `AGENT_LLM_TIMEOUT_MS` | `120000` | Per-request LLM timeout in ms |
| `AGENT_WORKSPACE` | current dir | Project directory the agent works in |

### Quick example — connecting to a local Ollama server

```bash
export AGENT_BASE_URL="http://localhost:11434/v1"
export AGENT_MODEL="llama3.1:8b"
export AGENT_API_KEY="ollama"
./kairos "Summarise the README"
```

### Quick example — connecting to OpenAI

```bash
export AGENT_BASE_URL="https://api.openai.com/v1"
export AGENT_MODEL="gpt-4o"
export AGENT_API_KEY="sk-..."
export AGENT_PROVIDER="openai"
./kairos "Write unit tests for src/auth.js"
```

### Quick example — your current vLLM server (after fixing WSL2 routing)

```bash
export AGENT_BASE_URL="http://10.17.0.225:8000/v1"
export AGENT_MODEL="qwen3"
export AGENT_API_KEY="EMPTY"
export AGENT_PROVIDER="vllm"
./kairos "Explain the CUDA kernel launch pipeline for matrix multiply"
```

---

## Quick-Reference Card

```
START         ./kairos "task"              Run task (terminal)
              ./kairos                     Open TUI, type task inside

VIEWS         1/F1  Live    2/F2  HITL    3/F3  Memory    4/F4  Metrics

STEER         S or type text in command bar → Enter

PAUSE/RESUME  P

QUIT TUI      Q   (agent keeps running)
KILL ALL      Ctrl+C

COMMANDS      /steer <msg>    /pause    /resume    /model    /settings
              /run <task>     /clear    /export    /reconnect

RECONNECT     node apps/tui/index.js --port 5180
```
