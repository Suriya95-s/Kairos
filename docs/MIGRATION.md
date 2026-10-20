# Kairos v2 → v3 Migration Guide

## Breaking changes

### 1. ESM-only (`"type": "module"`)
v3 uses ES modules throughout. Any `require()` calls in custom scripts must become `import`.

```js
// v2
const { runLoop } = require('./src/loop');
// v3
import { runLoop } from './src/loop.js';
```

### 2. `loop.js` return value
`runLoop()` now returns two additional fields:

```js
// v2
{ exitReason, summary, totalSteps, totalCharsUsed, compactionCount, memoriesFlushed, skillsCreated }

// v3 — added:
{ ...above, avgStepLatencyMs, p95StepLatencyMs }
```

### 3. `state.js` — `writeJSON` is now atomic
All JSON writes use write-tmp-then-rename. Files under `.agent/` may briefly have a `.tmp`
sibling during writes. Do not treat `.tmp` files as valid state.

### 4. Config additions (non-breaking defaults)
New env vars have safe defaults (all OFF):

| v3 env var | Default | Purpose |
|---|---|---|
| `AGENT_CHEAP_MODEL` | `` | Cheap model for discovery/execution |
| `AGENT_STRONG_MODEL` | `` | Strong model for planning/verification |
| `KAIROS_OTEL` | `0` | OpenTelemetry spans |
| `KAIROS_TELEMETRY` | `0` | Opt-in telemetry |
| `KAIROS_LOG_JSON` | `0` | Structured JSON logs |
| `KAIROS_LOG_LEVEL` | `info` | Log level |

### 5. Skill execution isolation
`loadSkills` now validates skill file hashes against `.agent/skills-lock.json`.
Tampered skills log a warning and are skipped. Regenerate the lock after editing skills:

```bash
node -e "import('./src/skills.js').then(m => m.validateSkillLock())"
```

### 6. HITL — default deny on timeout
`hitlTimeoutMs` defaults to 600 000 ms (10 min). After timeout the action is **denied**,
not auto-approved. Set `AGENT_HITL_TIMEOUT=0` to disable timeout (wait indefinitely).

## Upgrade steps

1. **Backup** your `.agent/` directory before upgrading.
2. Update Node.js to ≥ 18 (22 recommended).
3. Pull v3 source over your v2 installation.
4. Run `node --test tests/*.test.js` — all 388 tests should pass.
5. Start with all new feature flags OFF (they default OFF already).
6. Enable features one at a time per `docs/DEPLOY.md`.

## `.agent/` directory additions in v3

```
.agent/
  hitl/           # HITL approval queues (Phase 4)
  learning/       # Skill grades, failure patterns, self-evals (Phase 5)
  reflections/    # Per-session reflection markdown (Phase 5)
  training/       # Trace export for RLHF (Phase 5)
  otel/           # OpenTelemetry spans.jsonl (Phase 6)
  telemetry/      # Opt-in telemetry events.jsonl + cost.jsonl (Phase 6)
  lmma/           # LMMA routing banks (Phase 2)
  palace/         # Memory Palace SQLite (Phase 2, needs AGENT_USE_PALACE=1)
  rwkv/           # RWKV controller state (reserved)
  rmt/            # RMT long-context summaries (reserved)
  skills/         # Agent-created skills + skills-lock.json
```

All new directories are created automatically by `initAgentDir()` on first run.
