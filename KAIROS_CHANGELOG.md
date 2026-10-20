# Kairos Changelog

All notable changes to the Kairos agent loop are documented here.
Format: `[version] — date — summary`

---

## [v3.0.0-rc.1] — 2026-05-25 — Phase 6: Observability + Production Hardening (COMPLETE)

### Added
- `src/logger.js`: Structured logger (levels: debug/info/warn/error). JSON output via `KAIROS_LOG_JSON=1`, human-readable by default. All output to stderr. Child loggers via `logger.child(prefix)`. (Task 6.1)
- `src/otel.js`: Zero-dep OpenTelemetry span emitter. `startTrace(sessionId)`, `recordSpan(name, attrs, startMs, endMs, status)`, `flushSpans()` (OTLP/HTTP export, best-effort). Spans persisted locally to `.agent/otel/spans.jsonl`. Gated on `KAIROS_OTEL=1`. (Task 6.2)
- `src/observability/costTracker.js`: Per-session token + dollar cost tracker. `startSession`, `recordUsage`, `flushCost`. End-of-run cost report per agent. (Task 6.9)
- `src/observability/telemetry.js`: Opt-in telemetry per N9 — `KAIROS_TELEMETRY=1` to enable; stubs to `.agent/telemetry/events.jsonl` until external endpoint configured. Off by default. (Task 6.10)
- `eval/swe-bench.js`: SWE-bench Lite harness adapter — runs benchmark tasks against the agent loop. (Task 6.11)
- `eval/benchmark.js`: Step-efficiency benchmark vs baseline. Numbers in README. (Task 6.12)
- `docs/DEPLOY.md`: Production deployment guide — Docker Compose + k8s examples. (Task 6.15)
- `docs/MIGRATION.md`: v2 → v3 migration guide — palace auto-migration, MCP config, multi-agent opt-in. (Task 6.16)

### Changed
- `src/loop.js`: OTel wired — calls `startTrace(episodeId)` at session start, `recordSpan('step', ...)` after each step's latency push, `flushSpans()` in `result()` alongside `flushCost()`. (Task 6.2) Multi-agent gate added — at top of `runLoop()`, if `config.multiAgentEnabled`, routes to `conductTask()` from `src/agents/conductor.js`. (Task 3.13 / Phase 3 entry point)
- `src/config.js`: Added `conductorModel: process.env.KAIROS_CONDUCTOR_MODEL || process.env.AGENT_CHEAP_MODEL || ''` in multi-model routing block. (Q7 / Task 6.8)
- `src/agents/policy.js`: `getRoleModel('conductor')` now falls back to `config.cheapModel` when `KAIROS_CONDUCTOR_MODEL` is unset (previously fell back only to `config.model`). (Q7)
- `src/state.js`, `src/llm.js`, `src/skills.js`, `src/verification.js`, `src/agents/conductor.js`: All remaining `console.error` calls replaced with structured logger (`logger.error` / `logger.warn` / `logger.info`). (Task 6.1)
- `src/palace/retrieval.js`: TF-IDF semantic search mode — results ranked by relevance. (Task 6.6)
- `src/skills.js`: Skill sandbox replaced with `worker_threads` for isolation. (Task 6.3)
- `skills-lock.json`: Hash-based lock file validation — mismatch warns user. (Task 6.4)
- `src/state.js` + `src/palace/episodic-store.js`: Atomic checkpoint + palace writes (episodic-store already WAL). (Task 6.5)
- `.eslintrc`, `.prettierrc`: ESLint + Prettier at warn level; CI lints, warnings reported. (Task 6.14)
- All public `src/*.js` exported functions: JSDoc annotations. (Task 6.13)

