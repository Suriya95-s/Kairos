# Kairos TUI — Design Document

> A keyboard-driven terminal interface for watching, controlling, and debugging Kairos agent runs.
> Connects to the existing SSE Live View server on port 5180 — **no changes to the core loop required.**
> Hand this document to whoever is building the TUI. Everything they need is here.

---

## 1. What This Is

The Kairos TUI is a **standalone terminal app** that sits next to a running Kairos agent and gives the operator a real-time window into everything happening: steps, tool output, HITL approvals, cost, memory, and more. It does not start or stop the agent — it watches and controls it through the existing HTTP API and SSE event stream.

**The friend building this does not need to touch the Kairos source code.** The loop already exposes everything through:

```
GET  http://localhost:5180/events          ← live SSE event stream
GET  http://localhost:5180/api/status      ← { paused, pendingCount }
GET  http://localhost:5180/api/pending     ← pending HITL approvals
POST http://localhost:5180/api/approve/:id
POST http://localhost:5180/api/deny/:id    body: { reason? }
POST http://localhost:5180/api/steer       body: { message }
POST http://localhost:5180/api/pause
POST http://localhost:5180/api/resume
```

---

## 2. Design Principles

1. **Keyboard-only** — every action reachable in ≤ 2 keystrokes. No mouse required.
2. **Never blocks the agent** — the TUI is read-only except for explicit operator actions (approve, deny, steer, pause). A TUI crash never crashes the agent.
3. **HITL is never missed** — when an approval arrives the TUI immediately surfaces it, no matter what view the operator is in.
4. **Readable at a glance** — the most important information (current step, status, pending approvals) is always on screen.
5. **Graceful sizing** — works at 80×24 minimum; better at 160×45+.
6. **Connects to what exists** — no new runtime infrastructure. SSE + HTTP is enough.

---

## 3. Information Architecture

The TUI has four views switched with `F1`–`F4`. A persistent header and command bar frame every view.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  HEADER BAR  — always visible, 1 line                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  ACTIVE VIEW  — Live / HITL / Memory / Metrics                               │
│                                                                               │
├─────────────────────────────────────────────────────────────────────────────┤
│  COMMAND BAR  — always visible, 1–2 lines                                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

| Key | View | Purpose |
|-----|------|---------|
| `F1` | **Live** | Step feed + tool output + session info (default) |
| `F2` | **HITL** | Approval queue — auto-activates when a request arrives |
| `F3` | **Memory** | Palace events, skills, past reflections |
| `F4` | **Metrics** | Latency histogram, cost, quality numbers |

---

## 4. Header Bar

One line. Always visible. Updated in real time.

```
 KAIROS  ● RUNNING   ep-174823691   Step 22   stage:execution   $0.041   p95:2.1s   [F1-F4] views   [?] help
```

| Segment | Source | Updates on |
|---------|--------|------------|
| `KAIROS` | Static | — |
| `● RUNNING` | `/api/status` + SSE | Every status change |
| `ep-174823691` | `session_start` event | New session |
| `Step 22` | `step` event | Every step |
| `stage:execution` | `step` event `.stage` | Every step |
| `$0.041` | `cost_update` event | Cost events |
| `p95:2.1s` | Computed from step timestamps | Every step |
| View hints | Static | — |

### Status dot

| Agent state | Symbol | Color |
|-------------|--------|-------|
| Running | `●` | Green |
| Paused | `◉` | Yellow |
| Approval pending | `⊙` | Yellow, blinks |
| Completed | `✓` | Cyan |
| Error / failed | `✗` | Red |
| Disconnected from TUI | `○` | Grey |

---

## 5. View 1 — Live (F1)

The default view. Three columns sized 30% / 45% / 25% of terminal width.

