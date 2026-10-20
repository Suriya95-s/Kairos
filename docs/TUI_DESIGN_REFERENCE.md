# Kairos TUI — Design & UI Reference

> **Purpose of this document.** A complete, self-contained description of the
> current Kairos terminal UI (TUI) — its layout, visual language, views, overlays,
> interaction model, and constraints — written so a designer who has *never seen
> the code* can propose a better design. Hand this to a chat assistant and ask it
> to redesign; everything it needs is here. ASCII mockups are approximate but
> faithful to the real layout proportions.

---

## 1. What Kairos is

Kairos is an **autonomous agent loop** (an LLM that plans, calls tools, reflects,
and stores memories over many steps). The TUI is the **operator cockpit**: a
human watches the agent work in real time, approves/denies risky actions
(human-in-the-loop, "HITL"), steers it mid-task, inspects its memory, and chats
with the model directly. It connects to a running agent over a local SSE event
stream; it can also run standalone.

The operator is usually watching a long-running process, so the UI's first job is
**situational awareness**: what is the agent doing *right now*, is it on plan, what
did it just produce, and does it need me?

---

## 2. Hard constraints (these shape every design decision)

1. **It's a terminal.** Fixed grid of character cells, monospace. No images, no
   web fonts, no pixel positioning. Layout is rows × columns. Width (`W`) and
   height (`H`) vary with the user's terminal; the UI must reflow.
2. **Keyboard only. No mouse.** Every action is a keystroke. There is no
   pointer, no click, no scroll wheel, no drag. Navigation is arrow keys, Tab,
   Enter, Esc, and single-letter shortcuts.
3. **Zero runtime dependencies.** Pure Node.js + ANSI escape codes. No TUI
   framework (no ncurses, blessed, ink). Everything — boxes, color, cursor moves,
   diffed repaints — is hand-rolled. A redesign must be expressible as ANSI.
4. **Accessibility is a floor, not a feature.**
   - **Monochrome mode** (`NO_COLOR` or `AGENT_TUI_MONO=1`): *all* color is
     stripped. The UI must stay fully legible with zero color — meaning **every
     state must be distinguishable by glyph/shape/text, never by color alone.**
   - **Reduced motion** (`AGENT_TUI_NO_SPIN=1`): animated spinners become static
     glyphs.
   - **Headless** (`--no-tui`): a plain line-by-line mode for screen readers / CI.
5. **Flicker-free over SSH.** The renderer diffs frames and rewrites only changed
   rows. Full-screen repaints are avoided. Designs that thrash the whole screen
   every tick are out.
6. **Live, not static.** State updates stream in continuously (new steps, tool
   results, cost, approvals). The layout must absorb change without jumping.

---

## 3. Rendering model (how pixels actually happen)

- A pure function `composeFrame(W, H)` returns an **array of strings**, one per
  terminal row. Each string may contain ANSI SGR color codes.
- A `writeFrame` step **diffs** the new rows against the previous frame and
  cursor-addresses only the rows that changed (`\x1b[row;1H`).
- **Color** is a set of SGR codes accessed through a Proxy (`C.green`, `C.cyan`,
  …) that returns `''` in mono mode — so a single mode flag blanks all color
  globally without per-view changes.
- **Box drawing** uses Unicode line characters:
  - Single: `┌ ┐ └ ┘ ─ │ ┬ ┴` (panels)
  - Double: `╔ ╗ ╚ ╝ ═ ║` (modal overlays — visually "heavier" = on top)
- **Overlays** (modals) are drawn *on top of* the composed base frame by
  cursor-addressing a centered box, then the next frame fully repaints to clear
  them.
- Width-aware helpers exist for clipping (`…` ellipsis), padding, and visible
  length (ANSI-code-aware so colored text measures correctly).

---

## 4. Global layout — the frame "bands"

The screen is a vertical stack of bands. From top to bottom:

```
┌───────────────────────────────────────────────────────────────────────────┐
│ HEADER          (1 row, always)                                             │
│ NOW BAND        (0–2 rows, only while a step is running)                    │
│ ───────────────────────────────────────────────────────────────────────── │
│                                                                             │
│ MAIN VIEW       (flex height — one of 5 views, or an overlay on top)        │
│                                                                             │
│ ───────────────────────────────────────────────────────────────────────── │
│ FOCUS STRIP     (0–1 row, the agent's plan with current item highlighted)   │
│ COMMAND BAR     (1 row input + 1 row view-aware hints; grows for chips/    │
│                  command suggestions)                                       │
└───────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Header (always one row)
Left-aligned identity + live status; right-aligned global nav hint.

```
 KAIROS │ ▶ RUNNING  ep-a1b2c3d4d  Step 12  stage:build  $0.042  p95:1.8s    [1-5] views  [/] commands  [?] help
