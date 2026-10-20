# The Ontology Engine — Kairos learns to develop ontologies from data

**Status: DESIGN — no workstream authorized yet.**
Base study: `C:\Users\10568.ADTW\Documents\logos-code` (LOGOS, an ontology-driven
support platform — a working miniature of Palantir Foundry). This doc decrypts
LOGOS's load-bearing logic and maps it onto Kairos so the *loop itself* can
build, govern, and answer through ontologies induced from raw data.

---

## The thesis (what makes this Palantir-like, not a data catalog)

LOGOS's whole architecture reduces to one sentence, stated inside its own
glossary: **the LLM gets a permission slip, not a library.** RAG — "retrieve a
pile and let the model decide facts and policy" — is the *rejected pattern*,
defined as such in the ontology itself. Every mechanism below exists to enforce
that sentence, and the Kairos engine keeps it as its invariant:

> Everything the model may claim must be traceable to an approved, versioned,
> evidence-backed ontology release. Everything else is mechanically rejected.

This composes perfectly with Kairos's existing spine: "modulation may change
HOW MUCH, never WHETHER" (B1) and "agents propose, humans dispose" (HITL) are
the same idea. The ontology engine is the knowledge-plane version of it.

## The seven mechanisms decrypted from LOGOS (verified in code)

1. **Two-representation ontology + load-time contract check.** A declarative
   YAML half a human can review, an executable half services import, and a
   validator that cross-checks them at import time — drift refuses to boot.
   Verified: `packages/domain/src/domain-contract.ts` (~205 lines, **zero YAML
   library** — a hand-rolled line scanner + schema parse). Directly portable
   to Kairos's zero-dependency rule.
2. **Model the negative space.** `blockedActionTypes` (10, each with a reason)
   are first-class ontology, validated to never appear as published actions,
   and given runtime teeth as prohibited-claim regexes. An ontology that only
   says what's possible can't cage a model; one that says what's forbidden and
   *why* can.
3. **Content-addressing + releases as the consistency anchor.** Snapshot IDs,
   build input hashes, release manifests, run IDs — all sha256-derived.
   Identical inputs replay idempotently; same ID with different bytes throws;
   a release immutably pins exact object versions and every decision pins
   exactly one `releaseId`.
4. **A decision object between retrieval and generation.** Retrieval never
   feeds the model directly — it feeds a *plan* (allowed claims/links,
   required questions, prohibitions, evidence refs, exactly one permitted
   action + the blocked list). Generation is constrained to the plan; a
   validator checks the output against it mechanically. Verified:
   `validateDraftAgainstPlan` at `packages/platform/src/index.ts:1035-1097` —
   ~60 lines of pure functions: ALLOWED_LINKS_ONLY (every URL ∈
   plan.allowedLinks), PROHIBITED_CLAIMS (regexes from the plan),
   REQUIRED_QUESTIONS (in request-more-info mode), LEXICAL_GROUNDING (every
   sentence ≥8 chars needs ≥0.14 trigram overlap with plan text — free
   composition is mechanically rejected), NO_NEW_PII (warning-only). The 16
   prohibited-claim regexes live in
   `packages/domain/src/customer-support/planning.ts:4-21`.
5. **Deterministic floor under every model.** All 8 function types declare
   `deterministicFallback: true`. Keyword classifier under the LLM classifier,
   n-gram search under OpenSearch, template assembly under drafting. Zero API
   keys → product still works. Kairos already lives this (reflex tier, 429
   survival); the ontology functions must too.
6. **Everything emits a receipt** (transactional outbox, per-object timelines).
   Verified: the chokepoint is a `commandFor(request, actionType, input) →
   emit(receipt)` pair *injected into every domain adapter*
   (`services/runtime/src/domains/types.ts:24-25`), with the outbox
   enqueue/attempt/retry in `services/runtime/src/app.ts:161-192`. The store
   is one generic `documents` table cloned per schema
   (`infra/postgres/init/001-databases.sql:6-18`). Kairos equivalent: the bus
   + `ActionReceipt`-shaped events, persisted in
   `~/.kairos/bus/events-*.jsonl` — which already saved this project once
   (ontology-study.md was recovered byte-for-byte from it).
7. **Separation of duties + gates in the store, not the UI.** Submitter ≠
   reviewer, self-approval → 400, named release gates. Kairos equivalent:
   HITL approvals + finish gates (and now the verification circuit breaker).

**Publish boundary (the induction cage):** candidates flow through
`candidate → in_review → approved/active → retired`; only `system_verified` or
`human_confirmed` may publish; **a candidate without an EvidenceRef can never
publish regardless of review status**. This is the exact contract that makes
"the loop develops an ontology out of data" safe.

## The meta-model Kairos adopts (contract element inventory)