```
┌─ STEPS ───────────────────────┬─ OUTPUT ──────────────────────────┬─ INFO ──────────────────┐
│                                │                                    │                         │
│  ▶  22  run_command            │  > npm test -- --reporter=spec     │  TASK                   │
│       npm test                 │                                    │  Build a REST API        │
│                                │    ✓ GET /users (22ms)             │  with auth + tests       │
│  ✔  21  write_file             │    ✓ POST /users (31ms)            │                         │
│       src/routes/users.js      │    ✓ DELETE /users/:id (18ms)      │  STAGE                  │
│                                │                                    │  execution  (step 15)    │
│  ✔  20  write_file             │    3 passing (1.1s)                │                         │
│       src/middleware/auth.js   │                                    │  MODEL                  │
│                                │                                    │  qwen3-coder-30b         │
│  ✔  19  think                  │                                    │                         │
│       Planning auth flow...    │                                    │  SKILLS                 │
│                                │                                    │  express-route   A       │
│  ✔  18  read_file              │                                    │  test-runner     A       │
│       src/app.js               │                                    │  auth-pattern    B       │
│                                │                                    │                         │
│  ✔  17  run_command            │                                    │  PALACE                 │
│       npm install express      │                                    │  18 events               │
│                                │                                    │  last: step 21           │
│  [↑↓] scroll  [Enter] pin      │  [↑↓] scroll  [PgUp/Dn] page      │                         │
└────────────────────────────────┴────────────────────────────────────┴─────────────────────────┘
```

### Steps panel (left)

- Newest step at the **top**.
- Active step shows animated spinner: `⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏`
- Completed without error: `✔` green. Error: `✗` red. Blocked/skipped: `⊘` grey.
- `↑` / `↓` to move selection. `Enter` to **pin** that step's output in the Output panel.
- Press `Esc` to **unpin** and return to live output.

**Step row format (2 lines):**
```
  [icon]  [step#]  [tool name]
           [thought or arg, truncated to ~35 chars]
```

### Output panel (center)

- Shows stdout/result of the **currently running step** (or the pinned step).
- Auto-scrolls to bottom as content arrives during live mode.
- `PgUp` / `PgDn` to scroll. `End` to jump back to live bottom.
- Truncated at 5 000 chars: `[… N more lines — press End to follow live]`.

### Info panel (right)

Static cards — refreshed on events, not user-scrollable:

| Card | What it shows |
|------|---------------|
| `TASK` | Task text, wrapped, max 5 lines |
| `STAGE` | Current stage and step-in-stage counter |
| `MODEL` | Active model name |
| `SKILLS` | Loaded skills with their grade badge (A–D) |
| `PALACE` | Episodic event count + timestamp of last write |

---

## 6. View 2 — HITL (F2)

**Auto-activates** when an `approval_requested` SSE event arrives, regardless of which view the operator is on. The previous view is saved and restored when the queue empties.

```
╔══ ⚠  APPROVAL REQUIRED  (1 of 1 pending) ════════════════════════════════╗
║                                                                [Esc] dismiss ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║  Request ID:   hitl-1748236914-rm                                             ║
║  Received:     12 seconds ago                                                 ║
║  Timeout:      9m 48s  remaining                                              ║
║                                                                               ║
║  Tool:         run_command                                                    ║
║  Argument:     rm -rf dist/                                                   ║
║                                                                               ║
║  Agent thought:                                                               ║
║  ┌──────────────────────────────────────────────────────────────────────┐    ║
║  │ The dist/ directory contains stale build artifacts that will         │    ║
║  │ conflict with the new build output. Safe to remove before rebuild.   │    ║
║  └──────────────────────────────────────────────────────────────────────┘    ║
║                                                                               ║
║  Policy match:   rm -rf  →  REQUIRES_APPROVAL                                ║
║                                                                               ║
║  ── Deny reason (optional) ──────────────────────────────────────────────    ║
║  ┌──────────────────────────────────────────────────────────────────────┐    ║
║  │ _                                                                    │    ║
║  └──────────────────────────────────────────────────────────────────────┘    ║
║                                                                               ║
║  [A] Approve    [D] Deny    [←][→] cycle pending    [Esc] return to Live     ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

### Interaction flow

```
Approval arrives via SSE
        │
        ▼
TUI switches to HITL View automatically
        │
        ├─ [A]  ──────────────────────► POST /api/approve/:id
        │                                 Card turns green → next pending or restore view
        │
        ├─ [D]  ──────────────────────► Deny reason input box activates
        │    Type reason (or leave blank)
        │    [Enter] ─────────────────► POST /api/deny/:id { reason }
        │                                 Card turns red → next pending or restore view
        │
        ├─ [→] / [←]  ───────────────► Cycle through multiple pending requests
        │
        └─ [Esc]  ───────────────────► Return to previous view
                                         Request stays pending and times out naturally