### Status
- Tests: 411 pass, 0 fail (+23 observability/eval tests from 388)
- Phase 6 COMPLETE: 6.1 ✅ 6.2 ✅ 6.3 ✅ 6.4 ✅ 6.5 ✅ 6.6 ✅ 6.7 ✅ 6.8 ✅ 6.9 ✅ 6.10 ✅ 6.11 ✅ 6.12 ✅ 6.13 ✅ 6.14 ✅ 6.15 ✅ 6.16 ✅
- Exit criterion: Production deployment checklist completable. Cost per task measurable. SWE-bench Lite harness operational.
- **All Kairos v3.0 phases complete. RC tag: v3.0.0-rc.1. Next: N7 demo (Snake + Express API + SWE-bench Lite task) + 1-week beta period before v3.0.0 GA.**

---

## [v3.0.0-dev] — 2026-05-22 — Phase 4: Human-in-the-Loop (COMPLETE)

### Added
- `src/hitl/approvalQueue.js`: File-based approval queue — `enqueue`, `listPending`, `getRequest`, `writeResponse`, `getResponse`, `removeRequest`. Pending requests in `.agent/hitl/pending/`, responses in `.agent/hitl/responses/`. (Task 4.1)
- `src/hitl/gateway.js`: Approval detection + block-and-wait with timeout — `checkRequiresApproval` (destructive pattern detection + policy), `requestApproval` (blocks until approved/denied or default-deny timeout per Q5), `pause`/`resume`/`isPaused` (Task 4.12), `appendAudit` (Task 4.14), `emitEvent` (SSE bus for Live View), episodic writes with `who="user"` on every HITL event (Task 4.15). (Tasks 4.2, 4.3, 4.12, 4.14, 4.15)
- `src/hitl/clarificationQueue.js`: Agent-asks-human queue — `askClarification`, `answerClarification`, `getPendingClarifications`, `consumeAnswers`. Answers injected into context at next step. (Task 4.4)
- `src/hitl/steeringChannel.js`: Human → agent steering — `addSteeringMessage`, `consumeSteering`, `listSteering`. Messages consumed at step start and prepended to `runtimeGuidance`. (Task 4.5)
- `src/hitl/notifier.js`: Multi-channel notifier — Slack webhook (`KAIROS_SLACK_WEBHOOK_URL`), Discord webhook (`KAIROS_DISCORD_WEBHOOK_URL`), SMTP email (`KAIROS_SMTP_*`). All channels optional, fired concurrently, failures caught. (Tasks 4.7, 4.8, 4.9)
- `apps/web-ui/server.js`: Zero-dep SSE Live View server (port 5180) — `/events` SSE stream, `/api/pending`, `/api/approve/:id`, `/api/deny/:id`, `/api/steer`, `/api/pause`, `/api/resume`, `/api/status`, static file serving. (Task 4.10)
- `apps/web-ui/public/index.html`: Vanilla JS Live View UI — real-time event timeline (SSE), pending approvals panel with approve/deny buttons, steering message input, pause/resume control. Zero dependencies. (Task 4.11)
- `hitl-policy.json`: Default approval policy — `rm -rf`, `DROP TABLE`, `git push --force`, `npm publish`, `delete_file` require approval; `read_file`, `list_dir`, `think` are auto-approved. (Task 4.13)
- `tests/hitl.test.js`: 37 tests — approvalQueue (8), gateway detection (7), gateway approve flow (2), gateway timeout deny (1), clarificationQueue (5), steeringChannel (3), pause/resume (5), audit log (3), policy loading (2), episodic smoke (1). (Task 4.16)

