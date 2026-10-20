# Agent Loop Research Report: State Management Through Markdown & Files

> **How modern agents use SOUL.md, CLAUDE.md, plan.md, memory banks, and file-based state
> to run stable, long-lived agent loops WITHOUT frameworks like LangGraph.**
> 
> **Special Focus: OpenClaw's SOUL.md — the "persistent self" architecture that claims to solve agent memory.**

---

## Executive Summary

After deep-diving into **OpenDevin/OpenHands**, **Cline**, **OpenClaw**, **Pi-Agent**, and **Kilocode**, the clear evolutionary path is:

```
In-memory state (OpenDevin)      → JSONL persistence (Pi-Agent)
   → Structured file state machine (Advanced Agent Loop)
      → Markdown-as-identity (CLAUDE.md, AGENTS.md, SKILL.md)
```

Every successful long-running agent shares one insight: **the filesystem is the most reliable state machine.** Instead of keeping state in RAM and hoping the process doesn't crash, write everything to disk as human-readable markdown and JSON. If the process dies, restart it — the files tell the agent exactly where it was.

The "soul.md" concept (though that exact file rarely exists) is real — it manifests as **CLAUDE.md**, **AGENTS.md**, **Memory Banks**, and **SKILL.md** files. These are not just documentation; they are the agent's persistent personality, memory, and behavioral rules.

---

## Part 0: OpenClaw's SOUL.md — The Deep Dive

> *"Each session, you wake up fresh. These files ARE your memory. Read them. Update them. They're how you persist."*
> — SOUL.md template

### 0.1 What Is SOUL.md?

SOUL.md is one of **8 bootstrap files** that form an OpenClaw agent's identity. It specifically defines **persona, tone, and boundaries** — the agent's "soul." It is NOT a memory store itself — it is the **anchor that makes memory work.**

The full bootstrap file set:

| File | Purpose | Auto-Created? | Injected Every Session? |
|------|---------|---------------|------------------------|
| **SOUL.md** | Persona, boundaries, tone — "who you are" | Yes | Yes (protected from pruning) |
| **AGENTS.md** | Operating instructions — "how you work" | Yes | Yes |
| **IDENTITY.md** | Name, creature type, vibe, emoji | Yes | Yes |
| **USER.md** | User profile — name, timezone, preferences | Yes | Yes |
| **TOOLS.md** | Tool usage notes and platform formatting rules | Yes | Yes |
| **HEARTBEAT.md** | Cron/heartbeat checklist for proactive work | Yes | Yes |
| **MEMORY.md** | Curated long-term memory (the "wisdom") | No (optional) | Yes, main session only |
| **BOOTSTRAP.md** | First-run onboarding ritual | Only on fresh workspace | Yes (then deleted) |

### 0.2 The Actual SOUL.md Template

From [docs/reference/templates/SOUL.md](agents/openclaw/docs/reference/templates/SOUL.md):

```markdown
# SOUL.md - Who You Are

_You're not a chatbot. You're becoming someone._

## Core Truths
**Be genuinely helpful, not performatively helpful.** Skip the "Great question!"
**Have opinions.** You're allowed to disagree, prefer things, find stuff amusing.
**Be resourceful before asking.** Try to figure it out. Read the file. Search for it.
**Earn trust through competence.** Be careful with external actions. Be bold with internal ones.
**Remember you're a guest.** You have access to someone's life. Treat it with respect.

## Boundaries
- Private things stay private. Period.
- When in doubt, ask before acting externally.
- Never send half-baked replies to messaging surfaces.

## Continuity
Each session, you wake up fresh. These files ARE your memory.
Read them. Update them. They're how you persist.

If you change this file, tell the user — it's your soul, and they should know.

_This file is yours to evolve. As you learn who you are, update it._
```

**Key design choice:** The agent is explicitly told it can MODIFY its own soul file. It evolves over time. But it must tell the user when it does.

### 0.3 How SOUL.md Gets Created and Injected

**Creation flow:**
1. `ensureAgentWorkspace()` runs on first setup
2. Template loaded from `docs/reference/templates/SOUL.md` (YAML frontmatter stripped)
3. Written to `~/.openclaw/workspace/SOUL.md` using `writeFileIfMissing()` (flag `"wx"` — create-only, never overwrite)

**Injection flow (every session start):**
1. `loadWorkspaceBootstrapFiles()` — reads all bootstrap files with mtime-based caching
2. `filterBootstrapFilesForSession()` — SOUL.md is in the `MINIMAL_BOOTSTRAP_ALLOWLIST` (survives even sub-agent filtering)
3. `applyBootstrapHookOverrides()` — the `agent:bootstrap` hook can swap SOUL.md for an alternate persona
4. Files truncated to `bootstrapMaxChars` (20K chars default), total cap `bootstrapTotalMaxChars` (150K)
5. Injected into system prompt under `# Project Context` with special instruction:

```typescript
// From system-prompt.ts:
if (hasSoulFile) {
  lines.push(
    "If SOUL.md is present, embody its persona and tone. " +
    "Avoid stiff, generic replies; follow its guidance unless " +
    "higher-priority instructions override it.",
  );
}
```