```

### Timeout countdown

- Shown as `9m 48s remaining` — counts down live.
- Below 60s: turns yellow.
- Below 15s: turns red and blinks.
- At zero: card turns red, shows `AUTO-DENIED (timeout)`.

### Multiple pending requests

Counter shows `2 of 3 pending`. Use `[→]` / `[←]` to navigate. TUI restores the previous view only when **all** pending requests are resolved.

### HITL badge in other views

When a request is pending and the operator is NOT in HITL View, a yellow badge pulses in the header:

```
 KAIROS  ● RUNNING  …   ⚠ 1 PENDING → [F2]
```

This badge is always visible so the operator never misses a request.

---

## 7. View 3 — Memory (F3)

Inspect the palace, loaded skills, and past session reflections.

```
┌─ PALACE ───────────────────────────────────┬─ SKILLS & REFLECTIONS ─────────────────┐
│  [R]ooms  [T]emporal  [/]Search            │                                          │
│                                             │  SKILLS                                  │
│  ── Temporal (newest first) ──              │  ─────────────────────────────────────  │
│                                             │  express-route        A    reuse: 12     │
│  Step 21  write_file                        │  test-runner          A    reuse:  8     │
│  src/routes/users.js created.               │  auth-pattern         B    reuse:  5     │
│  who: kairos                                │  debug-loop           C    reuse:  2     │
│  domain: execution                          │  old-migration        D    reuse:  0     │
│                                             │                                          │
│  Step 14  approval_response                 │  [Enter] view  [Del] delete              │
│  rm -rf dist/ approved.                     │                                          │
│  who: user                                  │  REFLECTIONS                             │
│  outcome: approved                          │  ─────────────────────────────────────  │
│                                             │  ep-17482369  (2h ago)                   │
│  Step 13  write_file                        │  Exit: completed   Score: 4/5            │
│  src/middleware/auth.js created.            │  Steps: 22   Cost: $0.031               │
│  who: kairos                                │                                          │
│                                             │  ep-17481200  (yesterday)                │
│                                             │  Exit: max_steps   Score: 2/5            │
│  [↑↓] scroll  [Enter] expand event          │  Steps: 100   Cost: $0.189              │
└─────────────────────────────────────────────┴──────────────────────────────────────────┘
```

### Sub-modes

Toggle with `R`, `T`, `/` while in Memory View:

| Key | Mode | Shows |
|-----|------|-------|
| `T` | **Temporal** (default) | Episodic events newest-first |
| `R` | **Rooms** | Spatial project tree with event counts per file |
| `/` | **Search** | Text input → TF-IDF search across episodic store |

**Rooms sub-mode:**
```
  src/
  ├── loop.js           [14 events]  ← current file
  ├── state.js          [ 3 events]
  ├── config.js         [ 1 event ]
  └── agents/
      ├── conductor.js  [ 2 events]
      └── policy.js     [ 0 events]
```

`Enter` on a file node drills into its episodic events.

---

## 8. View 4 — Metrics (F4)

Numbers-only view. Useful at the end of a session or for benchmarking.

```
┌─ SESSION METRICS ───────────────────────────────────────────────────────────────────┐
│                                                                                       │
│  Episode:   ep-1748236914                                                             │
│  Task:      Build a REST API with auth middleware and tests                           │
│  Status:    RUNNING (step 22 of ∞)                                                    │
│                                                                                       │
│  ── LATENCY ──────────────────────────────────────────────────────────────────       │
│  avg: 1.8s    p50: 1.6s    p95: 2.1s    p99: 4.2s    max: 6.1s                       │
│                                                                                       │
│  Step latency histogram (last 40 steps):                                              │
│  0–1s   ████████████  14                                                              │
│  1–2s   ███████████████████  22                                                       │
│  2–3s   ████  4                                                                       │
│  3–5s   ██  2                                                                         │
│  5s+    ▌  1                                                                          │
│                                                                                       │
│  ── COST ─────────────────────────────────────────────────────────────────────       │
│  total: $0.041     input: 28,430 tok    output: 4,120 tok    avg/step: $0.003         │
│                                                                                       │
│  ── QUALITY ──────────────────────────────────────────────────────────────────       │
│  errors: 2 (9.1%)    hallucinations: 0    max consecutive errors: 1                   │
│  compactions: 1      skills created: 2    HITL gates: 1 (1 approved, 0 denied)        │
│                                                                                       │
│  ── MODEL ────────────────────────────────────────────────────────────────────       │
│  model: qwen3-coder-30b    provider: vllm    endpoint: localhost:8000                  │
│                                                                                       │
│  [E] export to .agent/tui-export.json                                                 │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 9. Command Bar

Two lines. Always visible at the bottom.