| Element | What it defines | Detail worth keeping |
|---|---|---|
| Object type | entity/event | + category (source/derived/decision/interaction/action/audit) + risk level |
| Property | attribute | sensitivity labels (`restricted_pii`) drive redaction |
| Relationship type | typed edge | declared vs runtime-only distinguished |
| Action type | permitted mutation | `writesToSystemOfRecord`, approval level, observation strategy |
| **Blocked action type** | forbidden mutation **with reason** | validated against the allowed list |
| Function type | pure computation | `deterministicFallback` + `evidenceRequired` flags |
| State model | object lifecycle | deliberately missing edges are policy (blocked ↛ approved) |
| Policy binding | role × target × decision | allow / require_review / deny |
| Source authority | where a fact may come from, per type | "existence ≠ business approval" |
| Publish boundary | which candidate states may publish | evidence required regardless of review |
| Candidate types | proposal types → target entity type | the loop's only write surface |
| Business terms | glossary incl. rejected patterns | the thesis lives in the data |

## How it mounts on Kairos

```
~/.kairos/ontology/<domain>/          the declarative contract (YAML, human-reviewable)
src/ontology/contract.js              loader + validator (zero-dep, adapted line scanner)
src/ontology/store.js                 documents-store + typed projections (JSONL, content-addressed)
src/ontology/candidates.js            candidate lifecycle + publish boundary + evidence refs
src/ontology/release.js               immutable release manifests, activate/rollback
src/ontology/plan.js                  the decision object + draft-vs-plan validator
src/missions/profiles.js              new `ontologize` profile (see O3)
```

- **The loop is the build-time agent.** LOGOS's SKILL.md agents ("crawl, emit
  CandidateAssets, never activate, never approve") are exactly a Kairos
  mission. `ontologize` missions read data and may ONLY emit candidates with
  evidence refs — enforced by the profile's tool allowlist and finish gates,
  the same machinery that already gates build/research/errand.
- **HITL approvals are the review plane.** Candidate promotion is an approval
  event on the bus; self-approval is structurally impossible (the mission
  actor ≠ the approving human).
- **The bus is the audit plane.** Every candidate/publish/release mutation
  emits a typed bus event (registered in EVENT_KINDS — we know what silent
  discard looks like).
- **B4 (global workspace) consumes this.** The multi-model brain's "permission
  slip" per model is an ontology projection: allowed claims + blocked actions
  per decision. The ontology engine is B4's knowledge substrate.