```

- **Status indicator** uses a *distinct glyph per state* (mono-safe):
  `▶ RUNNING` · `‖ PAUSED` · `✓ DONE` · `✗ ERROR` · spinner `CONNECTING…` /
  `RECONNECTING (try N)`. Color is redundant reinforcement only.
- Optional inline: episode id, step number, stage, cumulative cost, p95 latency,
  a multi-agent pipeline strip (`role OK | role * | role`), and a HITL badge
  (`⚠ 2 APPROVALS [a]/[d]`) when approvals are pending.

### 4.2 NOW band ("the current step is sacred")
Whatever the agent is doing *this instant* is pinned here, in the same place,
across every view — never scrolled away. Empty when idle/on splash.

```
 ⠹ NOW edit src/app.js                                                  ⏱ 1.2s
      reasoning: applying the retry wrapper around the fetch call
```

(`⠹` is one frame of a braille spinner; static `▶` under reduced motion.)

### 4.3 FOCUS strip (drift detector)
The agent's own plan as a single line, current item highlighted — so plan drift
is visible the moment it happens.

```
 focus: ✓ scope the bug   ✓ write test   ▸ implement fix   · verify   · commit
```

States: `✓ done` (grey) · `▸ current` (bold/yellow) · `⚠ blocked` (red) ·
`· pending` (grey).

### 4.4 Command bar (bottom, always)
- An input line (type a message to **steer** the agent mid-loop, or `/` for a
  command palette with Tab-completion and history).
- A **view-aware hints line** showing the keys relevant to the *current view*,
  always ending with `[?] Help` and `[Q] Quit`. It is **responsive**: when the
  hints don't fit the width, it sheds the duplicate nav tabs (keeping the active
  view's tab) before it drops the action keys.
- Grows upward to show **attachment chips** (`📎 file.js (2.2 KB)`) when files are
  dropped/pasted, and a **command suggestion list** when typing `/`.

```
 ▸ type a message to steer, or / for commands                            _
 [1] Live  [↑↓] steps  [Enter] pin  [M] model  [/] Commands  [?] Help  [Q] Quit
