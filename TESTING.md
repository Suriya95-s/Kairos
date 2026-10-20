# Testing the Kairos Agent Loop

One clear way to exercise everything implemented in the loop. All tests are
**network-free** and **deterministic** — no live LLM, no server, no ports.

## TL;DR — run everything

```bash
npm run test:all          # full suite ×2 (determinism) + stress + smoke + syntax
```

Prints a `PASS n / FAIL n` summary and exits non-zero on any failure. Expected tail:

```
SUMMARY:  PASS 6   FAIL 0
✓ everything green
```

Other entrypoints:

```bash
npm test                  # the full unit/integration suite (node --test tests/*.test.js)
npm run test:stress       # just the stress/load pass
node --test tests/hitl.test.js          # a single subsystem
node --test --test-name-pattern="DAG" tests/stress.test.js   # one stress section
```

## What `test:all` does (`scripts/test-all.sh`)

1. **Full suite, run 1** — correctness.
2. **Full suite, run 2** — asserts identical counts ⇒ **determinism** (the Wave-A guarantee, made explicit).
3. **Stress / load pass** — `tests/stress.test.js` (see below).
4. **End-to-end smoke** — drives both renderers offline: `formatEvent` (line mode) + `composeFrame` (the cockpit frame with NOW band + focus strip), and greps for expected markers.
5. **Syntax check** — `node --check` on the hot entrypoints (`loop.js`, `cli.js`, TUI `app.js`, `conductor.js`).

## Coverage by domain (unit + integration)

| Domain | Tests | Representative files |
|---|---:|---|
| Core loop / harness | 237 | `edge-to-edge`, `parseAction`, `tokens`, `cli`, `config`, `eval-args`, `tracer`, `prompt-cache` |
| Operator TUI | 221 | `tui-commands`, `tui-interaction`, `tui-cockpit`, `tui-line`, `tui-frame`, `tui-render`, `tui-accessibility`, `settings-picker`, `settings-flow`, `tui-live-richness`, `tui-footer`, `tui-onboarding`, plus the **Aurora redesign** suites: `tui-palette` (truecolor/256/mono depth + legacy→Aurora remap), `tui-compose` (seg/bandLR/boxN width-exact helpers), `tui-approval-dock` (docked HITL interrupt on every view, escalation, mono+reduced-motion), `tui-layout` (Split/Focus/Wide presets + vitals ribbon), `tui-theme` (accent themes + density), `tui-overlays` (fuzzy command palette + onboarding wizard) |
| LLM Council (5th panel) | 16 | `council` (3-stage engine, stubbed network), `council-view` |
| Agent learning / memory (palace) | 103 | `learning`, `episodic-store`, `palace-decay`, `palace-e2e`, `palace-writers` |
| Conductor / multi-agent | 60 | `multi-agent-e2e`, `conductor-dag`, `conductor-manifest`, `conductor-config` |
| HITL | 39 | `hitl` |
| Tools / skills contract | 28 | `tool-contract`, `skill-trust`, `skills-standard` |
| MCP integration | 25 | `mcp-github` |
| Observability | 23 | `observability` |
| LMMA routing | 13 | `lmma-heuristics`, `lmma-integration` |
| Identity / plan | 8 | `kairos-identity`, `plan-focus` |
| Stress / load | 14 | `stress` |
| **Total** | **818** | (per-row counts are representative; the suite total is authoritative — `npm test`) |

(See `LOOP_EVALUATION.md` for the full evaluation.)

## What the stress pass exercises (`tests/stress.test.js`)

Pushes **volume** and asserts **invariants** (counts / termination / bounds), never wall-clock — so it doesn't flake on slow machines. Runs in ~2 s.

| Subsystem | Load | Invariant asserted |
|---|---|---|
| Episodic palace (CEI) | 5,000 inserts + consolidate | stays usable, count bounded |
| Semantic graph | 2,000 same + 2,000 distinct asserts | idempotent (no unbounded `.jsonl` growth) |
| Procedural index | 1,000 successes | recipe set bounded |
| Typed DAG | 200-node chain, 150-wide diamond, 100-cycle | correct waves; cycle detected (no hang) |
| Token estimator | 1 MB string, 1,000 messages | finite, no NaN |
| RMT segmentation | 500 KB input | **terminates** (infinite-loop regression guard) |
| Tool contract | 500 write/read cycles | all structured `ok`; `dryRun` no side effect |
| Line renderer | 10,000 mixed events (all 16 types) | never throws; noise suppressed |
| Frame composer (TUI) | 100-size resize storm (incl. <60 narrow) | always exactly H lines, never throws |
| Command router | 300 fuzzed commands | **never rejects** (crash-safety under volume) |
| Budget | 1,000 steps + cost accrual | step + USD ceilings trip |
| Conductor manifest | 500 atomic write/read cycles | no corruption, no `.tmp` leak |

## Honest boundaries (what these tests do *not* cover)

- **No live-LLM end-to-end run.** Correctness is verified at the component and decision-boundary level; the record/replay tracer (`AGENT_RECORD`/`AGENT_REPLAY`) makes LLM/tool-driven paths reproducible without a network. `conductTask` (multi-agent) is tested per-component (DAG, manifest, budget, config), not as a live pipeline.
- **TUI lifecycle / spawn / real reconnect** (`startApp`, `restoreTerminal`, child-process spawn, live SSE) need a TTY/process/network — verified by the offline smoke + manual checks, not units.
- Coverage here is **test count**, not line-coverage instrumentation. For percentages: `npx c8 node --test tests/*.test.js`.