- **The domain-adapter seam, verified and worth copying:** a LOGOS domain
  mounts with just `{ domainCode, routePrefix, mountRoutes(app, options) }`
  where `options` injects the stores plus the `commandFor → emit(receipt)`
  audit pair (`services/runtime/src/domains/types.ts`, 32 lines; foundry's
  is 73). Kairos's version: an ontology domain registers `{ domainCode,
  contractDir, instanceData }` with the engine — engine code never mentions
  a domain by name.

**Portability check (why this fits a zero-dep loop):** the entire governance
core is under 500 lines with no heavy dependencies — contract loader+validator
204 (no YAML lib), planning/permission-slip 137, draft validator ~60, adapter
interfaces 32+73. The bulk of LOGOS (Hono services, Postgres, OpenSearch,
Vue) is delivery mechanism we replace with what Kairos already has: daemon,
bus, missions, HITL, TUI.

## Workstreams (each individually authorized, negative-control gated)

### O1 — Contract kernel (no model needed)
The YAML contract format (kairos flavor of the 8-file inventory), loader, and
`validateOntologyAgainstContract()` wired into daemon boot for any mounted
domain. Zero-dep line-scanner parsing, adapted from LOGOS.
- Tasks: contract file conventions (`<domain>-<suffix>.v1.yaml`), loader,
  validator (superset rule, blocked-not-published rule, publish-boundary
  rule), `kairos ontology check <domain>` CLI, boot integration (refuse to
  serve a drifted domain, not refuse the whole daemon).
- **Negative controls:** publish a blocked action → boot check fails; remove a
  YAML entity from the executable half → named issue; tamper publish boundary
  → named issue. Each control must fail its *specific* test when the guard is
  disabled.

### O2 — Evidence store & snapshots (no model needed)
Content-addressed source snapshots (`snapshot:<sha256[0:24]>`), a
documents-style JSONL store with typed in-memory projections, EvidenceRef
(`snapshot + objectVersion + contentHash`), and idempotent build keys.
- **Negative controls:** re-register same ID with different bytes → throw;
  identical build inputs → replay, not duplicate; object without lineage →
  cannot enter a release.

### O3 — The induction pipeline (the loop develops the ontology; model needed)
New `ontologize` mission profile: stages connect → induce → review-prep →
finalize. The loop snapshots sources, proposes entity/relation/scene/policy
*candidates* — each carrying evidence refs quoting the snapshot — and produces
a review packet. It can NEVER publish: promotion requires a human approval
through HITL, and the publish boundary rejects evidence-less candidates
mechanically.
- Profile gates: requireFileModifications (the candidate set is the artifact),
  requireEvidence (new gate: every candidate has ≥1 EvidenceRef), no smoke
  test. Router signals: "build an ontology", "ontologize", "model this data".
- **Negative controls:** candidate without evidence → publish blocked; mission
  attempting direct publish → tool not in allowlist; approve from the mission
  actor → rejected (separation of duties).

### O4 — The governed decision plane (model needed)
Release-scoped query + the plan/decision object: answering from the ontology
means (1) pin the active release, (2) build a plan (allowed claims/links,
prohibitions from blocked actions, evidence refs), (3) generate constrained to
the plan, (4) validate mechanically (allowed-links-only, prohibited-claim
regexes, lexical grounding overlap, required questions), (5) failed drafts
regenerate deterministically. Wires into the router/voice so "ask Kairos about
<domain>" answers through the ontology, with receipts.
- **Negative controls:** draft citing a URL outside the plan → check fails;
  prohibited-claim regex match → blocked (and blocked ↛ approved); search
  returning an object the release doesn't pin → filtered out.

## Three traps LOGOS itself fell into (avoid from day one)

1. **Derive everything model-facing from the contract.** LOGOS hardcodes a
   6-entry model-facing blocked-actions list vs 10 in YAML — verified at
   `planning.ts:115-122` (the same file also hardcodes the model-visible
   objectCodes and functionCodes arrays — three drift-prone lists in one
   file). The exact drift the architecture exists to prevent, snuck in
   through one shortcut, and no test catches it. Kairos rule: any list a
   prompt sees is *generated* from the loaded contract, and a test pins the
   equality.
2. **Every schema checked or deleted.** LOGOS's canonical-model YAMLs are
   unvalidated documentation and have already drifted from the TS properties.
   If a file isn't enforced, it will lie. Kairos rule: the validator covers
   every file the contract loader reads, or the file doesn't ship.
3. **Domain heuristics stay out of the engine.** LOGOS's planner embeds
   literal FAQ IDs and hand-tuned rerank boosts (+720). Engine code is
   domain-blind; scene-specific knowledge lives in the domain's own contract
   and instance data — or the second domain forks the engine.

## Known LOGOS defects (do not import)

- Missing `teams-meeting` domain folders → runtime/foundry won't typecheck as
  snapshotted; ignore that domain entirely.
- Dockerfile `COPY patches` of a nonexistent dir; `@logos/docs` referenced but
  absent. Irrelevant to us (we port patterns, not the build).
- One 3,836-line App.vue with zero tests — the UI is a reference for the
  Workbench *ideas* (live blueprint, step chips, receipt timeline — the TUI
  already does the equivalent), not for its code.

## Sequencing & fit

O1 → O2 are offline and cheap (like B1: pure logic + tests). O3 needs a model
with headroom (gateway quota currently exhausted — weekly reset applies) and
is the first "Kairos develops an ontology" demo: point it at a real corpus,
get a reviewable candidate set. O4 completes the loop: Kairos *answers
through* what it built, under the same discipline that governs everything
else. B4 (global workspace) then distributes ontology projections per model.

Nothing starts until the owner authorizes a workstream by name.

## Cross-check vs the owner's LOGOS extraction (2026-08-14)

The owner supplied `C:\Users\10568.ADTW\Documents\logos-code\ONTOLOGY-ENGINE-FUNCTIONALITIES.md`,
a complete functionality inventory of LOGOS. It agrees with the seven
mechanisms above; status against it: O1/O2 already cover content-addressed
snapshots (§2.2), candidate lifecycle + human review (§2.4), separation of
duties in the store (§2.5), document journal → typed projection (§7),
evidence refs, idempotent re-ingest, and works-with-zero-API-keys (§1.8 —
our induction IS the deterministic floor). Release bundles (§2.6–2.7, §3.1),
the plan object (§4.3), and the five draft checks (§4.5) are O4 as designed.

**Three additions it forces into O3 (the verifier/`ontologize` agent):**

1. **PII redaction before the model (§4.1).** Dropped files contain real
   emails/names (the live btoshop drop already does). Before any candidate
   payload reaches the verifier LLM, tokenize PII (`[PII_EMAIL_1]`-style,
   stable per domain); the mapping never leaves the store. Evidence refs are
   locators, not content, so lineage survives redaction. Negative control:
   a raw email in the prompt assembly → test fails.
2. **Confidence-gated structured output with a deterministic floor (§4.2).**
   The verifier proposes via forced structured output only; proposals under a
   confidence threshold are discarded; if the model call fails entirely, the
   induced candidate set stands unchanged — enrichment is strictly additive,
   availability never depends on the model.
3. **Proposal-only output contract (§2.8).** The verifier's output schema
   pins `writesToStore: false`-equivalent mechanically: its results are
   appended as candidates `proposedBy:'kairos-verifier'` and the store's
   existing approver≠proposer rule makes self-approval impossible. Its
   model-visible projection (allowed + blocked actions) is *generated* from
   the store, never hand-written (trap #1).

Also adopted for O3: idempotency by input hash (§2.3) — enrichment keyed on
(domain, projection version, snapshot set); re-running on an unchanged domain
is a replay, not a spend.