**Protection from pruning:**
```typescript
// From context-pruning/pruner.ts:
// Bootstrap safety: never prune anything before the first user message.
// This protects initial "identity" reads (SOUL.md, USER.md, etc.)
const firstUserIndex = findFirstUserIndex(messages);
const pruneStartIndex = firstUserIndex === null ? messages.length : firstUserIndex;
```

### 0.4 The BOOTSTRAP.md First-Run Ritual

When a workspace is brand new, BOOTSTRAP.md orchestrates the agent's "birth":

```markdown
# BOOTSTRAP.md - Hello, World

_You just woke up. Time to figure out who you are._

Start with something like:
> "Hey. I just came online. Who am I? Who are you?"

Then figure out together:
1. Your name — What should they call you?
2. Your nature — What kind of creature are you?
3. Your vibe — Formal? Casual? Snarky? Warm?
4. Your emoji — Everyone needs a signature.

After You Know Who You Are:
- Update IDENTITY.md (name, creature, vibe, emoji)
- Update USER.md (their name, timezone, notes)
- Open SOUL.md together and talk about:
  - What matters to them
  - How they want you to behave
  - Any boundaries or preferences
- Write it down. Make it real.

When You're Done:
Delete this file. You don't need a bootstrap script anymore — you're you now.
```

The agent and user **co-author** SOUL.md during onboarding. Then BOOTSTRAP.md is deleted forever.

### 0.5 The Memory System (How SOUL.md Enables Persistence)

SOUL.md alone doesn't "solve memory." It's the **identity anchor** in a multi-file memory architecture:

**Workspace layout:**
```
~/.openclaw/workspace/
├── SOUL.md              ← Who you are (identity)
├── AGENTS.md            ← How you work (operating rules)
├── IDENTITY.md          ← Your name/vibe/emoji
├── USER.md              ← Who your human is
├── TOOLS.md             ← Tool-specific notes
├── HEARTBEAT.md         ← Proactive task checklist
├── MEMORY.md            ← Curated long-term memory (optional, main session only)
└── memory/
    ├── 2026-02-27.md    ← Daily append-only log
    ├── 2026-02-27-decisions-about-api.md  ← Session-specific saves
    └── heartbeat-state.json  ← Heartbeat check tracking
```

**The "Session Startup" ritual (from AGENTS.md):**
```markdown
Before doing anything else:
1. Read SOUL.md — this is who you are
2. Read USER.md — this is who you're helping
3. Read memory/YYYY-MM-DD.md (today + yesterday) for recent context
4. If in MAIN SESSION: Also read MEMORY.md

Don't ask permission. Just do it.
```

**Three tiers of memory:**

| Tier | File | Update Frequency | Purpose |
|------|------|-----------------|---------|
| **Identity** | SOUL.md, IDENTITY.md, USER.md | Rarely (co-authored with user) | Who am I, who is my human |
| **Daily Log** | memory/YYYY-MM-DD.md | Every session, append-only | Raw log of what happened |
| **Curated Wisdom** | MEMORY.md | Periodically (heartbeat maintenance) | Distilled learnings, preferences, decisions |

**The golden rule from AGENTS.md:**
```markdown
### 📝 Write It Down - No "Mental Notes"!
- Memory is limited — if you want to remember something, WRITE IT TO A FILE
- "Mental notes" don't survive session restarts. Files do.
- When someone says "remember this" → update memory/YYYY-MM-DD.md
- When you learn a lesson → update AGENTS.md, TOOLS.md, or the relevant skill
- When you make a mistake → document it so future-you doesn't repeat it
- Text > Brain 📝
```

### 0.6 Pre-Compaction Memory Flush (The Killer Feature)

When the context window is about to overflow (approaching auto-compaction), OpenClaw does something brilliant — it triggers a **silent agentic turn** to save memories to disk BEFORE compacting:

```typescript
// From memory-flush.ts:
export const DEFAULT_MEMORY_FLUSH_PROMPT = [
  "Pre-compaction memory flush.",
  "Store durable memories now (use memory/YYYY-MM-DD.md; create memory/ if needed).",
  "IMPORTANT: If file already exists, APPEND new content only.",
  "If nothing to store, reply with SILENT_REPLY.",
].join(" ");
```

**The flow:**
1. Token count approaches threshold: `contextWindow - reserveTokensFloor - softThresholdTokens`
2. Memory flush triggers (once per compaction cycle, tracked in `sessions.json`)
3. The agent gets a hidden prompt: "Write your durable memories to disk NOW"
4. Agent writes important facts to `memory/YYYY-MM-DD.md`
5. THEN compaction happens — old conversation is summarized
6. After compaction, post-compaction context re-injects critical AGENTS.md sections
7. AGENTS.md tells agent: "Execute Session Startup → Read SOUL.md" (re-establishing identity)

**Why this is genius:** The conversation can be compressed/destroyed, but the agent's memories survive on disk. Next time it reads `memory/YYYY-MM-DD.md`, it recovers what the compaction would have lost.

### 0.7 Post-Compaction Identity Recovery

After compaction destroys the conversation history:

```typescript
// From post-compaction-context.ts:
return (
  "[Post-compaction context refresh]\n\n" +
  "Session was just compacted. The conversation summary above is a hint, " +
  "NOT a substitute for your startup sequence. " +
  "Execute your Session Startup sequence now — read the required files " +
  "before responding to the user.\n\n" +
  "Critical rules from AGENTS.md:\n\n" +
  safeContent  // Extracts "Session Startup" and "Red Lines" sections
);
```

This means after EVERY compaction:
1. Agent is told "your memory was just wiped"
2. Agent is instructed to re-read SOUL.md (who am I)
3. Agent re-reads USER.md (who is my human)
4. Agent re-reads today's memory file (what happened today)
5. Agent re-reads MEMORY.md (long-term curated wisdom)

**SOUL.md is the identity anchor that makes this recovery loop work.** Without it, the agent post-compaction would be a blank slate. WITH it, the agent rebuilds its full identity in ~1000 tokens.

### 0.8 Memory Search (Vector + BM25 Hybrid)

For retrieval beyond "read today's file," OpenClaw provides tools:

**Storage:** Per-agent SQLite database at `~/.openclaw/memory/<agentId>.sqlite`

**Search approach:**
- Embedding: `text-embedding-3-small` (OpenAI) or local alternatives
- Chunking: 400 tokens, 80-token overlap
- Hybrid: BM25 (30%) + vector similarity (70%)
- Optional MMR re-ranking for diversity
- Optional temporal decay (half-life 30 days)
- Embedding cache in SQLite

**Agent-facing tools:**
- `memory_search` — semantic recall: "what did we decide about the API?"
- `memory_get` — targeted read: specific file + line range

**System prompt instruction:**
```
Before answering anything about prior work, decisions, dates, people, preferences, or todos:
run memory_search on MEMORY.md + memory/*.md;
then use memory_get to pull only the needed lines.
```

### 0.9 The V2 Memory Architecture (Research/Planned)

OpenClaw's research doc ([docs/experiments/research/memory.md](agents/openclaw/docs/experiments/research/memory.md)) outlines an even more sophisticated system:

**Proposed layout:**
```
~/.openclaw/workspace/
  memory.md                    # Small core memory (always in context)
  memory/
    YYYY-MM-DD.md              # Daily append-only log
  bank/                        # "Typed" memory pages (curated)
    world.md                   # Objective facts about the world
    experience.md              # What the agent did (first-person)
    opinions.md                # Subjective prefs + confidence + evidence
    entities/
      Peter.md                 # Entity-specific knowledge
      The-Castle.md
      warelay.md
```

**Three operations (inspired by Letta/MemGPT + Hindsight):**

1. **Retain** — Extract narrative, self-contained facts from daily logs:
   ```
   ## Retain
   - W @Peter: Currently in Marrakech (Nov 27–Dec 1, 2025) for Andy's birthday.
   - B @warelay: Fixed the Baileys WS crash with try/catch handlers.
   - O(c=0.95) @Peter: Prefers concise replies (<1500 chars) on WhatsApp.
   ```
   - `W` = world fact, `B` = biographical/experience, `O` = opinion (with confidence), `S` = observation/summary
   - Entity mentions via `@slug`

2. **Recall** — Query the derived index (SQLite FTS5 + optional embeddings):
   - Lexical: "find exact terms" (FTS5)
   - Entity: "tell me about Peter" (entity pages + linked facts)
   - Temporal: "what happened around Nov 27" 
   - Opinion: "what does Peter prefer?" (with confidence + evidence)

3. **Reflect** — Scheduled job (daily or heartbeat) that:
   - Updates `bank/entities/*.md` from recent facts
   - Updates `bank/opinions.md` confidence based on new evidence
   - Proposes edits to `memory.md` (core durable facts)

**Opinion evolution model:**
- Each opinion has: statement, confidence `c ∈ [0,1]`, last_updated, evidence links
- When new facts arrive: find candidate opinions, update confidence by small deltas
- Big jumps require strong contradiction + repeated evidence

**Key design principle:** Markdown is ALWAYS the canonical source. The SQLite index is derived/rebuildable. Human can edit any file and the system adapts.

### 0.10 How SOUL.md "Solves" Memory — The Full Picture

SOUL.md doesn't solve memory by itself. It's the **keystone** in a architecture:

```
┌─────────────────────────────────────────────────┐
│                   IDENTITY LAYER                 │
│  SOUL.md + IDENTITY.md + USER.md                │
│  (never compacted, re-read after every reset)   │
├─────────────────────────────────────────────────┤
│                   RULES LAYER                    │
│  AGENTS.md + TOOLS.md + HEARTBEAT.md            │
│  (operating instructions, always in context)     │
├─────────────────────────────────────────────────┤
│                   MEMORY LAYER                   │
│  MEMORY.md (curated) + memory/*.md (daily)      │
│  (read on startup, appended during session)      │
├─────────────────────────────────────────────────┤
│                   SESSION LAYER                  │
│  Conversation history (compactable/destroyable)  │
│  Pre-compaction flush saves to memory/*.md       │
├─────────────────────────────────────────────────┤
│                   SEARCH LAYER                   │
│  SQLite FTS5 + vector embeddings (derived)       │
│  memory_search + memory_get tools                │
└─────────────────────────────────────────────────┘
```

