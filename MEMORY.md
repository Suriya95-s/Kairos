# MEMORY.md — Long-term Knowledge

_Curated facts and knowledge that persist across sessions._

## Project Facts
- The loop now includes an LMMA integration path under `src/lmma/` with file-backed state in `.agent/lmma/`.
- LMMA now also has a benchmark helper module for comparing baseline and LMMA runs from workspace artifacts.
- The loop now supports both legacy executable markdown skills and standards-based `SKILL.md` reference skills from project skill directories.
- The preferred repo-managed location for standards-based skills is now `skills/`, with `.agents/skills/` and `.claude/skills/` still supported as secondary sources.
- The spec-driven V2 pass added file-backed RWKV controller metadata in `.agent/rwkv/`, RMT helper state in `.agent/rmt/`, and offline training traces in `.agent/training/`.
- The runtime now records richer LMMA route state including route path, route summary, bank confidence, cache status, and per-bank importance statistics.

## Architecture Decisions
- LMMA is integrated as a runtime memory-routing subsystem inside the loop, not as a prompt-only trick.
- The LMMA hardening pass should remain heuristic and artifact-driven rather than task-specific or hardcoded to known demos.
- RWKV is currently integrated as a truthful controller bridge with hosted-LLM fallback and persisted state surfaces, not as a fake in-process recurrent model.

## Gotchas & Warnings
- Local verification is currently blocked in this environment because no `node` executable is available.

## Useful Commands
- When Node.js is available, run `node --test tests/lmma-integration.test.js`.