```
 > _                                                         [Tab] focus input
 [F1] Live  [F2] HITL  [F3] Memory  [F4] Metrics  [P] Pause  [S] Steer  [?] Help  [Q] Quit
```

**Top line** — command input. Activated by pressing `Tab` or `S`.
Used for:
- Steer text (sends via `POST /api/steer`)
- Memory search query (when in Memory View with `/` active)
- Deny reason (when denying a HITL request)

**Bottom line** — key legend. Adapts to context:
- Approval pending → `[A] Approve  [D] Deny` inserted and `[F2]` highlighted yellow
- Paused → `[P]` label changes to `[P] Resume`
- Disconnected → `[R] Reconnect` added

---

## 10. Overlays

### Steer overlay (`S`)

```
╔══ SEND STEERING MESSAGE ══════════════════════════════════════╗
║                                                                ║
║  ┌──────────────────────────────────────────────────────┐     ║
║  │ Focus on the auth middleware before writing tests._  │     ║
║  └──────────────────────────────────────────────────────┘     ║
║                                                                ║
║  [Enter] Send    [Esc] Cancel                                  ║
╚════════════════════════════════════════════════════════════════╝
```

### Help overlay (`?`)

Centered modal with the full keyboard reference (§11). Press any key to dismiss.

### Session-end overlay

Shown automatically when a `session_end` SSE event arrives. Auto-dismisses after 8 seconds.

```
╔══ SESSION COMPLETE ══════════════════════════════════════════╗
║                                                               ║
║  Exit:      completed                                         ║
║  Steps:     22     Cost: $0.031     Duration: 1m 44s          ║
║  p95 latency:  2.1s                                           ║
║                                                               ║
║  [F4] Metrics    [Q] Quit    [any key] Dismiss                ║
╚═══════════════════════════════════════════════════════════════╝
```

---

## 11. Keyboard Reference

### Global (always active)

| Key | Action |
|-----|--------|
| `F1` / `1` | Live View |
| `F2` / `2` | HITL View |
| `F3` / `3` | Memory View |
| `F4` / `4` | Metrics View |
| `P` | Toggle pause / resume |
| `S` | Open steer message input |
| `?` | Toggle help overlay |
| `Q` / `Ctrl+C` | Quit TUI (does NOT stop the agent) |
| `Tab` | Cycle panel focus within current view |

### Live View

| Key | Action |
|-----|--------|
| `↑` / `↓` | Scroll step list |
| `Enter` | Pin selected step's output |
| `Esc` | Unpin — return to live output |
| `PgUp` / `PgDn` | Scroll output panel |
| `End` | Jump output to latest (live) |
| `Home` | Jump step list to most recent step |

### HITL View

| Key | Action |
|-----|--------|
| `A` | Approve current request |
| `D` | Deny — activates reason input; `Enter` to submit |
| `→` | Next pending request |
| `←` | Previous pending request |
| `Esc` | Return to previous view (request stays pending) |

### Memory View

| Key | Action |
|-----|--------|
| `T` | Temporal sub-mode |
| `R` | Rooms sub-mode |
| `/` | Search sub-mode — activates text input |
| `↑` / `↓` | Scroll events / tree |
| `Enter` | Expand selected event (full verbatim) |
| `Tab` | Cycle focus: events ↔ skills ↔ reflections |

### Metrics View

| Key | Action |
|-----|--------|
| `E` | Export metrics to `.agent/tui-export.json` |

---

## 12. Multi-Agent Mode

When `AGENT_MULTI_AGENT=1` is set, the header and Live View adapt.

### Header (multi-agent)

```
 KAIROS  ● RUNNING   ep-174823691   CONDUCTOR → SCOUT ✔  PLANNER ✔  CODER ▶  REVIEWER …  ARCHIVIST …   $0.041
```

Active specialist is bright. Completed specialists show `✔`. Pending show dim.

### Live View (multi-agent)

Steps show a role badge:

```
  ▶  22  [CODER]    write_file
           src/routes/users.js
  ✔  21  [CODER]    write_file
           src/middleware/auth.js
  ✔   7  [PLANNER]  finish
           plan.md produced
  ✔   3  [SCOUT]    finish
           project map complete
```

A pipeline summary bar sits above the step list:

```
  SCOUT ✔ 3 steps   PLANNER ✔ 4 steps   CODER ▶ 15 steps   REVIEWER …   ARCHIVIST …
```

---

## 13. Startup and Connection