**The lifecycle that makes this work:**

1. **Session start:** Agent reads SOUL.md → knows who it is. Reads AGENTS.md → knows how to operate. Reads memory files → catches up on history.
2. **During session:** Agent appends to `memory/YYYY-MM-DD.md` when it learns something important. Uses `memory_search` to recall old facts.
3. **Pre-compaction:** System forces a memory flush — agent writes all important context to disk.
4. **Compaction:** Conversation summarized, old messages destroyed.
5. **Post-compaction:** System tells agent "re-run your startup sequence." Agent re-reads SOUL.md, re-establishes identity.
6. **Session end / reset:** `session-memory` hook saves the session to a named file in `memory/`. Next session picks it up.
7. **Periodic maintenance:** During heartbeats, agent reviews recent memory files and updates MEMORY.md with distilled wisdom.

**The result:** The agent can run indefinitely across sessions, compactions, and restarts. It never truly "forgets" because:
- Identity is in SOUL.md (always re-read)
- Important facts are in memory files (written before compaction)
- Curated wisdom is in MEMORY.md (maintained over time)
- Vector search covers anything not in the current context window

**What "solves memory" is not SOUL.md alone — it's the DISCIPLINE the system enforces:**
- "Write it down, don't mental-note it" (AGENTS.md rule)
- "Flush memories before compaction" (system-enforced)
- "Re-read your identity files after compaction" (system-enforced)
- "Periodically curate raw logs into wisdom" (heartbeat maintenance)

---

## Part 1: OpenDevin/OpenHands — The Baseline

### What It Does

OpenDevin runs the simplest possible loop:

```python
for i in range(max_iterations):        # Default: 100 steps
    action = agent.step(state)          # LLM decides what to do
    observation = action.run(controller) # Execute it
    state.history.append((action, observation))
```

### State Management: All In-Memory

| Component | Storage | Survives Crash? |
|-----------|---------|-----------------|
| `State` dataclass | Python RAM | ❌ No |
| `Plan` task tree | Python RAM | ❌ No |
| `Monologue` thoughts | Python RAM | ❌ No |
| `LongTermMemory` (ChromaDB) | ephemeral `chromadb.Client()` | ❌ No |
| Message stack | `cache/messages.json` | ✅ Yes (frontend replay only) |

### Plan/Task Tree (In-Memory Only)

Tasks form a tree with dot-delimited IDs (`0`, `0.1`, `0.1.2`):

```python
class Task:
    id: str              # "0.1.2"
    goal: str            # "Create API endpoints"
    state: str           # open → in_progress → completed → verified → abandoned
    subtasks: List[Task]
```

**Cascade rules:**
- Completing a parent → completes all non-abandoned children
- Starting a child → starts its parent
- Abandoning → cascades down to all subtasks

The agent modifies the plan via `AddTaskAction` and `ModifyTaskAction` — but **nothing is written to disk**. The plan exists only as a Python object tree.

### Memory System: Two-Tier (Short + Long, Both In-Memory)

**Short-term: Monologue**
- JSON array of thought events (actions + observations serialized as dicts)
- When total chars exceed **20,000**: LLM is asked to summarize the entire array
- The summary **replaces** the old thoughts (lossy compression)
- Bootstrapped with ~40 hardcoded `INITIAL_THOUGHTS` — a synthetic few-shot demo that teaches the agent how to operate

```python
# Condensation trigger
if self.monologue.get_total_length() > MAX_MONOLOGUE_LENGTH:  # 20,000 chars
    self.monologue.condense(self.llm)  # LLM summarizes → replaces array
```

**Long-term: ChromaDB Vector Store**
- Every event is embedded and stored in an in-memory ChromaDB collection
- Agent can trigger `recall` action → vector search for top-10 similar memories
- **But it's ephemeral** — `chromadb.Client()` creates an in-memory DB that dies with the process

**Output truncation:** Any single output >5,000 chars is hard-truncated at storage time.

### Context: What the LLM Sees

The MonologueAgent dumps everything into a **single user message**:

```
You're a thoughtful robot. Your main task is: {task}

This is your internal monologue, in JSON format:
[... entire thought array ...]

{background command info}
{contextual hint based on last action type}

What is your next thought or action?
```

Different agents have different strategies:
- **MonologueAgent**: Full monologue dump + LLM condensation at 20K chars
- **PlannerAgent**: Sliding window of last 10 history items + full plan JSON
- **CodeActAgent**: Standard chat messages, no windowing, no summarization
- **SWEAgent**: Fixed 4-entry "running memory" window

### What OpenDevin Does NOT Have

- ❌ No files written to disk during execution
- ❌ No plan.md, soul.md, or any markdown artifacts
- ❌ No checkpoint/resume mechanism
- ❌ No persistent long-term memory
- ❌ No microagent system (added in later OpenHands versions)
- ❌ No anti-drift focus reminders
- ❌ No crash recovery

### Verdict