### Changed
- `src/config.js`: Added HITL config keys — `hitlEnabled`, `hitlDir`, `hitlPendingDir`, `hitlResponsesDir`, `hitlClarifyDir`, `hitlSteerDir`, `hitlAuditFile`, `hitlTimeoutMs` (default 600000ms), `hitlPollIntervalMs` (default 2000ms), `hitlPolicyFile`, `hitlWebUiPort` (default 5180). All gated behind `AGENT_HITL_REQUIRED=1` (default off per RC).
- `src/state.js`: `initAgentDir` now creates all HITL subdirectories on startup.
- `src/loop.js`: Imports HITL modules; at top of each step when `hitlEnabled`: (1) blocks while paused, (2) injects `consumeSteering()` messages into `runtimeGuidance`, (3) injects `consumeAnswers()` into `runtimeGuidance`; before `executeTool`: calls `requestApproval` and `continue`s on deny.
- `src/cli.js`: Added HITL sub-commands — `agent approve <id>`, `agent deny <id> [reason]`, `agent pause`, `agent resume`, `agent steer "message"`, `agent hitl list`, `agent clarify <id> "answer"`. All in `--help`.

### Status
- Tests: 352 pass, 0 fail (+37 HITL tests from 315)
- Phase 4 COMPLETE: 4.1 ✅ 4.2 ✅ 4.3 ✅ 4.4 ✅ 4.5 ✅ 4.6 ✅ 4.7 ✅ 4.8 ✅ 4.9 ✅ 4.10 ✅ 4.11 ✅ 4.12 ✅ 4.13 ✅ 4.14 ✅ 4.15 ✅
- Exit criteria met: approval gate + timeout deny + CLI commands + notifiers + Live View + pause/resume across restart + audit log + episodic writes.
- Next: Phase 5 (Self-Improvement — Week 11)

---

## [v3.0.0-dev] — 2026-05-22 — Phase 5: Self-Improvement (COMPLETE)

### Added
- `src/learning/skillGrader.js`: Grade agent-created skills A–D based on reuse count (from frontmatter + training traces), success rate (trace outcomes), recency, and content richness. `gradeSkill`, `gradeAllSkills` (persists to `.agent/learning/skill-grades.json`), `loadGrades`. (Task 5.1)
- `src/learning/skillConsolidator.js`: Detect near-duplicate skills via Jaccard coefficient on tokenized content. `findMergeCandidates`, `consolidate(dryRun)` — merges secondary into primary (higher reuse_count wins), removes secondary file. (Task 5.2)
- `src/learning/offlineConsolidation.js`: Offline orchestration — palace decay + skill grading + consolidation. `runOfflineConsolidation({ skipPalace, skipSkills, dryRun })`. Also a standalone CLI: `node src/learning/offlineConsolidation.js <workspace>`. Runs between sessions, never in-loop. (Task 5.3)
- `src/learning/reflection.js`: Post-session markdown writeup in `.agent/reflections/<sessionId>.md`. Includes exit reason, metrics table, top tools, error rate, hallucination count, what worked/improve. `writeReflection(sessionId, loopResult, memory, task)`. (Task 5.5)
- `src/learning/failureLearner.js`: Track repeated failures by normalized pattern key. `recordFailure(tool, args, error)` — returns skill suggestion after 3 occurrences. `getSkillSuggestions`, `clearPattern`. State in `.agent/learning/failure-patterns.json`. (Task 5.6)
- `src/learning/traceExport.js`: Export accepted traces to HuggingFace dataset JSONL format. Each trace → `{ id, messages: [{role,content}], reward, metadata }`. `exportTraces(outputPath, {includeRejected, minReward, redact})`. (Task 5.7)
- `src/learning/redactor.js`: Redaction pass per Q6. `redactString`, `redactTrace` (deep). Covers: OpenAI/Anthropic API keys (`sk-*`), AWS keys (`AKIA*`), bearer tokens, GitHub tokens (`gh[po]_*`), passwords, home directory paths, DB connection strings, JWT tokens. (Task 5.8)
- `src/learning/selfEval.js`: Deterministic 1–5 session grader (no LLM call). `evalSession(sessionId, loopResult, memory, task, sandboxResult)` — correlates with sandbox verifier. `loadSelfEvals`, `rollingAverageScore`. Persists to `.agent/learning/self-evals.jsonl`. (Task 5.9)
- `tests/learning.test.js`: 36 tests — skillGrader (5), skillConsolidator (4), offlineConsolidation (3), trace-logger gate (4), reflection (3), failureLearner (4), traceExport (2), redactor (6), selfEval (5). (Task test)

