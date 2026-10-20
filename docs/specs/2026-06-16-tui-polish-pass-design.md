# Design: TUI polish pass — Live richness, discoverability, themes, onboarding

Date: 2026-06-16
Status: approved (scope) — pending spec review

## Context

The Kairos TUI (`apps/tui/src`) is a mature, zero-dependency ANSI terminal UI:
violet-bordered boxes, colorblind-safe distinct glyphs, row-diffed `writeFrame`,
a mono-aware `C` color Proxy, a three-column Live view, inline HITL approvals, a
toast system, a help overlay, and the recently-redesigned Settings + searchable
picker. This pass raises the day-to-day UX across four cohesive, independently
shippable workstreams. No new runtime dependencies; Node ≥18; `node --test`.

Investigation confirmed much of the needed data already exists:
- Per-step latency is **already computed** in the `tool_result` handler
  (`latency = Date.now() - s.startMs`) but is only pushed to `stepLatenciesMs`
  (last 200) — it is **not** stored on the step nor displayed.
- `showToast(message, colour)` with an auto-fade timer already exists.
- A help overlay (`renderHelpOverlay`, `state.overlay === 'help'`) already exists
  as a flat keyboard list.
- A `showSplash` flag already exists.
- Accessibility floor exists: `monoMode()` (NO_COLOR / AGENT_TUI_MONO) blanks all
  SGR via the `C` Proxy; `reducedMotion()` (AGENT_TUI_NO_SPIN) swaps spinners for
  static glyphs. **Both must keep working after every change in this pass.**

So several items are "surface data that already exists" rather than new plumbing,
which keeps risk low.

## Goals / Non-goals

**Goals**
- Make the Live view convey timing and trend at a glance.
- Make keys discoverable per-view without opening help.
- Offer curated color themes while preserving the mono accessibility floor.
- Guide first-run setup (model / key / run).

**Non-goals**
- No mouse support (terminals; out of scope by prior decision).
- No help-overlay search (YAGNI — the contextual footer is the discoverability win).
- No per-user arbitrary color config — only curated presets.
- No new dependencies; no change to the SSE/event protocol.

## Architecture overview

All four workstreams build on existing primitives. The only change touching
`render.js` broadly is the theme accent indirection (C); it is a single
indirection point so the blast radius is contained and mono still wins.

Sequencing (each ships green, additive first, render.js change last):
**A → B → D → C.**

---

## Workstream A — Live view richness

Surfaces timing/trend data already present.

### A1 · Per-step duration
- In the `tool_result` handler, also store the computed latency on the step:
  `s.latencyMs = latency` (the value is already computed; just persist it).
- In `views/live.js` `buildStepRows`, render the duration dim after the tool name,
  e.g. `1.2s`. Threshold: `>= 5000ms` renders the duration in yellow with a
  trailing `⚠` marker (glyph, not color-only, for mono legibility).
- Format helper `fmtDuration(ms)`: `< 1000 → "Nnnms"`, else `"N.Ns"`.
- The currently-running step (no result yet) shows no duration (spinner only).

### A2 · `sparkline()` primitive (render.js, pure, exported, tested)
- `sparkline(nums, width)` → string of `▁▂▃▄▅▆▇█` scaled to the data's min..max
  over the last `width` samples. Empty input → empty string. Short input pads
  left. A single distinct value (min == max) renders a flat mid-tier bar (no
  divide-by-zero). One glyph set only; the block glyphs render fine in mono and
  color is blanked by the `C` Proxy — no separate ASCII ramp.

### A3 · Latency sparkline in INFO panel
- New `LATENCY` section in `buildInfoRows` (`views/live.js`): `p95 1.8s` (existing
  `latencyP(0.95)`) followed by `sparkline(state.stepLatenciesMs, w-12)`.

### A4 · Cost trend
- New state `costHistory: []` (cap 200). Sample on each `step` event: push
  `state.costUsd`. Persisted? No — session-only (like `stepLatenciesMs`).
- In the INFO `COST`/`MODEL` area (and only there, not the header — header stays
  one line), show `$0.042` + `sparkline(costHistory, w-12)`.

### A5 · Output panel wrapping + diff tint
- `buildOutputRows` currently `line.slice(0, w-1)` — silent truncation of long
  lines. Replace with a word/hard wrap to width `w-1` so nothing is hidden
  (a pure `wrapLine(text, width)` helper; falls back to hard-break tokens longer
  than width). Respect the existing visible-window math (`h - rows.length`).