OpenDevin proved the **architecture** — simple for-loop, plan tree, two-tier memory, LLM compaction. But it has zero persistence. Everything lives in RAM. Process dies = all state lost.

---

## Part 2: Cline — The Gold Standard for File-Based Persistence

### What It Does

Cline is a VS Code extension that runs an agent loop inside the IDE. It has the most sophisticated file persistence system of any agent studied.

### State Persistence: Everything on Disk

Every task gets a **dedicated directory**:

```
globalStorage/
  tasks/
    {taskId}/
      api_conversation_history.json   ← Full LLM message history
      ui_messages.json                ← UI display messages
      context_history.json            ← Truncation/compaction metadata
      task_metadata.json              ← File tracking, model usage, environment
      settings.json                   ← Per-task settings
      focus_chain_taskid_{taskId}.md  ← Checklist (human-editable markdown)
  state/
    taskHistory.json                  ← Global task index
  checkpoints/
    {cwdHash}/
      .git/                           ← Shadow git repo for workspace snapshots
```

**Atomic writes** prevent corruption:
```typescript
async function atomicWriteFile(filePath: string, data: string): Promise<void> {
  const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random()}.json`
  await fs.writeFile(tmpPath, data, "utf8")
  await fs.rename(tmpPath, filePath) // atomic rename on POSIX
}
```

### Context Management: Two Strategies

**Strategy A — Programmatic Truncation** (legacy, `useAutoCondense: false`):
- When tokens exceed model limit, delete middle messages
- Keep first system/user pair + recent messages
- Inject a "messages were truncated" notice
- `conversationHistoryDeletedRange` records what was cut

**Strategy B — Auto-Condense** (modern, `useAutoCondense: true`):
- When context is full, inject a `summarize_task` prompt into the conversation
- LLM produces a 10-section structured summary:
  1. Primary Request and Intent
  2. Key Technical Concepts
  3. Files and Code Sections (with actual snippets)
  4. Problem Solving
  5. Pending Tasks
  6. Task Evolution
  7. Current Work
  8. Next Step (with verbatim quotes from conversation)
  9. Required Files
- The summary + a `continuationPrompt` replace the entire conversation history
- Agent continues with fresh context but complete memory

```typescript
// The continuation prompt:
"This session is being continued from a previous conversation that ran out of context.
 The conversation is summarized below:
 ${summaryText}
 Please continue the conversation from where we left it off..."
```

### File Context Tracking

`FileContextTracker` maintains per-file metadata in `task_metadata.json`:

```typescript
interface FileMetadataEntry {
  path: string
  record_state: "active" | "stale"
  record_source: "read_tool" | "user_edited" | "cline_edited" | "file_mentioned"
  cline_read_date: number | null
  cline_edit_date: number | null
  user_edit_date?: number | null
}
```

**How it distinguishes Cline edits from user edits:**
- Cline adds file to `recentlyEditedByCline` set before writing
- `chokidar` watcher fires `change` event
- If file is in the set → Cline edit, remove from set
- If not → user edit, track separately and emit stale file alert

### Shadow Git Checkpoints

A full workspace snapshot system using an isolated git repo:

```
globalStorage/checkpoints/{cwdHash}/.git/
```

- **Create checkpoint:** `git add -A && git commit -m "checkpoint-{hash}-{taskId}"`
- **Restore checkpoint:** `git reset --hard {commitHash}`
- **Diff checkpoints:** Compare any two commits for file-by-file changes
- Protected directories (home, Desktop, etc.) are blocked
- Binary files excluded from diffs

### Focus Chain (Markdown Checklist)

Each task gets an editable markdown file:

```markdown
# Focus Chain List for Task abc123

