# Kairos TUI — Complete User Manual

## What This Is

The Kairos TUI is a full-screen terminal interface for the Kairos agent loop.
It connects to the agent over a local SSE (Server-Sent Events) port and lets
you watch the agent work in real time, approve or deny tool calls, inspect
memory, review metrics, change models, and steer the agent mid-task — all
without leaving the terminal.

---

## Quick Start: Your vLLM Setup

Your model server is running at `http://10.17.0.225:8000/v1` with model `qwen3`.
This is a **vLLM** server. Here is the exact sequence to get connected.

### Step 1 — Configure the endpoint

Open the TUI first (even before starting an agent run):

```bash
kairos
```

The TUI opens and shows `● DISCONNECTED` in the header — that is normal before
an agent is running.

### Step 2 — Open Settings

Press **`,`** (comma) to open the Settings panel. You will see:

```
╔════════════════════════════ SETTINGS ═══════════════════════════════════╗
║  Live config. Saved to .agent/tui-settings.json.  [H] show key         ║
║                                                                         ║
║  ── CONNECTION ──────────────────────────────────────────────────────── ║
║    Server URL    (none)                                                 ║
║    API Key       (none)                                                 ║
║    Provider      ollama                                                 ║
║                                                                         ║
║  ── MODEL ───────────────────────────────────────────────────────────── ║
║    Model         (none)  → picker                                       ║
║  ...                                                                    ║
╚═════════════════════════════════════════════════════════════════════════╝
```

### Step 3 — Set Server URL

1. Use **↑ ↓** to select **Server URL**
2. Press **Enter** — the field opens for editing
3. Type `http://10.17.0.225:8000/v1`
4. Press **Enter** to save

The value is immediately written to `.agent/tui-settings.json`.

### Step 4 — Set Provider

1. Navigate down to **Provider** (shows `ollama` by default)
2. Press **Enter** repeatedly to cycle through: `ollama → vllm → openai → anthropic → custom`
3. Stop when it shows **`vllm`**

No Enter to "confirm" — cycling saves automatically.

### Step 5 — Set API Key

vLLM does not require a real API key but the client still sends one.
Use any non-empty string — `"EMPTY"` is the vLLM convention:

1. Navigate to **API Key**
2. Press **Enter** to edit
3. Type `EMPTY`
4. Press **Enter** to save

> **Note:** Press **H** at any time in the Settings panel to reveal or hide the
> API key field. It shows as `●●●●●●●●` by default.

### Step 6 — Add the qwen3 model

The built-in model list does not include your specific model name. Add it:

1. Press **Esc** to close Settings
2. Press **M** (uppercase) to open the Model Picker
3. Press **A** to open "Add Custom Model"

You will see:

```
╔═══════════════════════ ADD CUSTOM MODEL ════════════════════════════╗
║  Add a model from any OpenAI-compatible endpoint.                   ║
║                                                                     ║
║ >  Model ID       * e.g. llama3.1:8b                               ║
║    Display Name   optional — defaults to Model ID                  ║
║    Endpoint       optional — overrides global Server URL           ║
║    Provider       ollama  [Enter/Tab] cycle                        ║
║                                                                     ║
║    [ Add Model ]   * required   [Esc] Cancel                       ║
╚═════════════════════════════════════════════════════════════════════╝
```

4. Press **Enter** on **Model ID** and type `qwen3`, then press **Enter**
5. Press **↓** to go to **Display Name**, press **Enter**, type `Qwen3 (vLLM)`, press **Enter**
6. Leave **Endpoint** blank (uses the global Server URL you set)
7. Navigate to **Provider**, press **Enter** to cycle to `vllm`
8. Navigate down to **[ Add Model ]** and press **Enter**

Your model is added to the top of the model list and the picker reopens.
Select `qwen3` by pressing **Enter**.

A toast notification at the bottom-right confirms: `Model: qwen3`

### Step 7 — Verify settings are saved

```bash
cat .agent/tui-settings.json
```

You should see:

```json
{
  "model": "qwen3",
  "serverUrl": "http://10.17.0.225:8000/v1",
  "apiKey": "EMPTY",
  "provider": "vllm",
  "temperature": 0.1,
  "maxSteps": 0,
  "port": 5180,
  "customModels": [
    {
      "id": "qwen3",
      "label": "Qwen3 (vLLM)",
      "provider": "vllm",
      "custom": true
    }
  ]
}
```

These settings are loaded automatically every time you run `kairos` from now on.

### Step 8 — Run your first task

Close the TUI (press **Q** — agent keeps running if one was started).

```bash
kairos "Explain the CUDA kernel launch pipeline for a matrix multiply"
```

The launcher reads `tui-settings.json`, exports `AGENT_BASE_URL`, `AGENT_MODEL`,
and `AGENT_API_KEY`, starts the agent, waits for the SSE server, and opens the
TUI. The header will change from `● DISCONNECTED` → `● CONNECTING...` → `● RUNNING`.

---

## The Interface at a Glance

```
╔════════════ HEADER (1 line, always visible) ════════════════════════════════╗
║ KAIROS ● RUNNING  ep-a3f9b12  Step 4  stage:tool  $0.002  p95:1.4s        ║
║                                       [1-4] views  [/] commands  [?] help  ║
╠═════════════════════════════════════════════════════════════════════════════╣
║                                                                             ║
║                  MAIN VIEW (fills remaining height)                        ║
║                                                                             ║
╠═════════════════════════════════════════════════════════════════════════════╣
║  > _                                                                        ║
║  [1] Live  [2] HITL  [3] Memory  [4] Metrics  [,] Settings  [/] Commands  ║
╚════════════════════════════════════════════════════════════════════════════╝
```

The header shows connection status, episode ID, current step, stage name,
running cost, and p95 latency. The bottom two rows are the command bar.

---

## Reading the Header

| Element | Meaning |
|---------|---------|
| `● RUNNING` (green) | Agent is executing steps |
| `● PAUSED` (yellow) | Agent is paused, waiting to resume |
| `● DONE` (cyan) | Session completed successfully |
| `● ERROR` (red) | Session ended with an error |
| `/ CONNECTING...` (spinning) | TUI is connecting to the SSE server |
| `● DISCONNECTED` (grey) | No agent running or SSE server not up |
| `ep-a3f9b12` | Last 9 chars of the episode ID |
| `Step 4` | Current step number |
| `stage:tool` | Active stage name (set by the agent) |
| `$0.002` | Cumulative cost for this session |
| `p95:1.4s` | 95th-percentile step latency |
| `HITL 2 pending [2]` | Yellow badge when approvals are waiting |

---

## The Four Views

Switch views by pressing **1**, **2**, **3**, or **4**, or type `/live`, `/hitl`,
`/memory`, `/metrics` in the command bar.

### View 1 — Live (default)

Shows every step the agent takes as a scrollable list. Each row shows:
```
  Step 4  [bash]  →  ls -la /tmp
```

Left panel: step list. Right panel: full output of the selected step.

| Key | Action |
|-----|--------|
| `↑ ↓` | Scroll the step list |
| `Enter` | Pin a step — its output stays in the right panel |
| `Esc` | Unpin (return to live-following mode) |
| `PgUp / PgDn` | Scroll the output panel line by line |
| `Home` | Jump to the latest step (unpin + scroll to top) |
| `End` | Reset output scroll to bottom |

When pinned, a `📌` marker appears next to the step number.

### View 2 — HITL (Human-in-the-Loop)

When the agent needs approval before running a tool (e.g. writing files,
running shell commands) it pauses and sends an approval request.

The TUI switches to this view automatically. You will see:

```
╔══════════════════ PENDING APPROVAL (1 of 1) ═══════════════════╗
║  Tool:    bash                                                   ║
║  Args:    rm -rf /tmp/build                                      ║
║  Reason:  Cleaning up build artifacts before fresh compile       ║
╚═════════════════════════════════════════════════════════════════╝
  [A] Approve    [D] Deny    [← →] Cycle requests
```