```
1. Start: kairos-tui [--port 5180] [--workspace ./]

2. Try GET /api/status on the target port.

   Connected → fetch /api/pending, subscribe to /events, render Live View.
              If pending approvals exist → auto-switch to HITL View.

   ECONNREFUSED → show waiting screen:

       ╔══════════════════════════════════════╗
       ║  KAIROS TUI                          ║
       ║  Waiting for agent on port 5180…     ║
       ║  Start the agent, then:              ║
       ║  [R] Retry    [Q] Quit               ║
       ╚══════════════════════════════════════╝

       Auto-retries every 3 seconds.

3. On disconnect mid-session:
   Header: "○ DISCONNECTED"
   Command bar: "[R] Reconnect"
   Auto-retries with exponential backoff (3s → 6s → 12s → 30s).
```

---

## 14. SSE Events the TUI Must Handle

| Event `type` | What to do |
|-------------|------------|
| `step` | Prepend new row to Steps panel, update header step counter + stage |
| `tool_result` | Update Output panel, mark step ✔ or ✗ |
| `approval_requested` | Auto-switch to HITL View, show badge in header |
| `approval_response` | Resolve HITL card (green approved / red denied), restore view if queue empty |
| `approval_timeout` | Resolve card as red AUTO-DENIED, restore view if queue empty |
| `paused` | Update header dot to `◉` PAUSED, update command bar |
| `resumed` | Update header dot to `●` RUNNING |
| `steering_injected` | Flash "Steering sent ✓" in command bar for 2s |
| `session_start` | Update header episode ID + task, reset step counter and cost |
| `session_end` | Show session-end overlay, update header to `✓ COMPLETED` or `✗ FAILED` |
| `cost_update` | Update cost in header |

Any unknown event type should be silently ignored (forward compatibility).

---

## 15. Minimum Terminal Size

| Dimension | Value |
|-----------|-------|
| Minimum to run | 80 × 24 |
| Recommended | 160 × 45 |
| Full-featured | 200 × 50+ |

Below 80 columns → show compact single-column mode automatically (see §16).
Below 60 columns → show error:
```
Terminal too narrow (58 cols — need ≥80).
Resize or run: kairos-tui --compact
```

---

## 16. Compact Mode (`--compact`)

Single-column fallback for narrow terminals or SSH sessions.

```
 KAIROS ● RUNNING  Step 22  $0.041  ⚠1
─────────────────────────────────────────
▶  22  run_command
       npm test
─────────────────────────────────────────
✔  21  write_file / src/routes/users.js
✔  20  write_file / src/middleware/auth.js
✔  19  think
✔  18  read_file / src/app.js
─────────────────────────────────────────
[A] Approve  [D] Deny  [P] Pause  [S] Steer  [Q] Quit
```

No multi-column layout. HITL handled inline at the bottom bar.

---

## 17. Color Scheme

Matches the Kairos web UI palette for consistency.

| Element | Color |
|---------|-------|
| Background | Dark (`#0d1117` or terminal default) |
| Panel borders | Dim grey (`#30363d`) |
| Primary text | Light grey (`#c9d1d9`) |
| Secondary / timestamps | Grey (`#8b949e`) |
| Running / success / approved | Green (`#238636`) |
| Warning / paused / pending | Yellow (`#d29922`) |
| Error / denied | Red (`#da3633`) |
| Info / links / steering | Blue (`#58a6ff`) |
| Grade A skill | Green |
| Grade B skill | Light green |
| Grade C skill | Yellow |
| Grade D skill | Grey |

Degrade to 8-color ANSI when `$COLORTERM` / `$TERM` indicate limited support.

---

## 18. Recommended Libraries

### Node.js (matches the Kairos stack)

- **`blessed`** + **`blessed-contrib`** — box layout, scrollable lists, keyboard trapping, sparkline/histogram charts. Most complete option.
- **`ink`** — React-style components for the terminal. Easier to reason about state; weaker for raw keyboard handling.

### Python

- **`textual`** — async-first, reactive, excellent layout system. Best choice if the friend prefers Python. Use `httpx` for SSE.

### Go

- **`bubbletea`** + **`lipgloss`** — strongly typed, fast, great for pure keyboard TUIs.

### Rust

- **`ratatui`** — highest performance, all the primitives needed.

All of these can read SSE from `localhost:5180/events` with basic HTTP streaming.

---

## 19. SSE Client (minimal Node.js snippet)