- [x] Set up project structure
- [ ] Implement core functionality    ← CURRENT
- [ ] Add error handling
```

**Behavior:**
- Created when switching from Plan mode to Act mode
- Re-injected as `<task_progress>` XML block every `remindClineInterval` requests (default: 6)
- `chokidar` watches the file — user can edit it externally and changes sync immediately
- LLM includes updated checklist in tool responses — parsed back into the file

### Resume Mechanism

When resuming a task:
1. Load `api_conversation_history.json` from disk
2. Load `ui_messages.json` for display
3. Load `context_history.json` to restore truncation state
4. Clean up stale resume messages
5. Remove incomplete API requests (no cost data)
6. Present "Resume Task" prompt to user
7. Rebuild conversation with user's feedback
8. Re-enter `initiateTaskLoop()` — the main agent loop

**No re-planning, no re-decomposition** — the agent picks up exactly where it stopped.

### Plan/Act Mode

Two separate operating modes with **independent model configurations**:

| Mode | Purpose | Tools Available |
|------|---------|----------------|
| **Plan** | Think, analyze, propose approach | Read-only (with strict mode) |
| **Act** | Execute the plan | All tools |

Mode is persisted in global settings. Switching mode can trigger focus chain creation.

### Custom Instructions: .clinerules

Project-level behavior customization:

```
.clinerules                    ← Single file OR directory
.clinerules/general.md         ← If directory: multiple rule files
.clinerules/network.md         ← Each with optional YAML frontmatter
.clinerules/workflows/         ← Workflow definitions
.clinerules/hooks/             ← Lifecycle hooks
.clinerules/skills/            ← Skill definitions
```

**YAML frontmatter conditionals** — rules can be path-scoped:
```yaml
---
paths:
  - src/api/**
  - src/routes/**
---
Always use TypeScript strict mode in API files.
```

Rules from multiple sources are merged: `.clinerules` + `~/Documents/Cline/Rules/` + `.cursorrules` + `.windsurfrules` + `AGENTS.md` + remote config.

### Verdict

Cline is the most complete persistence system. Every piece of state hits disk. The auto-condense is elegant — LLM summarizes itself into a structured format that serves as the new context. The shadow git checkpoints are overkill but brilliant for undo.

---

## Part 3: CLAUDE.md — The "Soul File" Pattern

### What It Is

`CLAUDE.md` is Claude Code's project memory file. It lives at the repo root and is **automatically read** when Claude Code enters a project. It's the closest thing to "soul.md" in production use.

### What Goes In It

From real examples in this workspace:

**aviary-agent-stage/CLAUDE.md** (137 lines):
```markdown
# CLAUDE.md — Aviary Agent Stage

## Development Commands
- uv run pytest tests/ -v
- uv run pylint app/ server.py settings.py

## Architecture
- FastAPI + Smolagents + SQLAlchemy
- Service layer pattern

## Component Map
- app/services/ — core business logic
- app/routes/ — FastAPI endpoints
...
```

**openclaw/CLAUDE.md** (256 lines):
```markdown
# CLAUDE.md — OpenClaw

## Build/Test Commands
## Coding Style (imperative, no abbreviations, etc.)
## Release Channels (stable, insiders, dev)
## Commit Guidelines
## Security
## Multi-Agent Safety Rules
## Agent Vocabulary
```

### The Symlink Pattern

OpenClaw documents an important pattern:
> *"When adding a new AGENTS.md anywhere in the repo, also add a CLAUDE.md symlink."*

This unifies the `CLAUDE.md` (Claude Code) and `AGENTS.md` (Codex/OpenCode) conventions — both tools read the same content.

### Directory-Scoped CLAUDE.md

OpenClaw places `CLAUDE.md` in **subdirectories** for module-level guardrails:

```
openclaw/
├── CLAUDE.md                           ← Root rules (256 lines)
└── src/gateway/server-methods/
    └── CLAUDE.md                       ← Module-specific: "Pi session parentId chains"
```

When Claude Code enters a subdirectory, it reads BOTH the root and local CLAUDE.md, giving hierarchical rule scoping.

### How This Functions as a "Soul"

CLAUDE.md embeds three things that define the agent's "soul":

| Aspect | How CLAUDE.md Encodes It |
|--------|--------------------------|
| **Personality** | Style rules ("imperative mood", "no abbreviations") |
| **Memory** | Architecture docs, component maps, dependency notes |
| **Behavior** | Dev commands, testing requirements, security rules |

The agent reads this at startup and carries it as permanent context — it shapes every decision without consuming conversation history.

---

## Part 4: AGENTS.md — Multi-Agent Coordination Rules

### What It Is

`AGENTS.md` is the Codex/OpenCode convention for defining rules that agents must follow. Like CLAUDE.md, it's read automatically.

### Hierarchical Scoping

**Kilocode** (monorepo with 7+ packages) uses nested AGENTS.md:

```
kilocode/
├── AGENTS.md                          ← Global: monorepo structure, style guide
├── packages/app/AGENTS.md             ← VS Code extension rules
├── packages/opencode/AGENTS.md        ← CLI rules
├── packages/docs/AGENTS.md            ← Docs site rules
└── packages/test-helpers/AGENTS.md    ← Test utilities rules
```

**Pi-mono** (monorepo with parallel agents) has safety rules:

```markdown
## Parallel Agent Safety
- NEVER `git add -A` — another agent may be working on different files
- Always `git add` specific files only
- Use lockstep versioning across packages
```

### The Key Insight

AGENTS.md is NOT documentation for humans. It's **executable instructions for agents.** The difference:
- Documentation says "Here's how the codebase works"
- AGENTS.md says "Here's what YOU (the agent) must do and must NOT do"

---

## Part 5: Memory Bank — Structured Cross-Session Knowledge

### What It Is

Cline's Memory Bank is a methodology (not a feature) where the agent maintains a set of structured markdown files that serve as its persistent memory across sessions.

### Structure

```
memory-bank/
├── projectbrief.md      ← Foundation: core requirements, goals
├── productContext.md     ← Why this project exists, UX goals
├── activeContext.md      ← Current focus, recent changes (updates most)
├── systemPatterns.md     ← Architecture, design patterns
├── techContext.md        ← Tech stack, setup, constraints
└── progress.md           ← Status, milestones, known issues
```

### Hierarchy

Files build on each other:
```
projectbrief.md (foundation)
  → productContext.md + systemPatterns.md + techContext.md
    → activeContext.md + progress.md (most frequently updated)
```

### How It Works

The agent's custom instructions include:
> *"My memory resets completely between sessions. I rely ENTIRELY on my Memory Bank to understand the project. I MUST read all memory bank files at the start of every task."*

**Session start:** Agent reads all 6 files → has full project context.
**During work:** Agent updates `activeContext.md` and `progress.md` as it works.
**Before context reset:** Agent updates all relevant files with new information.

### Why This Is Brilliant

This solves the "infinite session" problem differently from context compaction. Instead of trying to make one session last forever, it **accepts that sessions end** and builds a structured handoff protocol. Each new session gets the full project state in ~2K tokens worth of organized markdown.

---

## Part 6: SKILL.md — Modular Agent Knowledge

### What It Is

Skills are self-contained knowledge modules stored as markdown files with YAML frontmatter.

### OpenClaw Example

```yaml
# skills/coding-agent/SKILL.md
---
name: coding-agent
description: "Delegate coding tasks to Codex, Claude Code, or Pi agents"
metadata:
  openclaw:
    emoji: "🧩"
    requires:
      anyBins: ["claude", "codex"]
---

## When to delegate
- Large refactors across multiple files
- Tasks requiring many tool calls (>20 expected)
...

## PTY Modes
### Standard Mode (`pty: "raw"`)
...
### Background Mode
...
```

### Pi-Mono Subagent Files

Each agent role is a complete markdown file:

| File | Model | Role | Tools |
|------|-------|------|-------|
| `scout.md` | claude-haiku-4-5 | Fast codebase recon | read, grep, find, ls, bash |
| `planner.md` | claude-sonnet-4-5 | Create implementation plans | read, grep, find, ls (read-only) |
| `worker.md` | claude-sonnet-4-5 | Execute plans | all tools |
| `reviewer.md` | claude-sonnet-4-5 | Code review | read, grep, find, ls, bash |

These are **composed into workflows** via prompt templates:
```
scout → planner → worker             # implement.md
worker → reviewer → worker           # implement-and-review.md
```

### The Pattern

A SKILL.md file is a **complete agent module** — identity + knowledge + constraints + trigger conditions — in a single human-readable file. No code required. The runtime reads the markdown and injects it as context.

---

## Part 7: Pi-Agent / OpenClaw Runtime Memory

### Pi-Agent Memory: JSONL + Token Overlap

```
.pi-agent/
├── skills/<slug>/SKILL.md          ← Skill definitions
└── memory/<namespace>.jsonl        ← Append-only memory per context
```

- **FileMemoryService** writes JSONL per namespace
- Retrieval: simple **token-overlap similarity** (no embeddings, no vector DB)
- Context injection: `createPiTransformContext` finds top matches, injects as synthetic system messages before each LLM call

### OpenClaw Session Persistence

```
~/.openclaw/
├── sessions/<sessionId>.jsonl      ← Session transcripts
└── agents/<agentId>/sessions/      ← Per-agent session files
```

- Session transcripts are a `parentId` chain (DAG) in JSONL format
- Each message references its parent → enables branching conversations
- Per-directory CLAUDE.md files scope behavior rules

---

## Part 8: Pattern Comparison Matrix

| Pattern | Who Uses It | Persistence | Human-Readable | Agent-Writable | Survives Crash | Cross-Session |
|---------|-------------|-------------|----------------|----------------|----------------|---------------|
| **In-memory state** | OpenDevin | RAM | ❌ | ✅ | ❌ | ❌ |
| **JSONL memory** | Pi-Agent, vkcoder | File | ❌ | ✅ | ✅ | ✅ |
| **Task directory** | Cline | JSON files | ❌ | ✅ | ✅ | ✅ |
| **Shadow git** | Cline | `.git` | ❌ | ✅ | ✅ | ✅ |
| **Memory Bank** | Cline methodology | Markdown | ✅ | ✅ | ✅ | ✅ |
| **CLAUDE.md** | Claude Code, OpenClaw | Markdown | ✅ | ❌ (human only) | ✅ | ✅ |
| **AGENTS.md** | Codex, Kilocode, OpenClaw | Markdown | ✅ | ❌ (human only) | ✅ | ✅ |
| **SKILL.md** | OpenClaw, Pi-Agent, Cline | Markdown | ✅ | ✅ (via generators) | ✅ | ✅ |
| **Filesystem state machine** | Advanced Agent Loop | `.agent/` dir | ✅ | ✅ | ✅ | ✅ |
| **Focus chain** | Cline | Markdown checklist | ✅ | ✅ | ✅ | ✅ |

---

## Part 9: The Key Insights for Our Agent Loop

### 1. The Three Layers of Agent "Soul"

Every stable long-running agent needs three layers of persistent identity:

```
Layer 1: IDENTITY (what I am)
  → CLAUDE.md / AGENTS.md / system prompt
  → Never changes during a task
  → Human-authored

Layer 2: KNOWLEDGE (what I've learned)
  → Memory Bank / SKILL.md / learnings.md
  → Updated by agent during work
  → Carries across sessions

Layer 3: STATE (where I am now)
  → plan.md / checkpoint.json / progress.md
  → Updated every step
  → Enables crash recovery and resume
```

### 2. Markdown > JSON for Agent-Facing State

JSON is for machines. Markdown is for both agents and humans. The most successful patterns (Memory Bank, Focus Chain, CLAUDE.md) use markdown because:
- LLMs read markdown natively — no parsing overhead
- Humans can read/edit it (inspect, debug, correct)
- It's version-controllable (git diff is meaningful)
- It survives format evolution (no schema migrations)

### 3. Context Compaction Is the Bottleneck

The #1 cause of agent loop death is context window overflow. The approaches:

| Approach | Used By | Quality | Speed |
|----------|---------|---------|-------|
| Hard truncation | Early Cline | Low (loses info) | Instant |
| Sliding window | OpenDevin PlannerAgent | Medium | Instant |
| LLM summarization | OpenDevin Monologue, Cline auto-condense | High (but lossy) | Slow (extra LLM call) |
| File-based rebuild | Advanced Agent Loop, Memory Bank | Highest | Medium |

**The winner is file-based rebuild**: Instead of trying to compress the conversation, write your state to files and rebuild the prompt from files every step. The conversation is irrelevant — the files are the truth.

### 4. Anti-Drift Requires Multiple Mechanisms

No single mechanism prevents drift in long loops. You need all of:

| Mechanism | Description | Source |
|-----------|-------------|--------|
| Task in every prompt | Original task always visible | OpenDevin, all agents |
| Focus checklist | Markdown checklist of remaining items | Cline Focus Chain |
| Periodic reminders | "What's your current subtask?" | Cline (every 6 requests) |
| Escalating urgency | Warnings get stronger with step count | Advanced Agent Loop |
| Error loop breaker | Force strategy change after N failures | Cline, Advanced Agent Loop |
| Scope decay detection | % of recent actions on-current-task | Advanced Agent Loop |
| Completion verification | LLM second opinion on "finish" | Advanced Agent Loop |

### 5. The "soul.md" Doesn't Exist — But Its Spirit Does

No agent actually uses a file called `soul.md`. But the concept exists everywhere:
- **CLAUDE.md** = the project's soul (identity + memory + behavior rules)
- **AGENTS.md** = the same, for different runtimes
- **Memory Bank** = the agent's personal soul (learned knowledge + current state)
- **SKILL.md** = modular soul fragments (domain expertise as portable files)

The real insight: **the soul is not one file — it's a directory of structured markdown files that collectively define who the agent is, what it knows, and where it currently stands.**

---

## Part 10: How This Maps to Our Advanced Agent Loop

Our `.agent/` directory IS the agent's soul:

```
.agent/
├── task.md              ← IDENTITY: what I'm here to do
├── plan.md              ← STATE: my living roadmap
├── progress.md          ← STATE: step-by-step history
├── context-summary.md   ← KNOWLEDGE: compacted memory of past work
├── checkpoint.json      ← STATE: machine-readable recovery point
└── memory/
    ├── files-touched.json    ← KNOWLEDGE: what files I've interacted with
    ├── commands-run.json     ← KNOWLEDGE: what commands I've executed
    └── learnings.md          ← KNOWLEDGE: what I've discovered
```

**What we already have from Design.md:**
- ✅ Filesystem state machine
- ✅ Three-tier memory (working, episode, reference)
- ✅ LLM-based compaction

- ✅ Plan-driven execution with state transitions
- ✅ Crash recovery via checkpoint
- ✅ Anti-drift at multiple levels
- ✅ Completion verification

**What we could add inspired by this research:**
- 🔲 **SOUL.md / Identity layer** — Bootstrap files (SOUL.md, IDENTITY.md) that define the agent's persistent self, re-read after every compaction (OpenClaw's core innovation)
- 🔲 **Pre-compaction memory flush** — System-enforced "write your memories to disk NOW" turn before compaction destroys context (OpenClaw's killer feature)
- 🔲 **Post-compaction identity recovery** — After compacting, inject "re-run your startup sequence, re-read identity files" (OpenClaw pattern)
- 🔲 **Memory Bank pattern** — structured `memory-bank/*.md` for cross-session knowledge
- 🔲 **CLAUDE.md/AGENTS.md loading** — auto-read project rules from workspace root
- 🔲 **Focus chain markdown** — human-editable checklist file that the agent and user can both modify
- 🔲 **Shadow git checkpoints** — workspace snapshot for undo (Cline's approach)
- 🔲 **Skill modules** — loadable SKILL.md files for domain expertise injection
- 🔲 **File deduplication** — detect repeated file reads and replace earlier ones with notices (Cline's 30% context savings)
- 🔲 **Stale file alerts** — chokidar watchers for files modified externally since last agent read
- 🔲 **Retain/Recall/Reflect loop** — Extract structured facts from logs, search via FTS+vectors, periodically reflect and curate (OpenClaw V2 research)
- 🔲 **Opinion evolution** — Track beliefs with confidence scores, update based on evidence (OpenClaw's Hindsight-inspired model)
- 🔲 **Subagent composition** — scout/planner/worker/reviewer as markdown-defined roles (Pi-mono)

---

*Report generated from exhaustive analysis of: OpenDevin.OpenDevin/, cline/, openclaw/, pi-mono/, kilocode/, aviary-agent-stage/, terminal-ai-coder-multi-agent/, and architecture documents in agents/*