| Key | Action |
|-----|--------|
| `A` | Approve this request — agent continues |
| `D` | Deny — prompts you to type a reason, then press Enter |
| `← →` | Cycle through multiple pending requests |
| `Esc` | Go back to the previous view (request remains pending) |

When you deny, a reason input appears at the bottom: type your reason and
press **Enter**. The agent receives the denial and the reason.

### View 3 — Memory

Shows the agent's memory palace: tool calls, file reads, and decisions logged
per episode.

| Key | Action |
|-----|--------|
| `T` | Temporal view — chronological event list |
| `R` | Rooms view — events grouped by file/domain |
| `F` | Search mode — type a keyword, press Esc to clear |
| `↑ ↓` | Scroll events |
| `Tab` | Switch focus between Events / Skills / Reflections panels |

### View 4 — Metrics

Live counters: total steps, cost, token usage, latency histogram, error rate,
compaction count, HITL approval/denial breakdown.

| Key | Action |
|-----|--------|
| `E` | Export all metrics to `.agent/tui-export.json` |

---

## The Command Bar

The bottom two rows are always active. Press any typeable character to
activate the input prompt, then type a command or a message.

```
  > /model qwen3_
  Tab complete   [Up/Down] history   Enter run   Esc cancel
```

### Typing a message (non-slash text)

If you type text that does not start with `/`, pressing **Enter** sends it as a
**steering message** to the agent. The agent receives it at the next step and
can adjust its plan.

Example:
```
  > Focus only on the parser module, skip the renderer
```

This is the same as pressing **S** (which opens the steer overlay).

### Slash commands

Type `/` to see a filtered autocomplete list above the input bar.
Use **Tab** to cycle through suggestions, **↑ ↓** to navigate, **Enter** to run.

| Command | What it does |
|---------|-------------|
| `/live` | Switch to Live view |
| `/hitl` | Switch to HITL view |
| `/memory` | Switch to Memory view |
| `/metrics` | Switch to Metrics view |
| `/model` | Open model picker |
| `/model qwen3` | Switch model directly by name |
| `/settings` | Open Settings panel |
| `/apikey EMPTY` | Set API key directly without opening settings |
| `/apikey` | Open Settings focused on the API Key field |
| `/steer <text>` | Send a steering message to the agent |
| `/pause` | Pause the agent |
| `/resume` | Resume a paused agent |
| `/clear` | Clear the step history in the TUI (agent keeps running) |
| `/export` | Export metrics to `.agent/tui-export.json` |
| `/status` | Show a status toast: status, step number, cost |
| `/help` | Open the keyboard reference overlay |
| `/reconnect` | Reconnect to the SSE server |
| `/quit` | Quit the TUI (agent keeps running in background) |

**Command history:** Use **↑ ↓** while in the command bar to scroll through
previously run commands.

---

## Global Keyboard Shortcuts

These work from any view when you are not in the command bar or an overlay.

| Key | Action |
|-----|--------|
| `1` / `F1` | Switch to Live view |
| `2` / `F2` | Switch to HITL view |
| `3` / `F3` | Switch to Memory view |
| `4` / `F4` | Switch to Metrics view |
| `,` | Open Settings panel |
| `M` | Open Model Picker |
| `S` | Open Steer overlay |
| `P` | Pause agent (press again to resume) |
| `R` | Reconnect (only active when disconnected) |
| `?` | Open keyboard reference help |
| `Q` / `Ctrl+C` | Quit TUI (agent keeps running unless started with `kairos`) |

> **Tip:** Lowercase letters (`a`–`z`) activate the command bar so you can
> start typing a message or slash command. Only the uppercase shortcuts above
> trigger global actions.

---

## Settings Panel In Depth

Open with **`,`** or `/settings`. Navigate with **↑ ↓**, edit with **Enter**.

### CONNECTION section