- Extend `colorizeOutput`: lines starting with `+ ` → green, `- ` → red
  (without breaking the existing PASS/FAIL/warn rules; diff rules checked first
  only when the line looks like a unified-diff body).

**A tests** (`tests/tui-live-richness.test.js`): `sparkline` (scaling, empty,
flat, width clamp, mono blanks color), `fmtDuration`, `wrapLine` (wrap, hard-break
long token, empty), `colorizeOutput` diff lines, and that a step with `latencyMs`
renders a duration token in `buildStepRows` output.

---

## Workstream B — Discoverability & help

### B1 · Contextual footer
- New component `components/footer.js` exporting `renderFooter(W)` → one line.
- Returns view-specific key hints derived from `state.view` / active overlay:
  - `live`: `[↑↓] steps  [Enter] pin  [M] model  [/] cmd  [?] help`
  - `chat`: `[Enter] send  [M] model  [Esc] back  [?] help`
  - `memory`: `[T] temporal  [R] rooms  [/] search  [Tab] panel`
  - `metrics`: `[E] export  [?] help`
  - `council`: `[?] help`
  - default/global suffix always includes `[?] help`.
- Rendered by `app.js` on the line directly above the command bar. Layout: the
  Live/other views shrink their content height by 1 to make room (mirror of how
  the approval band already reduces `contentH`). Mono-safe (grey hints).
- Per-panel inline hint lines that the footer now covers are removed from
  `views/live.js` (the `[↑↓] scroll …` trailer rows) to avoid duplication; keep
  panel-local scroll affordances (`↑ N more above`) since those are dynamic.

### B2 · Help overlay regroup
- Reorganize `renderHelpOverlay` into clearly-labeled sections with aligned
  two-column key tables (GLOBAL / LIVE / MEMORY / METRICS / CHAT / COMMANDS).
  Content-only change; same overlay mechanism, same "any key closes".

**B tests** (`tests/tui-footer.test.js`): `renderFooter` returns the right hints
per `state.view`, always includes `[?] help`, is exactly one line, and is
width-padded; mono mode contains no SGR codes.

---

## Workstream C — Visual polish & theme  *(render.js accent indirection — last)*

### C1 · Theme accent indirection
- Add `state.theme: 'violet' | 'ocean' | 'warm'` (default `violet`). Mono is NOT a
  theme — it remains the orthogonal accessibility override that blanks all color.
- In `render.js`, define `THEMES` mapping each theme to an `accent` SGR (the
  border/title color) and a `select` background:
  - violet: accent `\x1b[38;5;135m` (current), select `bg 237`
  - ocean:  accent `\x1b[38;5;39m` (blue/cyan), select `bg 24`
  - warm:   accent `\x1b[38;5;208m` (amber), select `bg 094`
- Introduce `accent()` returning the current theme's accent SGR (or `''` in mono),
  reading `state.theme`. Route the violet border helpers (`vb`, `boxTop/Bot/Row`,
  `dbox*`, the three/two-col builders, `titledHlineVi`) through `accent()` instead
  of the hardcoded `C.violet`. `vi()`/`C.violet` direct uses in views that denote
  *semantic* violet (e.g. section markers) may stay or move to `accent()` — they
  move to `accent()` so the theme is cohesive.
  - To avoid a circular import (`render.js` importing `state.js`), `state.js`
    already imports from `render.js`; instead expose a tiny setter the state layer
    calls: `setAccentTheme(name)` stores the active theme name in a module-local
    in render.js, and `app.js` calls it from `setState`/load. Decision: render.js
    holds `let _theme = 'violet'`; `setActiveTheme(name)`; `accent()` reads it.
    `app.js` calls `setActiveTheme` on load and on change. No render→state import.
- `resetFrameBuffer()` is called on theme change to force a full repaint.

### C2 · Settings row + persistence
- Add a `Theme` row to the TUI/ADVANCED section in `getSettingsItems()`
  (kind `cycle`, values violet→ocean→warm). `beginSettingsEdit` cycles it,
  calls `setActiveTheme`, `resetFrameBuffer()`, `saveSettings()`, toast.
- Persist `theme` in `saveSettings`/`loadSettings` (validated against the 3 names).