```

---

## 5. Visual vocabulary

### 5.1 Palette (256-color SGR)
| Token   | Use                                            |
|---------|------------------------------------------------|
| green   | success, "running" tool, positive metrics      |
| yellow  | attention, current/pending, "now", warnings    |
| red     | errors, deny, blocked                          |
| cyan    | section titles, model name, info accents       |
| grey    | secondary text, labels, hints, dim/disabled    |
| violet  | **accent** — borders, titles, brand (theme-driven) |
| blue    | search fields, local-server endpoints          |

### 5.2 Themes (accent presets)
A single "accent" color drives all borders + titles. Three curated themes plus
the mono override:
- **violet** (default), **ocean** (blue/cyan), **warm** (amber).
- **mono** is *not* a theme — it's an orthogonal accessibility override that
  blanks all color regardless of theme.
Cycled from Settings → Theme; persisted.

### 5.3 Glyph language (must carry meaning without color)
- Status: `▶` running · `‖` paused · `✓` done · `✗` error/failed · `·` idle/pending
- Spinner: braille `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` (animated) → `▶`/`▷` static (reduced motion)
- Step icons: `▶` current (spinner) · `✔`/`✓` completed · `✗` errored
- Selection: a left **`▌` accent bar** + subtle background on the selected row
- Trend: sparklines `▁▂▃▄▅▆▇█`
- Approval: `⚠` · Council: `⚖` · Memory event: `▸` section markers
- Scroll affordances: `↑ N more above` / `↓ N more below`
- Progress/elapsed: `⏱`

### 5.4 Two box weights
- **Single line** `┌─┐│└┘` for in-view panels and the metrics/chat frames.
- **Double line** `╔═╗║╚╝` for **modal overlays** (settings, picker, help,
  splash) — the heavier border reads as "floating above".

---

## 6. The five views (switch with keys `1`–`5`)

All views fill the MAIN band. They share the header/now/focus/command bands.

### 6.1 Live (`1`) — the default cockpit
Three columns: **STEPS | OUTPUT | INFO**. An inline **approval band** appears at
the top when the agent needs sign-off (HITL happens here, in place).

```
┌─ STEPS ───────────┬─ OUTPUT ─────────────────┬─ INFO ──────────────┐
│ ▶ 012 edit  1.2s  │ > Step 12: edit [PINNED] │ ▸ TASK              │
│   src/app.js      │  + added retry wrapper   │ refactor fetch loop │
│ ✔ 011 read  0.3s  │  - old slug              │ ──────────────────  │
│ ✔ 010 bash  5.4s⚠ │  function fetchModels(){ │ ▸ STAGE             │
│ ✔ 009 grep  0.1s  │    ...                   │  build              │
│ ▌✔ 008 edit 0.2s  │  }                       │ ──────────────────  │
│   (selected)      │                          │ ▸ MODEL             │
│                   │                          │  gpt-4o             │
│                   │                          │ ──────────────────  │
│                   │                          │ ▸ LATENCY           │
│                   │                          │  p95 1.8s ▂▃▇▅▂▃    │
│                   │                          │ ──────────────────  │
│                   │                          │ ▸ COST              │
│                   │                          │  $0.042  ▁▂▃▅▇      │
│                   │                          │ ──────────────────  │
│ [Esc] unpin       │  ↓ scrolled up 5 lines   │ ▸ MEMORY            │
│                   │    — [End] to follow live│  14 events          │
└───────────────────┴──────────────────────────┴─────────────────────┘
```

- **STEPS** (left, ~29%): reverse-chronological step list (newest top). Each step
  = icon + number + tool name + **duration** (slow ≥5s flagged `⚠`), with an
  arg/thought sub-line. Scrollable; `Enter` **pins** a step's output.
- **OUTPUT** (center, widest): the selected/current step's full output. Wraps
  (never truncates), tints diff `+`/`-` lines and pass/fail/warn lines.
- **INFO** (right, ~24%): task, stage, model, **latency & cost sparklines**,
  memory event count. Section markers `▸`.
- **Approval band** (when pending), rendered above the columns:

```
─────────────────────────────────────────────────────────────────────────────
 ⚠ APPROVAL REQUIRED  (1/2)  bash   rm -rf ./build
   why: clean the stale build dir before rebuild
   ⏱ 4m32s left    [a]pprove   [d]eny   [←→] 1/2
─────────────────────────────────────────────────────────────────────────────
```
Deny opens an inline reason input. Timer counts down; turns yellow <15m, red <1m.

### 6.2 Memory (`2`) — the "memory palace"
Two columns: **PALACE | SKILLS & REFLECTIONS**. Modes: Rooms / Temporal /
Search (`R`/`T`/`/`). The palace is the agent's episodic memory (events grouped
by "room"/domain); skills are learned capabilities with letter grades (A–D).

```
┌─ PALACE  [R]ooms [T]empo [/]Search ─┬─ SKILLS & REFLECTIONS ──────────┐
│ Search: fetch retry█                │ file-edit            A          │
│                                     │ web-search           B          │
│ ▸ step 12  edit   app.js            │ shell-run            C          │
│   added retry wrapper               │ ──────────────────────────────  │
│ ▸ step 9   bash   npm test          │ reflection: the retry should   │
│   3 tests failed → fixed            │ back off exponentially…         │
└─────────────────────────────────────┴─────────────────────────────────┘
```

### 6.3 Metrics (`3`) — session analytics
A single bordered panel: episode/task/status, a **latency** block
(avg/p50/p95/p99/max + histogram), **cost**, and **quality** (errors,
hallucinations, compactions, HITL approve/deny tallies). `E` exports JSON.

```
┌─ SESSION METRICS ───────────────────────────────────────────────────────────┐
│  Episode:   ep-a1b2c3d4d                                                      │
│  Task:      refactor fetch loop                                              │
│  Status:    ▶ running                                                        │
│  ── LATENCY ───────────────────────────────────────────────────────────     │
│  avg: 1.1s   p50: 0.8s   p95: 1.8s   p99: 3.2s   max: 5.4s                    │
│  ▁▂▃▅▇▆▅▃▂▁ …                                                                 │
│  ── COST ──────────────────────────────────────────────────────────────     │
│  $0.042 over 12 steps                                                        │
│  ── QUALITY ───────────────────────────────────────────────────────────     │
│  errors: 1   hallucinations: 0   compactions: 0   HITL: 2✓ / 0✗              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 6.4 Chat (`4`) — direct conversation with the model
A bordered transcript with role-tagged, wrapped messages and tool-use blocks; an
input at the bottom. Tool calls inside chat can themselves require approval
(separate overlay). Robust against flaky providers (auto-retries when a model
slug has moved; friendly 404/429 guidance).