**Server URL**
The base URL of your OpenAI-compatible LLM server.
- Edit: press Enter, type or paste the URL, press Enter to save.
- For your vLLM: `http://10.17.0.225:8000/v1`
- For Ollama local: `http://localhost:11434/v1`
- For OpenAI: `https://api.openai.com/v1`
- For LM Studio: `http://localhost:1234/v1`

**API Key**
The key sent in `Authorization: Bearer <key>` headers.
- Press **Enter** to edit. The actual key (not dots) shows in the edit field.
- Press **H** to toggle visibility between `●●●●●●●●` and the real value.
- For vLLM with no auth: use `EMPTY`
- For Ollama: use `ollama`
- For OpenAI: use your `sk-...` key
- Cleared with an empty field.

**Provider**
Changes how the model picker color-codes entries and how connection hints are shown.
- Press **Enter** to cycle: `ollama → vllm → openai → anthropic → custom`
- For your setup: set to `vllm`

### MODEL section

**Model**
Press **Enter** to open the full Model Picker overlay (same as pressing `M`).

### LOOP section

**Temperature**
Sampling temperature sent to the LLM. Default: `0.1`.
- Press Enter, type a float (e.g. `0.7`), press Enter to save.
- `0.0` = deterministic, `1.0` = very creative.
- For code tasks: `0.1`–`0.3` recommended.

**Max Steps**
Maximum steps before the agent stops itself. `0` = unlimited.
- Press Enter, type a number, press Enter to save.
- Useful for preventing runaway agents.

### TUI section

**Port**
The SSE port the TUI connects to. Default: `5180`.
- Change this if you run multiple Kairos instances on different ports.
- Changing this immediately reconnects the TUI to the new port.

---

## Model Picker In Depth

Open with **M** or `/model`. Your custom models appear at the top.

```
╔══════════════════════════ SELECT MODEL ══════════════════════════════╗
║  Current: qwen3                                                      ║
║  ─────────────────────────────────────────────────────────────────── ║
║ > Qwen3 (vLLM)               [vllm]  [custom]  qwen3                ║
║   Qwen2.5-Coder 32B          [ollama]  qwen2.5-coder:32b            ║
║   Qwen3-Coder 30B            [vllm]  qwen3-coder-30b                ║
║   ...                                                                ║
║                                                                      ║
║  [Enter] Select  [↑↓] Navigate  [1-9] Quick  [A] Add custom  [Esc] Cancel ║
╚══════════════════════════════════════════════════════════════════════╝
```

| Key | Action |
|-----|--------|
| `↑ ↓` | Move selection |
| `Enter` | Select highlighted model |
| `1`–`9` | Quick-select by row position |
| `A` | Open "Add Custom Model" form |
| `Del` | Remove the selected model (custom models only) |
| `Esc` | Cancel without changing |

**Provider color coding:**
- Green = ollama
- Blue = vllm
- Cyan = openai / anthropic
- Grey = custom

When you select a model, the selection is:
1. Written to `.agent/tui-model` (legacy, for scripts)
2. Written to `.agent/tui-settings.json` under `"model"`
3. Picked up automatically by `kairos` on the next run

---

## Add Custom Model Form

Press **A** in the Model Picker. Fields:

| Field | Required | What to enter |
|-------|----------|---------------|
| Model ID | Yes | Exact model name the API expects (e.g. `qwen3`, `llama3.1:8b`) |
| Display Name | No | Human-readable label shown in the picker |
| Endpoint | No | Per-model URL override — leave blank to use global Server URL |
| Provider | No | Cycles with Enter/Tab: ollama / vllm / openai / anthropic / custom |

**Navigation:**
- `↑ ↓` or `Tab` — move between fields
- `Enter` on a text field — start typing
- `Enter` when typing — stop editing that field
- `Enter` on Provider — cycle to next provider
- `Enter` on `[ Add Model ]` — save and add
- `Esc` — cancel and go back to the picker

**Adding your qwen3 model step by step:**

