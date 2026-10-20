# Presentation: What We Built (Plain English)

## 1) Big Picture
We built an autonomous agent loop that can run many steps, remember what it did, recover from mistakes, and continue from where it stopped.

Think of it like a smart assistant with:
- a **brain** (LLM),
- a **notebook** (files on disk),
- and a **work routine** (step-by-step loop).

The key idea: **files are the source of truth**, not temporary chat history.

---

## 2) Framework Choice (Why “No LangGraph”)
We intentionally did **not** use a heavy orchestration framework.

Instead, we use a simple loop:
1. read state,
2. decide next action,
3. run tool,
4. save result,
5. repeat.

Why this helps:
- easier to understand,
- easier to debug,
- fewer moving parts,
- crash recovery is straightforward because state is on disk.

---

## 3) Architectures

### System Diagram (boxes + lines)

```
┌─────────────────────────────────────────────────────────────┐
│                          Input Layer                         │
│                          User Prompt                         │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│                           CLI Layer                         │
│                         src/cli.js                           │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│                         Core Loop Layer                      │
│                        src/loop.js                           │
├─────────────────┬─────────────────┬─────────────────────────┤
│ Context Builder │  Tool Runner    │   Verification Gate     │
│ src/context.js  │  src/tools.js   │   finish-check pass     │
├─────────────────┴─────────────────┴─────────────────────────┤
│               Runtime Guidance + Stall Recovery             │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│                     State & Memory Layer                    │
├─────────────────┬─────────────────┬─────────────────────────┤
│ state.js        │ memory.js       │ compaction.js           │
│ checkpoint/log  │ working window  │ summary + flush         │
├─────────────────┼─────────────────┼─────────────────────────┤
│ identity.js     │ skills.js       │ memory-store.js         │
│ bootstrap files │ dynamic skills  │ persistent memory       │
└─────────────────┴─────────────────┴─────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│                       Model + Filesystem                    │
├─────────────────────────────────────────────────────────────┤
│ llm.js (model API)  ↔  Workspace files (.agent/, *.md, *.json) │
└─────────────────────────────────────────────────────────────┘
```

### File-State Architecture (what persists)

```
┌──────────────────────────────┐      ┌──────────────────────────────┐
│ Identity Files               │      │ Agent Working State          │
├──────────────────────────────┤      ├──────────────────────────────┤
│ SOUL.md                      │      │ .agent/task.md               │
│ AGENTS.md                    │      │ .agent/plan.md               │
│ USER.md                      │      │ .agent/progress.md           │
│ MEMORY.md                    │      │ .agent/checkpoint.json       │
└──────────────────────────────┘      │ .agent/context-summary.md    │
              │                        │ .agent/focus-chain.md        │
              └──────────────┬─────────┴──────────────────────────────┘
                             │
                             ▼
                ┌──────────────────────────────────────┐
                │        Runtime Context Builder       │
                │          (src/context.js)            │
                └──────────────────────────────────────┘
                             ▲
              ┌──────────────┴───────────────────────┐
              │                                      │
┌──────────────────────────────┐      ┌──────────────────────────────┐
│ Persistent Memory Files      │      │ Dynamic Capability Files     │
├──────────────────────────────┤      ├──────────────────────────────┤
│ .agent/memory/YYYY-MM-DD.md  │      │ .agent/skills/*.md           │
│ .agent/memory/learnings.md   │      │ (custom skills loaded at run)│
│ files-touched.json           │      └──────────────────────────────┘
│ commands-run.json            │
└──────────────────────────────┘
```

### Execution + Verification Flow