### Changed
- `src/training/trace-logger.js` (Task 5.4): Stricter `isAccepted` gate — now also rejects: traces with LLM latency > 120s (stall detection), traces with `reward_placeholder < 0.30` (minimum quality threshold). Two new constants: `LATENCY_STALL_MS = 120_000`, `MIN_REWARD = 0.30`.
- `src/config.js`: Added `learningDir: '.agent/learning'`, `reflectionsDir: '.agent/reflections'`.
- `src/state.js`: `initAgentDir` now creates `learningDir` and `reflectionsDir` on startup.
- `src/loop.js`: Imports `writeReflection`, `evalSession`, `recordFailure`/`getSkillSuggestions` from learning modules. On tool error: calls `recordFailure` (logs pattern suggestion if threshold hit). On `result('completed')`: calls `writeReflection` + `evalSession` (both non-critical — failures are caught).

### Status
- Tests: 388 pass, 0 fail (+36 learning tests from 352)
- Phase 5 COMPLETE: 5.1 ✅ 5.2 ✅ 5.3 ✅ 5.4 ✅ 5.5 ✅ 5.6 ✅ 5.7 ✅ 5.8 ✅ 5.9 ✅
- Exit criterion: `gradeAllSkills()` A→D. `consolidate()` merges near-dups. Trace export passes redaction test (synthetic API key → `[REDACTED_API_KEY]`). `evalSession` scores 1–5. Reflection written on completion.
- Next: Phase 6 (Observability + Production Hardening — Week 12)

---

## [v3.0.0-dev] — 2026-05-20 — Phase 0: Foundation Cleanup (COMPLETE)

### Fixed
- **LMMA heuristics** (`entityIntentExtractor.js`): `verify` intent pattern now matches "verification", "verified", "verifying" — previously only matched the exact word "verify"
- **LMMA Integration** (`memoryWriteback.js`): test-command routing now writes to `testing` bank (not `verification`) when a `run_command` action runs a test suite. Semantically correct: "testing" = test results, "verification" = verification stage events

### Added
- `src/verification.js`: extracted `verifyCompletion` and `buildCompactionAnchor` from `src/loop.js`. Both are now independently importable and testable. (Phase 0.7)
- `src/hallucinationDetector.js`: new module with three heuristic checks — exit-code mismatch, missing-file claim, repeated-command-claimed-as-different. Integrated into the training trace emitter; every step now records `hallucination_detected` and `hallucination_reasons`. (Phase 0.3)
- `.github/workflows/test.yml`: GitHub Actions CI running `node --test tests/*.test.js` on Linux and macOS on every push and PR. Also warns when `loop.js` grows past 1300 lines. (Phase 0.10)
- `KAIROS_CHANGELOG.md`: this file. (Phase 0.12)

### Changed
- `src/llm.js`: `chatCompletion` now returns `latencyMs: fetchDoneMs - fetchStartMs` (real fetch duration); also logged in `llm-log.jsonl` as `latency_ms`. (Phase 0.2)
- `src/loop.js`: `emitTrainingTrace` now passes `llmResponse?.latencyMs` — training traces have non-zero `latencyMs` for every LLM call. (Phase 0.2)
- `src/compaction.js`: RMT segmentation wired in as Phase 2b — when trace input exceeds `rmtLargeTraceTokenThreshold`, it is segmented via `segmentText` before the LLM summarization call. Also imports `normalizeCommandForComparison` to dedup commands in `buildFallbackSummary`. (Phase 0.4, 0.8)
- `src/state.js`: added `seedLmmaBanksFromContext(task, memoryMd)` — called on new task start in `loop.js` to pre-seed the `project` bank with task text and chunked MEMORY.md entries. (Phase 0.9)
- `USER.md`: populated with real user profile — role, technical background, preferences, project context, communication style. (Phase 0.6)
- `src/loop.js`: now imports `readLongTermMemory` from `identity.js` and `seedLmmaBanksFromContext` from `state.js`; calls seed after `writeTask`. Also reduced from 1298 → ~1200 lines (0.7 + 0.3 extractions).
- `skills/`: removed two duplicate nested dirs — `verification-before-completion/verification-before-completion/` and `webapp-testing/webapp-testing/`. (Phase 0.5)
- `package.json`: zero runtime dependencies confirmed — no deps to pin. (Phase 0.11)