```
┌─ CHAT ───────────────────────────────────────────────────────────────────────┐
│ you  ›  summarize the retry change                                            │
│ kai  ›  The fetch loop now wraps each call in a retry with one re-attempt     │
│         when OpenRouter returns a moved-slug 404…                             │
│         ⚙ tool: read  app.js                                                  │
│ ⠹ thinking…                                                                   │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 6.5 Council (`5`) — multi-model deliberation
The "LLM Council": several models answer, rank each other, and a chairman
synthesizes. A 3-stage progress display per member (`· pending`, `▶ running`,
`✓ done`, `✗ failed`). `M` opens a lineup editor overlay.

```
 ⚖ LLM COUNCIL   Stage 2/3 · ranking
   ✓ gpt-4o          ▶ claude-sonnet-4     · llama-3.3-70b     ✗ qwen-72b
   chairman: gpt-4o
   ────────────────────────────────────────────────────────────────────
   [synthesized answer streams here in stage 3]
```

---

## 7. Overlays (modal, double-line border, centered)

Drawn on top of the current view; dismissed with `Esc` (or any key for
help/splash).

- **Splash / Onboarding** — KAIROS ASCII art, connection status, and a **first-run
  setup checklist**:

```
                    (KAIROS ASCII art, violet)
              Autonomous Agent Loop · Intelligence in Motion
                     ●  Connected on port 7777

                  ✓ Model     [M]  gpt-4o
                  ✗ API key   [,]  none
                  • Run a task [r]  or type a task + Enter