```
┌──────────────────────────────┐
│ 1) Build Context             │
└──────────────────────────────┘
              │
┌──────────────────────────────┐
│ 2) LLM Decides Action        │
└──────────────────────────────┘
              │
┌──────────────────────────────┐
│ 3) Execute Tool              │
└──────────────────────────────┘
              │
┌──────────────────────────────┐
│ 4) Persist Step Result       │
│    progress + checkpoint     │
└──────────────────────────────┘
              │
        ┌─────┴─────┐
        │ Need      │
        │ compaction│
        └─────┬─────┘
          Yes │   │ No
              │   │
┌──────────────────────────────┐
│ 5) Pre-Compaction Flush +    │
│    Summary Update            │
└──────────────────────────────┘
              │
        ┌─────┴─────┐
        │ Finish    │
        │ requested?│
        └─────┬─────┘
          Yes │   │ No
              │   │
┌──────────────────────────────┐   ┌──────────────────────────────┐
│ 6) Verification Pass         │   │ Loop back to step 1          │
└──────────────────────────────┘   └──────────────────────────────┘
              │
        ┌─────┴─────┐
        │ Verified? │
        └─────┬─────┘
          Yes │   │ No
              │   │
┌──────────────────────────────┐   ┌──────────────────────────────┐
│ Exit: completed              │   │ Continue loop with guidance  │
└──────────────────────────────┘   └──────────────────────────────┘
```

## A) Identity Files (Who the agent is)
- `SOUL.md`: personality and stable behavior anchor
- `AGENTS.md`: operating rules
- `USER.md`: user preferences
- `MEMORY.md`: long-term remembered facts

## B) Working Files (What the agent is doing now)
- `.agent/task.md`: task definition
- `.agent/plan.md`: plan and progress
- `.agent/progress.md`: step-by-step log
- `.agent/checkpoint.json`: machine-readable restart state

## C) Memory & Compaction (How it scales)
- Recent steps stay in working memory.
- Older steps are compacted into summaries.
- Important facts are flushed to durable memory files before compaction.

## D) Skills (Reusable mini-tools)
- Agent can create custom skills.
- Skills are saved under `.agent/skills/` and loaded in future runs.

---

## 4) What We Took from OpenClaw
We borrowed practical patterns, not a full copy.

### Adopted from OpenClaw ideas
- **Identity-first bootstrapping** (`SOUL.md` style anchor files)
- **Pre-compaction memory flush** (save critical facts before context is compressed)
- **Model-facing failure guidance** (clear recovery hints after tool/format errors)
- **Soft guardrails** (guide the model without over-constraining it)

### OpenClaw-style robustness upgrades we added
- Better parsing fallback for malformed model outputs
- MiniMax-style tool-call parsing fallback
- Tool error envelopes with retry guidance:
  - when to retry,
  - when **not** to retry,
  - what to do next.

---

## 5) What Exists from Pi / Pi-Agent Influence
From Pi-style runtime memory concepts, we incorporated the **persistence mindset**:
- disk-first state,
- structured logs,
- replayable execution history.

### Implemented now
- Persistent step logs and checkpointing
- File-based memory that survives process restarts
- Suite-based reliability testing for repeated runs

### Not fully implemented yet (future work)
- Full Pi-style retrieval layer (advanced semantic recall/indexing)
- richer memory ranking/scoring pipelines

So today we have the **foundation** and operational reliability, with room to add more advanced Pi-style memory retrieval later.

---

## 6) What Changed During This Project
Initial behavior was good but had one unstable case in the evolution suite (tool/parse failure loop).

We revised:
- parser recovery logic,
- tool failure feedback,
- skill execution safety,
- and clean-start testing workflow.

Additionally added:
- long-run single-prompt stress runner: `run-longest-spec-stress.sh`
- prompt + log + report outputs for repeatable long-horizon evaluation

We also added a clean runner script:
- `run-evolution-suite-advanced-clean.sh`
- always starts from a fresh workspace unless explicitly disabled.

---

## 7) Results (Before vs After)

## Initial baseline
- Suite result: **5/6** successful
- Main issue: one pathological run with malformed output/tool-call recovery weakness

## Revised current run
- Suite result: **6/6** successful
- Parse-error cascades: **0**
- Verification failures: **0**
- Tool failures recover better with explicit guidance

This means reliability improved from “mostly works” to “consistently completes this suite cleanly.”

---

## 8) Why This Matters for Non-Engineers
- The system is now **more dependable**.
- Failures are **more explainable**.
- Runs are **repeatable** (clean start each time).
- Knowledge persists between runs, so work does not get lost.

In business terms: less rework, clearer audit trail, higher confidence in autonomous execution.

---

## 9) Next Step (Simple)
If we want another reliability jump, add a stress profile:
- longer runs,
- intentionally malformed tool outputs,
- larger file-edit tasks,
- and compare stability score across versions.