### Status
- Tests: 211 pass, 0 fail
- Phase 0 COMPLETE: 0.1 ✅ 0.2 ✅ 0.3 ✅ 0.4 ✅ 0.5 ✅ 0.6 ✅ 0.7 ✅ 0.8 ✅ 0.9 ✅ 0.10 ✅ 0.11 ✅ 0.12 ✅
- Next: Phase 1 (MCP Foundation — Weeks 2-3)

---

## [v3.0.0-dev] — 2026-05-20 — Phase 1: MCP Foundation (COMPLETE)

### Added
- `src/mcp/client.js`: `McpStdioClient` (stdio/JSON-RPC 2.0) + `McpHttpClient` (SSE/HTTP) transports + `createMcpClient` factory. Zero external deps — Node builtins only. (Tasks 1.1, 1.2)
- `src/mcp/connectionManager.js`: spawn, health-check polling (configurable interval), crash detection, exponential-backoff reconnect, `connectAll` / `disconnectAll` / `getHealthyClients`. (Task 1.3)
- `src/mcp/toolAdapter.js`: `adaptTool` + `adaptServerTools` — converts MCP tool definitions to Kairos `{ definition, handler }` pairs with `<server>__<tool>` naming. Auto-approve / require-approval flags per tool. (Task 1.4)
- `src/mcp/registry.js`: aggregates all connected servers via `refreshRegistry`; exports `getAllMcpTools`, `getMcpToolEntry`, `isMcpToolName`, `executeMcpTool`, `getMcpToolSummary`. (Task 1.5)
- `src/mcp/resourceFetcher.js`: `read_resource` Kairos tool — reads MCP resources by URI across all servers; `list` flag lists available resources. (Task 1.7)
- `src/mcp/promptLibrary.js`: `get_mcp_prompt` Kairos tool — surfaces MCP prompt templates as skills; `list` flag enumerates them. (Task 1.8)
- `src/mcp/config-schema.json`: JSON schema for `mcp-servers.json` with all fields documented. (Task 1.9)
- `src/mcp/configValidator.js`: schema-based validator with line-numbered error messages; exports `validateConfig` + `loadAndValidate`. (Task 1.9)
- `mcp-servers.default.json`: curated 5-server bundle — filesystem, github, postgres, fetch, brave_search — all disabled by default with auto-approve/require-approval lists pre-configured. (Tasks 1.11, 1.12)
- `docs/MCP.md`: full user documentation — quickstart, config reference, approval model, resource/prompt usage, environment variables, example of writing an MCP server. (Task 1.14)
- `tests/mcp-github.test.js`: 17 tests — adapter/prefixing, registry helpers, config validation (7 cases), GitHub mocked transport integration. (Task 1.13)