```

- **Settings** (`,`) — data-driven, sectioned form: **CONNECTION** (guided
  API|Local: provider → key → model, or endpoint → model → key), **LOOP**,
  **MEMORY & COMPACTION**, **ADVANCED**, **TUI** (incl. Theme). Rows are typed:
  *pick* (opens a picker), *cycle* (Enter toggles), *toggle*, *numeric*, *text*,
  *secret* (masked, `[H]` reveals). Saved to `.agent/tui-settings.json` (chmod
  0600 — it can hold a plaintext API key).

```
╔══════════════════════════════ SETTINGS ══════════════════════════════╗
║  Live config. Saved to .agent/tui-settings.json (0600).   [H] show keys║
║                                                                        ║
║  ── CONNECTION ──────────────────────────────────────────────────────  ║
║  > Source        API (cloud provider)   [Enter] switch                 ║
║    Provider      openai                  → choose                      ║
║    API Key       ●●●●●●●●●●               → choose                      ║
║    Model         gpt-4o                   → choose                      ║
║  ── TUI ─────────────────────────────────────────────────────────────  ║
║    Theme         violet                  [Enter] switch                ║
║                                                                        ║
║  [Enter] Edit/Pick  [↑↓] Navigate  [H] Toggle keys  [Esc] Close        ║
╚════════════════════════════════════════════════════════════════════════╝
```

- **Picker** (searchable dropdown) — reused for provider / API-key / endpoint /
  model. Type to filter; remembers past keys/endpoints/models for one-keystroke
  reselect; `[Tab]` fetches the live `/v1/models` list; you can always type a
  custom value.

```
╔════════════════════ SELECT MODEL ════════════════════╗
║  search: gpt█                                         ║
║  > gpt-4o                          openai             ║
║    gpt-4o-mini                     openai             ║
║    use "gpt-custom-id"             (custom)           ║
║  [Tab] fetch live list   [↑↓] move   [Enter] pick     ║
╚═══════════════════════════════════════════════════════╝
```

- **Help** (`?`) — grouped keyboard reference (GLOBAL / LIVE / MEMORY / METRICS /
  COMMANDS), any key closes.
- **Toast** — transient confirmation near the command bar, auto-fades.
- **Session-end** — exit reason, totals (steps, cost, duration, p95).

---

## 8. Interaction model (keymap)

**Global:** `1`–`5` switch views · `,` Settings · `?` Help · `/` command palette
· `Space`/`P` pause/resume · `A` approve · `D` deny · `S` steer · `M` model picker
· `Q` quit. Typing anywhere (not starting with `/`) composes a steer message;
`Enter` sends.

**Live:** `↑↓` scroll steps · `Enter` pin output · `Esc` unpin · `PgUp/PgDn`/`End`
scroll output · `←→` cycle pending approvals.
**Memory:** `T` temporal · `R` rooms · `/` search · `Tab` switch panel.
**Metrics:** `E` export.
**Council:** `M` edit lineup.
**Overlays:** `↑↓` navigate · `Enter` select/confirm · `Esc` cancel ·
`Backspace` delete · (picker) type to filter, `Tab` live-fetch.

**Paste/drop:** bracketed paste delivered whole — file paths become attachment
chips; text into an open picker lands in its filter; otherwise into the command
input.

---

## 9. Responsive & state behavior

- **< 60 columns** → a single-band **narrow layout**: identity + status, task,
  the NOW step, and any approval — the essentials, no columns.
- Three-column widths are proportional (~29% / ~47% / ~24%).
- The hints line degrades gracefully (sheds tabs before keys).
- Bands are **conditional**: NOW and FOCUS are empty when idle/on splash so they
  don't waste rows.
- **Reconnect honesty:** when the event stream drops, the header says
  `RECONNECTING (try N)` — it never presents stale state as live.

---

## 10. Known pain points & opportunities (for the redesign)

These are honest weaknesses / open questions — good targets for a better design:

1. **Information density vs. calm.** The Live INFO column now stacks TASK / STAGE
   / MODEL / LATENCY / COST / MEMORY sections; on short terminals it can overflow
   (it clips). Is there a better hierarchy, or a way to make trend data ambient
   rather than listed?
2. **Three fixed columns** may not be the right split for every task — e.g. a
   long single output sometimes wants the whole width. No layout presets exist.
3. **Discoverability still leans on memorized keys.** There's a help overlay and a
   view-aware hint line, but no progressive disclosure / command palette fuzzy
   search beyond `/`.
4. **The approval moment is critical and easy to miss** if you're on another view
   — there's a header badge + inline band, but no stronger pull (e.g. auto-jump,
   sound is impossible in-terminal, flashing risks accessibility).
5. **Color is doing a lot of semantic work**, even though glyphs back it up. A
   redesign should keep the "legible with zero color" rule but could push glyph/
   typography hierarchy further (weight, spacing, dividers) so color is pure
   garnish.
6. **Onboarding is a static checklist on the splash** — it doesn't actively walk a
   first-timer through setup; it just shows ✓/✗.
7. **Themes are accent-only.** Backgrounds, selection styles, and dividers are
   fixed. A fuller theming system (contrast levels, density modes) is possible.
8. **Vertical rhythm.** Bands are added/removed dynamically, which can make the
   main view's height "jump" by a row or two when the agent starts/stops. A more
   stable reserved-space model might feel calmer.

### Design rules any replacement MUST keep
- Pure ANSI, monospace grid, no mouse, zero dependencies.
- **Every state distinguishable without color** (mono mode must stay fully usable).
- Reduced-motion path (no required animation).
- Row-diff friendly (don't repaint the whole screen every tick).
- The **current step is always visible** (the NOW guarantee) and **approvals are
  never silently buried**.
- Reflow from ~40 to 200+ columns; degrade to a narrow single-band layout under
  60 columns.

---

## 11. One-paragraph brief (paste-ready)

> Kairos is a keyboard-only terminal cockpit for watching and steering an
> autonomous LLM agent. It's pure ANSI (no mouse, no deps, monospace grid) and
> must stay fully legible with zero color (accessibility floor) and without
> animation (reduced motion). The screen is a stack of bands — header (status),
> a pinned "NOW" line (current step, sacred), a focus strip (the agent's plan), a
> flexible main area with five switchable views (Live = steps|output|info columns
> + inline approvals; Memory palace; Metrics; Chat; multi-model Council), and a
> bottom command bar with a view-aware hint line. Modals (settings, a searchable
> model/key picker, help, splash) float in double-line boxes. State streams in
> live and the renderer diffs rows to avoid flicker. Redesign it to be calmer,
> more discoverable, and more beautiful **within these constraints** — better
> hierarchy and typography, smarter use of the limited width, a stronger but
> accessible signal when the agent needs approval, and a layout that doesn't jump
> as live data arrives.
