# Brain-inspired mechanisms for Kairos

> **For agentic workers:** Implement workstream-by-workstream. Each workstream ends
> with the full suite green (`node --test tests/*.test.js`) and a negative-control
> pass. Do not start the next workstream without the owner's authorization.

**Origin:** arXiv:2408.14811v1, *Brain-inspired Artificial Intelligence: A
Comprehensive Review* (Ren & Xia, 2024). The survey itself is a taxonomy, not a
method — its value here is that it names the mechanisms Kairos is missing. This
plan implements the four that the survey **under-covers** and that actually
matter for an always-on assistant: predictive coding, replay, neuromodulation,
and a cognitive architecture (global workspace).

**Goal:** Give Kairos a coherent internal state and an economy of attention.
Today every subsystem makes its own judgement about urgency, cost, and
confidence, from its own local view. These four mechanisms give them one shared
sense of *how things are going* and one shared rule for *what deserves compute*.

**Tech stack:** Node ≥18 ESM, zero runtime deps, `node --test`. New code lives in
`src/brain/`. Every module is pure and injectable — no module-level state, no
ambient clock, no I/O in the decision functions. Test command per file:
`node --test tests/<file>.test.js`. Full suite: `node --test tests/*.test.js`.

---

## What Kairos already has (do not rebuild)

The behaviour-inspired half of the survey is largely already here under other
names. Building these again would be the main risk of this plan.

| Mechanism | Existing implementation |
|---|---|
| Memory hierarchy | working-memory window + `compaction.js` + `palace/` episodic + `lmma/` banks |
| Synaptic pruning / unlearning | `memoryd/consolidate.js` (decay → merge → prune), `learning/skillConsolidator.js` |
| Selective attention | `router/classify.js` + `router/dispatch.js` |
| Transfer / few-shot | `skills.js` + `.agent/skills` |
| Learning from consequences | `selfimprove/` (router training, metrics, promotion) |
| Change detection | `triggers/watchers.js` — reports transitions, not states |
| Interruption etiquette | `triggers/etiquette.js` — urgency × user state × hour |

**The gap is not knowledge, it is disposition.** Kairos knows a great deal about
its situation and does nothing global with it.

---

## Workstream B1 — Neuromodulation (the internal state)

**Status: ready to build. No model required. Blocks B2–B4.**

### The brain idea

Neuromodulators (dopamine, norepinephrine, acetylcholine) do not carry content.
They set the *gain* of everything at once: under high arousal the brain is
faster, narrower, more reflexive; under low arousal it is slower, broader, more
exploratory. One global state, many local effects.

### The Kairos gap

The inputs already exist and are read ad hoc at each call site: `inferUserState()`
in etiquette, `daemon.health`, `isOverDailyBudget()`, `runningMissions.length`,
recent mission outcomes. Nothing combines them, so the reflex's 8-second budget
is 8 seconds whether the user is mid-sentence or asleep, and model choice never
reflects how much trouble the system is currently in.

### Design

`src/brain/neuromodulator.js` — two pure functions and a frozen state shape.

```
readState({ userState, health, runningMissions, spendRatio,
            recentOutcomes, hour, now })  →  { arousal, load, confidence }
modulate(base, state)                     →  a NEW settings object
```

Three dials, each `0..1`:

- **arousal** — how much *now* matters. Rises with an attached, active user, an
  urgent intent, a live mission failure. Falls when nobody is there.
- **load** — how contended the system is. Concurrent missions, budget spend
  ratio, degraded health.
- **confidence** — recent success rate over the last N mission/reflex outcomes.

What they modulate, concretely (a dial with no consumer is decoration):

| Consumer | Base | Modulated by |
|---|---|---|
| `reflex/engine.js` latency budget | 8000ms | high arousal → shorter (answer now); low arousal + low load → longer |
| `llm.selectModelForStage()` | stage table | high load or budget pressure → cheap tier; low load + low confidence → strong tier |
| `config.temperature` | profile value | low confidence → lower temperature |
| `etiquette.decideDelivery` thresholds | fixed | high arousal lowers the bar for `speak`, raises it for `digest` |
| `memoryd` consolidation | idle-only | runs only at low arousal **and** low load |

### The safety line — non-negotiable

**Neuromodulation may change *how much*, never *whether*.** Budgets, deadlines,
thresholds, model tier, temperature: modulable. Trust tiers (`trust/tiers.js`),
HITL gates, path confinement, the reflex tool allowlist, T3 refusal: **never
modulable, under any state.** A global that can relax a safety gate is not a
neuromodulator, it is a privilege-escalation path with a biological name.

`modulate()` therefore takes only the settings object it is allowed to touch and
returns a new one. It never mutates, never reaches into config, and there is a
test asserting that a maximal-arousal state leaves every gate exactly where it
was.

### Files

- Create: `src/brain/neuromodulator.js`
- Create: `tests/brain-neuromodulator.test.js`
- Modify (consumers, one at a time): `src/reflex/engine.js`, `src/llm.js`
  (`selectModelForStage`), `src/triggers/etiquette.js`, `src/kernel/daemon.js`
  (compute state once per tick, publish on the bus as `brain` events)