```
Model ID:      qwen3
Display Name:  Qwen3 (vLLM)
Endpoint:      (leave blank — uses http://10.17.0.225:8000/v1)
Provider:      vllm
```

Navigate to `[ Add Model ]` and press Enter. Done.

---

## Checking Connection Status

The header dot tells you everything:

| State | What to do |
|-------|------------|
| `● DISCONNECTED` | No agent running. Start one with `kairos "task"` |
| `/ CONNECTING...` | TUI is trying to reach the SSE server. Wait a few seconds |
| `● RUNNING` | Agent is working — watch the Live view |
| `● PAUSED` | You or a rule paused the agent. Press `P` or `/resume` |
| `● DONE` | Session finished. A summary overlay appears |
| `● ERROR` | Agent crashed. Check `.agent/kairos.log` |

**If the TUI shows DISCONNECTED when an agent IS running:**
1. Check the port: type `/status` — if it fails, the SSE server is not up yet
2. Type `/reconnect` to force a reconnect attempt
3. Or press `R` (uppercase)
4. Check the log: in another terminal run `kairos --log`

**If connection never succeeds:**
1. Verify the SSE server port: `curl http://localhost:5180/api/status`
2. Check if the agent started: `cat .agent/kairos.pid` then `ps -p <pid>`
3. Use a different port: `AGENT_HITL_WEB_PORT=5181 kairos "task"`

---

## Running the Agent With Your vLLM Setup

### Method 1 — After configuring via TUI (recommended)

Configure once in the TUI (steps above). Then just run:

```bash
kairos "Your task here"
```

The launcher reads `tui-settings.json` automatically.

### Method 2 — Environment variables (one-off or CI)

```bash
AGENT_BASE_URL="http://10.17.0.225:8000/v1" \
AGENT_MODEL="qwen3" \
AGENT_API_KEY="EMPTY" \
kairos "Your task here"
```

Env vars always take priority over saved settings.

### Method 3 — TUI-only (reconnect to a running agent)

If the agent is already running and you just want to (re)open the TUI:

```bash
kairos
# or
kairos --tui-only
```

### Useful flags

```bash
kairos --resume          # Resume last session
kairos --log             # Follow the agent log
kairos --stop            # Kill background agent
kairos "task" --workspace /path/to/project
```

---

## Checking Whether the Model Is Working

1. Start with a small test task:
   ```bash
   kairos "Print hello world in Python"
   ```

2. Watch the Live view — you should see `Step 1 [llm]` appear within a few
   seconds. The `stage:` label in the header changes as the agent works.

3. If the step stalls at `● CONNECTING...` for more than 10 seconds, the
   model server is not reachable. Check:
   ```bash
   curl http://10.17.0.225:8000/v1/models
   ```
   If this returns a JSON list with `qwen3`, the server is up. If it times out,
   the server at that IP is not running.

4. If you get an `ERROR` immediately, check the log:
   ```bash
   kairos --log
   ```
   Common errors:
   - `404 Not Found` → wrong endpoint path (should end in `/v1`)
   - `401 Unauthorized` → API key mismatch (try `EMPTY` for vLLM)
   - `model not found` → model ID typo — must match exactly what the server reports

---

## Steering the Agent Mid-Task

You can redirect the agent at any point without stopping it.

**Method 1 — Steer overlay (S key):**
Press **S**, type your message, press **Enter**.

**Method 2 — Command bar:**
Type any text in the bar (not starting with `/`) and press **Enter**.

**Method 3 — Slash command:**
```
/steer Focus only on the auth module, skip database changes
```

The agent receives the message at the start of the next step and adjusts
its plan. You can see `steering_injected` in the SSE stream.

---

## Exporting Data

**Export metrics:**
- Press `E` in the Metrics view, or type `/export`
- Written to `.agent/tui-export.json`
- Contains: step count, cost, token usage, latency percentiles, error count,
  HITL stats, episode ID

**Export content of a step:**
- In Live view, press **Enter** on a step to pin it
- The full output shows in the right panel — copy it from your terminal