### Changed
- `src/config.js`: added MCP config keys — `mcpEnabled`, `mcpConfigFile`, `mcpDefaultConfigFile`, `mcpConnectTimeoutMs`, `mcpCallTimeoutMs`, `mcpHealthIntervalMs`, `mcpMaxReconnectAttempts`. All gated behind `AGENT_MCP_ENABLED=1` (default off).
- `src/tools/index.js`: `executeTool` now async — routes `<server>__<tool>` names to `executeMcpTool` from the registry; built-in tools resolve synchronously. (Task 1.6)
- `src/routing/toolRegistry.js`: added `executeTool` (async, MCP-aware) and `getAllToolDefinitions` (built-ins + MCP defs) for context injection. (Task 1.6)
- `src/loop.js`: on startup, if `AGENT_MCP_ENABLED=1`, calls `connectAll` + `refreshRegistry` + logs tool count. `executeTool` call site now `await`-ed.
- `src/state.js`: added `setMcpServerStates` + `_mcpServerStates` cache — `saveCheckpoint` includes `mcp_servers[]` with health snapshots (written synchronously from cached state). (Task 1.10)

### Status
- Tests: 228 pass, 0 fail (+17 new MCP tests)
- Phase 1 COMPLETE: 1.1 ✅ 1.2 ✅ 1.3 ✅ 1.4 ✅ 1.5 ✅ 1.6 ✅ 1.7 ✅ 1.8 ✅ 1.9 ✅ 1.10 ✅ 1.11 ✅ 1.12 ✅ 1.13 ✅ 1.14 ✅
- Exit criteria: Adding a new MCP server = edit one JSON file, zero code changes. Curated 5-server bundle in `mcp-servers.default.json`. All tests green.
- Next: Phase 2 (Memory Palace + CEI) — blocked on CEI Phase 6 (Node.js port)

---

## [v3.0.0-dev] — 2026-05-21 — Phase 3: Multi-Agent Orchestration (COMPLETE)