```js
import http from 'node:http';

function connectSSE(port, onEvent, onDisconnect) {
  http.get(`http://localhost:${port}/events`, (res) => {
    let buf = '';
    res.on('data', chunk => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop(); // keep incomplete last line
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try { onEvent(JSON.parse(line.slice(6))); } catch {}
        }
      }
    });
    res.on('end', () => {
      onDisconnect?.();
      setTimeout(() => connectSSE(port, onEvent, onDisconnect), 3000);
    });
  }).on('error', () => {
    onDisconnect?.();
    setTimeout(() => connectSSE(port, onEvent, onDisconnect), 3000);
  });
}
```

---

## 20. State Model

The TUI keeps one plain JS/Python object. No database, no disk writes (except the optional metrics export).

```js
{
  // Connection
  connected: false,
  reconnectAttempts: 0,

  // Session
  episodeId: '',
  task: '',
  status: 'disconnected',   // 'running'|'paused'|'completed'|'error'|'disconnected'
  step: 0,
  stage: '',

  // Cost + latency
  costUsd: 0,
  totalTokens: 0,
  stepLatenciesMs: [],       // ring buffer, last 200 steps

  // Steps (ring buffer, last 500)
  steps: [],                 // { step, tool, arg, thought, result, error, startMs, endMs }
  pinnedStepIndex: null,

  // HITL
  pendingApprovals: [],      // from /api/pending + SSE
  hitlCursor: 0,             // which approval is focused
  previousView: 'live',      // restored when queue clears

  // Metrics
  compactions: 0,
  errors: 0,
  hallucinations: 0,
  skillsCreated: 0,
  hitlTotal: 0,
  hitlApproved: 0,

  // Views
  activeView: 'live',        // 'live'|'hitl'|'memory'|'metrics'
  memorySubMode: 'temporal', // 'temporal'|'rooms'|'search'
  searchQuery: '',

  // Skills + reflections (loaded once from API or filesystem on connect)
  skills: [],
  reflections: [],
  palaceEvents: [],
}
```

---

## 21. Suggested File Structure

```
kairos-tui/
├── index.js            ← entry: arg parsing, connect, launch app
├── src/
│   ├── app.js          ← root layout, keyboard router, view switcher
│   ├── state.js        ← TuiState + pure reducer functions
│   ├── client/
│   │   ├── sse.js      ← SSE subscription + auto-reconnect
│   │   └── api.js      ← approve / deny / steer / pause / resume helpers
│   ├── views/
│   │   ├── live.js     ← F1: steps + output + info
│   │   ├── hitl.js     ← F2: approval queue
│   │   ├── memory.js   ← F3: palace + skills + reflections
│   │   └── metrics.js  ← F4: numbers + histogram
│   ├── components/
│   │   ├── header.js
│   │   ├── commandBar.js
│   │   ├── stepList.js
│   │   ├── outputPanel.js
│   │   └── spinner.js
│   └── overlays/
│       ├── help.js
│       ├── steer.js
│       └── sessionEnd.js
└── package.json
```

---

## 22. What Is Explicitly Out of Scope (v1)

These are intentional omissions to keep the first version simple:

- Starting or stopping the agent from the TUI — use `node src/cli.js`
- Editing skills or HITL policy files
- Mouse support
- Windows native terminal (`cmd.exe`) — WSL is fine
- Authentication — TUI connects to localhost only, same as the web UI
- Multi-session view (one agent at a time)

---

## 23. Acceptance Checklist

The TUI is done when a friend can:

- [ ] Start it with `kairos-tui` and see the waiting screen if no agent is running
- [ ] Connect automatically when an agent starts, without restarting the TUI
- [ ] Read the current step, tool, stage, cost, and model at a glance
- [ ] Watch tool output scroll live in the Output panel
- [ ] Pin any past step and read its full output, then unpin
- [ ] See a yellow badge the moment an approval request arrives
- [ ] Approve or deny with `A` / `D` in two keystrokes
- [ ] Add a deny reason before denying
- [ ] Send a steering message with `S`
- [ ] Pause and resume the agent with `P`
- [ ] Browse palace events in temporal, rooms, and search sub-modes
- [ ] Read skill grades and past reflection scores
- [ ] See the latency histogram and cost breakdown in Metrics View
- [ ] Switch views with F1–F4 at any time
- [ ] Quit the TUI without stopping the agent

---

*Written for Kairos v3.0-rc.1. The TUI is a pure observer + operator — it never imports from `src/` and never writes to agent state files directly.*
