# Ontology Engine v2 + Agentic Graph Engineering

Status: DRAFT — no workstream authorized yet (owner authorizes by name).
Supersedes nothing: builds on the live O1–O3 engine (see
2026-08-13-ontology-engine.md). LOGOS remains the governance reference, but
this plan treats it as what it is — an old snapshot — and designs past it.

## Why "agent graph engineering", in plain terms

Two phrases sound alike; we mean the first, and eventually get the second
for free:

1. **Agentic graph engineering** — using LLM agents to BUILD and MAINTAIN a
   knowledge graph: extracting entities and relations, resolving duplicates,
   enriching semantics, repairing drift — always as governed proposals. Our
   verifier (O3) is already the embryo of this.
2. **Graph-of-agents** — wiring multiple agents into a topology. Not this
   plan. (If ever wanted, the brain plan's B4 global workspace is the frame.)

### Why apply it here — the five concrete payoffs

- **The graph becomes the loop's world model.** Today Kairos's memory is
  episodic text. A knowledge graph is structured, typed, evidence-backed
  memory that outlives any context window: "which customer had a GPU-driver
  ticket on an order above ¥1M" is one traversal, not a lucky embedding hit.
- **Multi-hop questions need edges, not similarity.** Vector RAG retrieves
  what *sounds like* the question; graph retrieval WALKS relations
  (Customer→Order→Ticket). Multi-hop, aggregate, and "why" questions are
  where similarity search fails and traversal is trivial.
- **Grounding is structural, not statistical.** Every node carries
  EvidenceRefs to content-addressed bytes. An answer assembled by traversal
  cites rows; a hallucination has no path. The lexical-grounding trick from
  LOGOS becomes unnecessary where the path itself is the proof.
- **Deterministic induction has a hard ceiling** (the cons list): syntactic
  FKs, filename type names, no unification, no semantics. The only way past
  that ceiling without giving up governance is agents that PROPOSE graph
  edits through the same publish boundary — that is agentic graph
  engineering, precisely.
- **Explainable review.** Human approval scales because a proposed edit is
  visible in a graph ("merge these two nodes, here's why, here's the
  evidence"), not buried in a table of JSON.

## Design tenets (carried forward, non-negotiable)

- Deterministic floor: everything works with zero API keys; models only add.
- Agents propose, humans dispose; approver ≠ proposer; enforced in the store.
- Content addressing + append-only journal + evidence refs on every claim.
- PII redacted before any model call; fail-closed prompt guard.
- Model-visible lists generated from constants; drift refuses to boot.
- Zero runtime dependencies; Node ≥18 stdlib only.
- One workstream authorized at a time; negative controls per slice.

## Workstreams

### G0 — Foundations hardening (no model; fixes the known cons)
The v1 engine's honest weaknesses, fixed before anything is built on top:
- Projection cache: fold once, invalidate by journal mtime/length — reads
  stop being O(journal) per call. Optional journal compaction into a
  checkpoint doc (history preserved in an archive segment, never deleted).
- Journal write lock (advisory lockfile) so daemon + CLI can't race versions.
- Incremental link discovery: only re-scan pairs touched by the new ingest.
- Release pinning (pulled forward from old O4): `kairos ontology release
  <domain>` freezes the current approved set as an immutable, hash-addressed
  release doc; queries may pin one. Same-release ⇒ same answer, forever.
- Negative controls: stale cache serves wrong counts → test fails; two
  concurrent appends → one blocks; tampered release → refused.

### G1 — Induction v2 (no model; raise the deterministic ceiling)
- Type unification: same induced type name across files merges property
  sets explicitly (union + per-property provenance) instead of last-write.
- Header-driven type hints (`date`, `id`, `price` suffixes), identifier vs
  quantity distinction, calibrated enum detection.
- Name handling: multi-locale-safe naming (keep原文 as `sourceName`, ASCII
  slug as id), pluralization table instead of regex chains.
- PII v2: name-aware redaction using the domain's own key columns (values of
  person-name-like columns tokenize as [PII_NAME_n]) — deterministic, no NER
  model needed, because the ontology already knows which columns are names.

### G2 — Agentic graph engineering (model; the verifier grows up)
- New proposal ops (closed set, store-applied): `merge_types`,
  `retire_relation`, `retype_property`, `merge_instances` (entity
  resolution: same real-world thing across files), `annotate` (semantic
  tags/units). Each op gets an applyProposal branch + negative control.
- Entity-resolution pass: deterministic candidate pairs (shared keys, fuzzy
  field equality) → agent judges each pair (structured output, confidence
  gate) → merge proposals with BOTH sides' evidence.
- Incremental verification: enrichment keyed per type/subgraph hash, so one
  new file re-reviews only the slices it touched — no whole-domain re-spend.
- Critic lens: a second pass prompted to REFUTE existing candidate relations
  (finds the false FKs the overlap heuristic invents). Refutations are
  `retire_relation` proposals — still only proposals.

### G3 — The graph as the loop's memory (model; GraphRAG, governed)
- Deterministic traversal primitives in the store (no model): neighbors,
  typed paths, filtered walks, aggregates. Exposed to missions as tools.
- Query plan objects (the good half of old O4): a question over a domain
  pins a release + a retrieved subgraph + allowed claims; generation
  receives THE SUBGRAPH, not the journal; the answer must cite node ids that
  exist in the pinned subgraph (structural grounding check).
- Router integration: "ask <domain> …" / voice questions route through the
  graph plane, with receipts on the bus.
- Loop memory bridge: mission outcomes may PROPOSE instances/relations into
  a `kairos` meta-domain (what the loop learned, as governed graph facts).

### G4 — Living graph & review UX (no model)
- Temporal edges: ingests already timestamp everything; expose as-of views.
- Graph UI v2: proposal overlay (dashed edges/nodes for pending proposals,
  click → approve/retire via a local action file the daemon applies),
  diff view between releases.
- TUI page 7: proposal review queue with per-item approve/retire keys.

## Sequencing & gates

G0 → G1 are offline and cheap; either can start on authorization today.
G2 → G3 need a model with headroom (the owner's separate API key, vaulted,
or the weekly gateway reset). G4 anytime after G2 exists to review.
Recommended order: **G0, G1, G2, G3, G4** — foundations before intelligence,
intelligence before memory, memory before polish.

Nothing starts until the owner authorizes a workstream by name.