### Tasks

- [ ] **B1.1** `readState()` + `modulate()`, pure, fully injectable
- [ ] **B1.2** Tests: dial monotonicity, clamping at both ends, `modulate` purity
      (input object unchanged), and **the gate-invariance test**
- [ ] **B1.3** Wire the reflex latency budget; assert an away-user reflex gets a
      longer budget than a mid-conversation one
- [ ] **B1.4** Wire `selectModelForStage`; assert budget pressure downgrades tier
- [ ] **B1.5** Daemon computes state per tick and publishes it; TUI header shows it
- [ ] **B1.6** Negative control: force `arousal = 1` and assert the gate-invariance
      test fails if any safety gate is added to the modulable set

### Risks

A single global read by everything is a global variable wearing a lab coat. The
mitigations are that it is *computed*, never *set*; it is passed as an argument,
never imported as state; and every consumer keeps working if it is absent
(`modulate(base, null) === base`).

---

## Workstream B2 — Predictive coding (surprise as the attention currency)

**Status: ready to build after B1. No model required.**

### The brain idea

The cortex continuously predicts its own input and propagates only the *error*.
Attention and metabolism go to what was not expected. Expected input, however
dramatic, is cheap.

### The Kairos gap

`watchers.js` reports on **change**, which is a crude proxy for surprise, and the
difference bites in exactly the case that matters. A flaky test that flips
pass→fail→pass every poll produces a notification every poll — each one is a
genuine change, and none of them is news. Meanwhile a watcher green for 200
consecutive polls that finally goes red produces one notification with exactly
the same weight. The system cannot tell routine flapping from a real event.

### Design

`src/brain/surprise.js` — a small per-observer state model, pure.

```
class SurpriseModel {
  observe(state)        // record an observation
  surpriseOf(state)     // -log2 P(state | history), in bits; 0 = fully expected
  toJSON() / fromJSON() // persisted alongside the watcher
}
```

Frequency-based, not a neural net: a bounded ring of recent states plus
transition counts, Laplace-smoothed. A first-ever observation is maximally
surprising; a state seen in 90% of polls is ~0.15 bits.

Two consumers:

1. **Watchers** attach surprise to every report. Etiquette then takes surprise as
   an input alongside urgency, so low-surprise changes route to `digest` and
   high-surprise changes route to `speak`. The flapping test stops shouting
   without anyone having to configure a flap filter.
2. **The loop** compares predicted step outcome to actual. The resulting error is
   the priority signal B3 samples on.

### The trap to design around

High-cardinality states are permanently surprising. A watcher in `mtime` mode, or
any probe whose state embeds a timestamp or a hash, produces a novel state every
single poll — under a naive model, infinite surprise forever, which is worse than
today's behaviour. `SurpriseModel` therefore detects cardinality growth
(distinct states ≈ observations) and degrades to binary changed/unchanged
scoring, which is exactly today's semantics. **This case gets a test before the
feature does.**

### Files

- Create: `src/brain/surprise.js`
- Create: `tests/brain-surprise.test.js`
- Modify: `src/triggers/watchers.js` (attach surprise to reports),
  `src/triggers/etiquette.js` (accept surprise as a delivery input)

### Tasks

- [ ] **B2.1** `SurpriseModel` with Laplace-smoothed transition counts + bounded history
- [ ] **B2.2** Tests: first observation is maximal; a repeated state decays toward 0;
      an unseen state after a long stable run scores high
- [ ] **B2.3** The high-cardinality degradation test — write it first
- [ ] **B2.4** Persistence round-trip; a corrupt model resets rather than throwing
- [ ] **B2.5** Wire watchers; assert the flapping-test scenario routes to `digest`
      and the 200-green-then-red scenario routes to `speak`
- [ ] **B2.6** Negative control: remove the smoothing term and confirm the
      "repeated state decays toward 0" test fails

---

## Workstream B3 — Replay (recombination during rest)

**Status: gated on the first LLM landing in the model roster.**

### The brain idea

Hippocampal replay during rest is not re-reading. Episodes are *re-derived in
compressed, interleaved order*, which is what lets a pattern spanning several
episodes become visible when it was invisible inside any one of them.

### The Kairos gap