### Added
- `src/agents/policy.js`: Role definitions — `ROLES`, `getRoleModel`, `getRoleMaxSteps`, `getRoleToolPolicy`, `getRoleDescription`. Per-Q7: each role has its own env var (`KAIROS_CONDUCTOR_MODEL`, etc.); Conductor separately pinnable. (Task 3.10, 3.11)
- `src/agents/taskSpec.js`: Conductor mini-language — `parseTaskSpec` (```taskspec block), `formatTaskSpec`, `defaultDecomposition` (Scout→Planner→Coder→Reviewer→Archivist). (Task 3.12)
- `src/agents/handoff.js`: Handoff contract — `writeHandoff`, `readHandoffs`, `buildHandoffContext`, `clearHandoffs`. Writes `.agent/handoffs/<sessionId>/<role>.md`. (Task 3.8)
- `src/agents/budget.js`: Per-agent token budget — `createBudget`, `defaultBudget`. Enforces per-role step limits + total session limit. One runaway agent cannot starve others. (Task 3.14)
- `src/agents/agentRunner.js`: Shared runner — wraps `runLoop()` with per-role model override, step budget, identity overlay injection, handoff write on completion. (Task 3.1)
- `src/agents/conductor.js`: Conductor agent — decomposes task, runs conductor loop, parses taskSpec, dispatches specialists in dependency order. (Task 3.2)
- `src/agents/scout.js`: Scout specialist — read-only discovery, ≤10 steps. (Task 3.3)
- `src/agents/planner.js`: Planner specialist — produces structured plan.md. (Task 3.4)
- `src/agents/coder.js`: Coder specialist — full edit tools, builds and tests. (Task 3.5)
- `src/agents/reviewer.js`: Reviewer specialist — verification + audit. (Task 3.6)
- `src/agents/archivist.js`: Archivist specialist — summary.md + learnings + skills. (Task 3.7)
- `src/agents/identity-overlays/{conductor,scout,planner,coder,reviewer,archivist}.md`: Per-role identity overlays loaded by agentRunner. Each defines principles, constraints, output format. (Task 3.9)
- `tests/multi-agent-e2e.test.js`: 36 tests — policy routing, taskSpec parse/format/round-trip, handoff write/read/context, budget enforcement, simulated 4-agent Snake pipeline, feature flag. (Task 3.16)

### Changed
- `src/config.js`: Added `multiAgentEnabled` flag — `AGENT_MULTI_AGENT=1` to enable; default-OFF per Q4 (RC). (Task 3.13)
- Episodic `who` field already wired via agentRunner (role name passed through task preamble; palace inserts use the running agent's context). (Task 3.15)

### Status
- Tests: 315 pass, 0 fail (+36 multi-agent tests from 279)
- Phase 3 COMPLETE: 3.1 ✅ 3.2 ✅ 3.3 ✅ 3.4 ✅ 3.5 ✅ 3.6 ✅ 3.7 ✅ 3.8 ✅ 3.9 ✅ 3.10 ✅ 3.11 ✅ 3.12 ✅ 3.13 ✅ 3.14 ✅ 3.15 ✅ 3.16 ✅
- Exit criterion: Policy maps stages→agents. taskSpec parses into assignments. Handoffs chain through all agents. Budget blocks runaway agents. Simulated 4-agent Snake pipeline runs end-to-end.
- Next: Phase 4 (Human-in-the-Loop — Weeks 9–10)

---

## [v3.0.0-dev] — 2026-05-21 — Phase 2: Memory Palace with CEI Backbone (COMPLETE)

### Added
- `src/palace/rooms.js`: Room graph builder — nodes = files/dirs, edges = parent-child + import/require relationships (JS/PY). Exports `buildRoomGraph`, `serializeGraph`, `deserializeGraph`, `getRoomNeighbors`. (Task 2.1, 2.2)
- `src/palace/walker.js`: BFS spatial walk from a starting room; returns ranked neighbors by hop distance. `findRoom` for fuzzy path matching. (Task 2.6)
- `src/palace/retrieval.js`: Hybrid retrieval combining spatial (room walk) + CEI-temporal + semantic + procedural modes; deduped + re-ranked top-K. `formatRetrievalResults` for context injection. (Task 2.7)
- `src/palace/consolidation.js`: Consolidation pass — calls `episodic-store.consolidate()` + flushes semantic/procedural caches. Called during compaction. (Task 2.8)
- `src/palace/importance.js`: Importance scoring heuristic (0–1) for episodic events: errors, recoveries, high-signal tools, early steps. (Task 2.9)
- `src/palace/semanticGraph.js`: Semantic triple store (subject, predicate, object) persisted as JSONL. `assert`, `queryBySubject`, `queryByObject`, `search`. (Task 2.4)
- `src/palace/proceduralIndex.js`: Procedural recipe extractor — auto-creates recipes after 3 similar successes. (Task 2.5)
- `src/palace/migrate.js`: One-time LMMA-banks → episodic-store migration; sentinel-protected idempotent; archives to `.agent/lmma/banks.archived/`; `--no-migrate` / `KAIROS_NO_MIGRATE=1` flag. (Task 2.11)
- `src/palace/session.js`: Palace session singleton — holds live `EpisodicStore` + `RoomGraph`; `initPalace`, `getPalaceSession`, `closePalace`, `refreshRoomGraph`. (Task 2.17 support)
- `src/tools/memory/recall_room.js`: Agent tool `recall_room` — hybrid retrieval by file/dir path. (Task 2.12)
- `src/tools/memory/recall_temporal.js`: Agent tool `recall_temporal` — before/after/range temporal queries via CEI. (Task 2.13)
- `tests/palace-e2e.test.js`: 13 tests — simulated multi-step task run, episodic recording, retrieval across all modes, consolidation, importance scoring. (Task 2.19)
- `tests/palace-decay.test.js`: 11 tests — decay math, link pruning at theta threshold, memory archiving with simulated clock, Proposition 1 steady-state. (Task 2.20)

### Changed
- `src/context.js`: Layer 4 now pulls top-5 palace memories via hybrid retrieval when `AGENT_USE_PALACE=1`. Imports `getPalaceSession` and `retrieve`/`formatRetrievalResults`. (Task 2.16)
- `src/loop.js`: Initializes palace session on startup; writes episodic event on every action result (with `who` field per N2); includes `palace_db_path` and `last_episodic_event_id` in checkpoint. (Tasks 2.15, 2.17)
- `src/compaction.js`: After compaction anchor, calls `consolidate(palaceSess.store)` for decay. (Task 2.14)
- `src/config.js`: `palaceEnabled`, `palaceDir`, `palaceDbFile` flags. (Task 2.18)
- `src/palace/episodic-store.js`: Fixed decay SQL — `UPDATE links SET weight = weight * :factor` without WHERE clause so all links are decayed before pruning (bug: previously links whose new weight < theta were skipped, making them un-prunable).

### Status
- Tests: 279 pass, 0 fail (+24 palace tests from 255)
- Phase 2 COMPLETE: 2.0 ✅ 2.1 ✅ 2.2 ✅ 2.3 ✅(skipped-CEI) 2.4 ✅ 2.5 ✅ 2.6 ✅ 2.7 ✅ 2.8 ✅ 2.9 ✅ 2.10 ✅ 2.11 ✅ 2.12 ✅ 2.13 ✅ 2.14 ✅ 2.15 ✅ 2.16 ✅ 2.17 ✅ 2.18 ✅ 2.19 ✅ 2.20 ✅
- Exit criterion: Fresh Kairos run creates `.agent/palace/episodic.db`. Inserts happen during run. Layer 4 context includes palace retrieval. LMMA migrated without loss. Palace E2E + decay tests green.
- Next: Phase 3 (Multi-Agent Orchestration — Weeks 7–9)

---

## [v3.0.0-dev] — 2026-05-21 — CEI Phase 6: Node.js Port (COMPLETE)

### Added
- `src/palace/episodic-store.js`: 1:1 Node.js port of `CEI_Model/emile_paper/experiments/cei_index.py`. Uses `node:sqlite` (built-in, Node ≥22.5). Exports `EpisodicStore`, `contentHash`, `bucketIndex`, `getEpisodicStore`, `closeEpisodicStore`. Schema is identical to Python version (memories + links tables, same column names and types). WAL mode + busy_timeout=5000ms for concurrent safety. (Tasks 6.1–6.10)
- `src/palace/EPISODIC_SCHEMA.md`: standalone schema reference — SQL tables, full API contract, decay semantics, Python parity guarantees, migration notes. (Task 6.13)
- `tests/episodic-store.test.js`: 27 tests covering all query types (queryTemporal, queryBefore, queryAfter, queryMostRecent), insert/count, links, consolidate (decay + pruning), exportSnapshot, WAL persistence, singleton, and performance (100k inserts <10s, 1k queries <100ms). Includes Python-parity test: `contentHash('hello') === '2cf24dba5fb0a30e'`. (Tasks 6.11, 6.12)

### Changed
- `who` field added to memories schema (N2: every event tagged with agent name; defaults to `'kairos'`, user-driven events use `'user'`).

### Status
- Tests: 255 pass, 0 fail (+27 episodic-store tests)
- CEI Phase 6 COMPLETE: 6.1 ✅ 6.2 ✅ 6.3 ✅ 6.4 ✅ 6.5 ✅ 6.6 ✅ 6.7 ✅ 6.8 ✅ 6.9 ✅ 6.10 ✅ 6.11 ✅ 6.12 ✅ 6.13 ✅
- Exit criterion met: `npm test -- tests/episodic-store.test.js` green. Python-parity test passes on SHA-256 fixture.
- **Phase 2 (Memory Palace) is now unblocked.**

---

## [v2.x] — prior to 2026-05-20

See git log for v2 history. v3 development begins from the v2 codebase
(`Advanced-agent-loop4/`) as the base, preserving all existing behavior
under feature flags (`AGENT_MULTI_AGENT`, `AGENT_USE_PALACE`, etc.).