---

## All Files Written by the TUI

| File | Contents |
|------|----------|
| `.agent/tui-settings.json` | Model, endpoint, API key, temperature, max steps, port, custom models |
| `.agent/tui-model` | Just the model ID (legacy, used by the kairos script fallback) |
| `.agent/tui-export.json` | Metrics export (written when you press E) |
| `.agent/kairos.log` | Agent stdout + stderr |
| `.agent/kairos.pid` | PID of the background agent process |

---

## Complete Keyboard Reference

```
GLOBAL
  1 / F1       Live view
  2 / F2       HITL view
  3 / F3       Memory view
  4 / F4       Metrics view
  ,            Settings panel
  M            Model picker
  S            Steer agent
  P            Pause / Resume
  R            Reconnect (when disconnected)
  ?            Help overlay
  Q / Ctrl+C   Quit TUI

COMMAND BAR (activate by typing any lowercase letter or /)
  /            Start a slash command
  Enter        Run command or send as steering message
  Tab          Autocomplete slash command
  ↑ ↓         Command history
  Esc          Cancel / close command bar

LIVE VIEW
  ↑ ↓         Scroll step list
  Enter        Pin / unpin selected step
  PgUp / PgDn  Scroll output panel
  Home         Latest step, unpin
  End          Reset output scroll
  Esc          Unpin

HITL VIEW
  A            Approve current request
  D            Deny (type reason → Enter)
  ← →         Cycle pending requests
  Esc          Back to previous view

MEMORY VIEW
  T            Temporal mode
  R            Rooms mode
  F            Search mode
  ↑ ↓         Scroll
  Tab          Switch panel focus

METRICS VIEW
  E            Export to .agent/tui-export.json

SETTINGS PANEL (open with ,)
  ↑ ↓         Navigate fields
  Enter        Edit selected field / cycle Provider
  H            Show / hide API key
  Backspace    Delete character while editing
  Esc          Cancel edit or close panel

MODEL PICKER (open with M)
  ↑ ↓         Navigate
  Enter        Select
  1–9          Quick-select by row
  A            Add custom model
  Del          Remove custom model
  Esc          Cancel

ADD CUSTOM MODEL FORM
  ↑ ↓ / Tab   Navigate fields
  Enter        Edit text field / cycle provider / confirm Save
  Esc          Cancel
```

---

## Troubleshooting

**TUI shows garbage / broken box lines**
Your terminal does not support UTF-8 box-drawing characters.
Set `LANG=en_US.UTF-8` and use a modern terminal (Windows Terminal, iTerm2,
Alacritty, Kitty).

**F-keys don't work**
This is a known WSL issue — some terminals send F-key escape sequences as
multiple bytes that arrive split. The TUI has a 30ms assembler to handle this,
but it may not work in all terminals. Use the number keys `1`–`4` instead of
F1–F4. All shortcuts have number-key equivalents.

**`node not found` error from kairos**
Node.js is not on your WSL PATH. Fix:
```bash
export PATH="$PATH:/usr/local/bin"  # add to ~/.bashrc
```
Or install Node.js: `sudo apt install nodejs` (Ubuntu/Debian).

**Agent starts but TUI never connects**
The agent process started but the SSE server did not bind.
Check: `lsof -i :5180` or `ss -tlnp | grep 5180`.
If the port is in use by something else, change it:
```bash
AGENT_HITL_WEB_PORT=5181 kairos "task"
```

**Settings not persisting between runs**
The `.agent/` directory must be writable. Check:
```bash
ls -la .agent/
cat .agent/tui-settings.json
```
If the file does not exist, the TUI may not have write permission.

**vLLM returns 422 or model not found**
Verify the exact model name registered in vLLM:
```bash
curl http://10.17.0.225:8000/v1/models | python3 -m json.tool
```
Copy the `id` field exactly and use that as your Model ID in the TUI.
For your server the model is `qwen3` — confirm it appears in that list.
