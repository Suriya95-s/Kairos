# USER.md — About the User

## Identity
- Email: s654231@gmail.com
- Researcher and developer building Kairos — an advanced agentic loop with episodic memory and multi-agent orchestration.

## Technical Profile
- Has deep enough ML/NLP knowledge to design original research (CEI/EMILE model with SQLite B-tree episodic index, link decay, TPB benchmark).
- Comfortable with Node.js and Python. Can read and direct implementation work but delegates execution to the agent.
- Uses Claude Code interactively — switches between Opus (planning) and Sonnet (execution) intentionally via `/model`.

## Preferences
- Prefers direct execution over abstract planning. Once a plan is locked, move fast.
- Wants breadth covered in a session: complete all remaining Phase 0 tasks, not just one at a time.
- Uses token budget explicitly ("use up to 80% of token usage") — respects context limits.
- Does not need recaps or hand-holding; short confirmations between tasks are fine.
- Wants a persistent `codex0changes.md` ledger with every touched file and concrete changes recorded during implementation.
- Wants a check-in before any change that goes beyond the requested MD scope.

## Project Context
- Building Kairos v3.0 on top of `Advanced-agent-loop4/` (do not rewrite — evolve in place).
- CEI (Chronological Episodic Index) is planned as the episodic backbone for the Memory Palace (Phase 2).
- Phase 2 blocks on CEI Phase 6 completion (Node.js port + paper finalized).
- Feature flags gate all new features: `AGENT_USE_PALACE`, `AGENT_MULTI_AGENT`, `AGENT_MCP_ENABLED`, `AGENT_HITL_REQUIRED` — all default OFF in RC.
- Training traces (accepted-traces.jsonl) are a first-class output: must have real latency, hallucination flags, and correct LMMA routing.

## Communication Style
- Terse. Does not need explanations of what was done — cares about what changed and what's next.
- Will say "continue" to resume interrupted work; pick up exactly where it left off.