`memoryd/consolidate.js` decays, merges, and prunes — all subtractive. Reflections
in `src/learning/` are written per-mission, so a lesson only visible **across**
missions is never derived. The recurring shape from this project's own history
("PowerShell paths with a tilde fail", "fixtures written by the code's author
measure that author's imagination") took a human noticing it across sessions.

### Design

`src/brain/replay.js`, invoked by the existing `ConsolidationScheduler` at idle,
after decay/merge/prune.

1. **Prioritized sampling** — sample K past episodes weighted by B2's surprise
   score and by failure, not uniformly. This is prioritized experience replay and
   it is the reason B2 comes first.
2. **Interleaved batching** — feed the batch to one model call *together*, asking
   only for patterns that appear in **more than one** episode. A pattern found in
   a single episode is a reflection, and that already exists.
3. **Write-back** — durable `learnings` entries, tagged `replay`, with the episode
   ids they were derived from so a wrong lesson is traceable and revocable.

Runs only at low arousal and low load (B1), on a hard episode budget per pass.

### Files

- Create: `src/brain/replay.js`
- Create: `tests/brain-replay.test.js`
- Modify: `src/memoryd/consolidate.js` (call replay after prune),
  `src/kernel/daemon.js` (schedule)

### Tasks

- [ ] **B3.1** Prioritized sampler, pure and seedable, tested without a model
- [ ] **B3.2** Batch prompt + strict parse; a malformed reply yields zero lessons,
      never a partial one
- [ ] **B3.3** Cross-episode gate: a pattern citing only one episode id is discarded
- [ ] **B3.4** Provenance: every written lesson carries its source episode ids
- [ ] **B3.5** Idle-only: assert replay does not run at high load
- [ ] **B3.6** Negative control: feed episodes with no shared pattern and assert
      nothing is written (the failure mode here is a model that always finds
      something)

### Risk

This is the one mechanism that writes model-generated conclusions into durable
memory. A confabulated lesson persists and shapes future behaviour. Provenance
plus the cross-episode gate plus `kairos memory forget` are the containment; the
first ten passes should be reviewed by hand before the schedule is trusted.

---

## Workstream B4 — Global workspace (the cognitive architecture)

**Status: gated on B1–B3 and on the model roster being populated.**

### The brain idea

Global Workspace Theory: many specialized modules run in parallel, each proposes,
a limited-capacity workspace admits one winner, and the winner is *broadcast back
to every module*. Consciousness-as-architecture, and — more to the point here —
the cleanest available formalization of "several specialists, one voice."

### Why this is the frame for the multi-model brain

This is the architecture behind the owner's own idea: *a brain comprised of
several models, each maintaining different functionalities and strengths*. Each
model in the roster becomes a specialist with a declared strength; salience plus
neuromodulator state decide who speaks; the winner's output is broadcast so the
others can build on it.

### Design — additive, not a replacement

**The existing router is not being replaced.** `dispatch.js` works, is covered by
a standing coverage gate, and carries the accumulated judgement of P4. Swapping a
deterministic, well-tested router for a competition is how reliability is lost.

`src/brain/workspace.js` wraps it:

```
propose(specialists, utterance, state) → [{ source, content, salience, cost }]
admit(proposals, state, capacity=1)    → winner
broadcast(winner, specialists)         → each specialist sees what won
```

- The **router is one specialist**, and the default winner. If it returns a
  confident classification, it wins and nothing else is consulted — the common
  path is unchanged and pays nothing.
- Other specialists are consulted only when the router is *unconfident* (it
  already emits the `0.15` nothing-matched sentinel) or when several have
  something to say.
- Capacity is 1 by default. A workspace that broadcasts three answers is a
  system talking over itself.

Model specialists are declared in the registry built this week
(`src/kernel/models.js`) — each entry gains an optional `strengths` field
(`planning`, `code`, `conversation`, `classification`), which is also what
`selectModelForStage()` will read.

### Files

- Create: `src/brain/workspace.js`
- Create: `tests/brain-workspace.test.js`
- Modify: `src/router/dispatch.js` (as a specialist adapter — no behaviour change
  on the confident path), `src/kernel/models.js` (`strengths` field)

### Tasks

- [ ] **B4.1** Specialist interface + the router adapter; assert byte-identical
      dispatch output on the confident path
- [ ] **B4.2** `admit()` with salience × neuromodulator weighting, capacity 1
- [ ] **B4.3** Broadcast, and a test that a losing specialist sees the winner
- [ ] **B4.4** Model specialists read `strengths` from the registry
- [ ] **B4.5** Cost ceiling: consulting N models must respect the budget and the
      reflex deadline; a slow specialist is dropped, never awaited
- [ ] **B4.6** Negative control: break the confidence short-circuit and confirm
      the "confident path is unchanged" test fails

---

## Sequencing and gates

```
B1 neuromodulator ──► B2 surprise ──► B3 replay ──► B4 workspace
   (today)             (today)         (needs 1 model)  (needs the roster)
```

B1 and B2 need **no model and no new dependencies** — they are buildable now and
improve behaviour on their own. B3 and B4 are genuinely gated on the models
arriving, so the sequencing matches the owner's plan of supplying them one at a
time.

Each workstream: build → full suite green → negative-control pass → report → stop.

## Open questions for the owner

1. **Arousal from voice.** The voice loop knows things nothing else does — that
   someone just spoke, how loudly, whether it was them. Should a verified wake
   word raise arousal directly? (It is the strongest available "the user is
   here" signal, stronger than a client socket being attached.)
2. **Replay review.** Hand-review the first ten replay passes before trusting the
   schedule, or let it write from the start with `kairos memory forget` as the
   undo?
3. **Workspace capacity.** Hold at 1 permanently, or allow 2 for the specific case
   of an answer plus a proactive aside ("...and by the way, the build broke")?