### C3 · Consistent selection + empty states
- A shared `selectionRow(text, selected, width)` idea is **not** introduced
  (too invasive across differing row shapes). Instead: standardize the *visual
  vocabulary* — selected rows use `accent` `▌` + `C.bgSel` consistently in steps,
  picker, settings, memory where they currently differ. Minimal, per-view edits.
- Empty states: Live STEPS `Waiting for steps…` → `no steps yet — press [r] to run`
  when idle; OUTPUT empty hint stays. These are copy-only.

**C tests** (`tests/tui-theme.test.js`): `accent()` returns the right SGR per
theme and `''` in mono; `setActiveTheme` validates names (unknown → violet);
`boxTop` uses the active accent; `loadSettings` rejects an invalid theme.

---

## Workstream D — Onboarding & first-run

### D1 · Setup checklist overlay
- When idle (`status` disconnected/idle, no `episodeId`, no steps) and
  `showSplash` is truthy, render a centered checklist overlay (reuse `dbox*`):
  - `① Model` — ✓ `state.model` or ✗ `not set` → hint `M`
  - `② API key / endpoint` — ✓ if `state.apiKey` (API mode) or reachable
    `serverUrl` (Local) else ✗ → hint `,`
  - `③ Run a task` — hint `r` (or `/run`)
  - Footer: `[,] settings   [?] help   [any key] dismiss`
- ✓ green check / ✗ red cross are glyph-distinct (mono-legible).
- Dismiss: any key sets `showSplash:false`; auto-dismissed when the first `step`
  event arrives (already sets `showSplash:false`).
- This replaces/extends the current splash; the existing `showSplash:false` reset
  points are reused.

**D tests** (`tests/tui-onboarding.test.js`): the checklist reflects model/key
state (✓/✗), lists the fix keys, is gated on idle+showSplash, and a keypress
dismisses it (sets `showSplash:false`).

---

## Data / state additions

`state.js`:
- `costHistory: []` (session-only, cap 200)
- `theme: 'violet'` (persisted)
- (`stepLatenciesMs`, `showSplash`, `toast`, `overlay` already exist)

Per-step: `latencyMs` field populated in `tool_result` (already computed).

`render.js`: module-local `_theme`; exports `accent`, `setActiveTheme`,
`sparkline`, `wrapLine`, `fmtDuration` (pure where noted).

Persistence (`.agent/tui-settings.json`, mode 0600 — unchanged): add `theme`
(validated). `costHistory` and `latencyMs` are NOT persisted.

## Error handling / edge cases

- `sparkline([])` / single value → safe flat bar, no NaN.
- `wrapLine` of a token longer than width → hard break, never drops chars.
- Unknown persisted `theme` → fall back to `violet` on load (no throw).
- Footer must never exceed one row; truncate with `clip` at width.
- Mono mode: every new render path produces zero SGR codes (asserted in tests).
- Reduced motion: no new animations added; spinners already gated.
- Theme change triggers `resetFrameBuffer()` so the row-diff doesn't leave stale
  colored borders.

## Testing strategy

Each workstream adds one focused test file (offline, deterministic, `node --test`):
`tui-live-richness.test.js`, `tui-footer.test.js`, `tui-theme.test.js`,
`tui-onboarding.test.js`. Existing suites must stay green; `TESTING.md` totals
and the TUI row updated at the end. `node --check` on every changed/created file.
Mono-mode assertions (no SGR) included in each new file.

## Verification (manual)

- Live: run a task → durations appear per step, slow steps flagged; INFO shows
  latency + cost sparklines; long output lines wrap instead of truncating; diff
  lines tint.
- Footer: switch views (1–5) → hints change to match the view; `[?] help` always
  present; `NO_COLOR=1` → no color, still legible.
- Theme: Settings → Theme cycles violet/ocean/warm, borders recolor immediately,
  persists across restart; `AGENT_TUI_MONO=1` overrides to no-color regardless.
- Onboarding: fresh start with no key → checklist shows ✗ on key, ✓ on model if
  set; pressing a key or starting a run dismisses it.

## Sequencing & rollout

1. **A** Live richness (additive; no render.js signature changes).
2. **B** Footer + help regroup (additive component; small live.js trim).
3. **D** Onboarding checklist (additive overlay).
4. **C** Theme accent indirection (render.js) — last, isolated, full-repaint on change.

Each step: implement → its test file green → full suite green → commit.
