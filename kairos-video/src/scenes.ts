// The tour script. Every claim here was checked against the code by the
// feature-inventory pass (src/kernel/cli.js, apps/tui, src/ontology, src/trust,
// src/kernel/{usage,vault,models}.js). Known trap deliberately excluded:
// `missions --watch` is in HELP but not implemented — never demo it.
import { SceneData } from './core';

export const SCENES: SceneData[] = [
  {
    id: 'what',
    kicker: 'MEET KAIROS',
    title: 'A resident agent on your machine',
    bubbles: [
      "Hi — I'm Kairos. An autonomous agent that lives on your computer as a resident daemon. Plain Node.js, zero dependencies, nothing leaves your machine unless you wire it up.",
    ],
    term: [
      { t: 'cmd', s: 'kairos status' },
      { t: 'ok', s: '● healthy — pid 38664 · up 4h 49m' },
      { t: 'out', s: 'home ~/.kairos · 2 session(s) · missions: 1 running, 3 done' },
      { t: 'out', s: "today $0.0312 of $5.00 daily cap · disk 41 MB" },
      { t: 'dim', s: 'an unreachable LLM shows as ◐ degraded_llm — honestly' },
    ],
  },
  {
    id: 'door',
    kicker: 'THE FRONT DOOR',
    title: 'One word starts everything',
    bubbles: [
      'Bare `kairos` is the front door: it makes sure the daemon is up — idempotently, never a double start — and opens the TUI cockpit attached to it. Any other verb passes straight through to the CLI.',
    ],
    term: [
      { t: 'cmd', s: 'kairos' },
      { t: 'ok', s: '✓ daemon already running (pid 38664)' },
      { t: 'out', s: 'opening TUI — ● ATTACHED' },
      { t: 'cmd', s: 'k ontology history' },
      { t: 'dim', s: '`k` is the short alias — pure CLI passthrough' },
    ],
  },
  {
    id: 'say',
    kicker: 'CONVERSATION',
    title: 'Talk to it — a router decides',
    bubbles: [
      'Say anything. My router picks one of five verdicts: quick questions get a direct answer, real work becomes a mission. Follow-ups within 12 hours steer the same session per workspace.',
    ],
    term: [
      { t: 'cmd', s: 'kairos say "what changed in the parser this week?"' },
      { t: 'out', s: '↩ answered directly — no mission needed' },
      { t: 'cmd', s: 'kairos say "add tests to the parser" --follow' },
      { t: 'ok', s: '▶ mission m-8fd19f95 started — streaming steps…' },
      { t: 'dim', s: "LLM down? it says so — missions queue until it's back" },
    ],
  },
  {
    id: 'missions',
    kicker: 'MISSIONS',
    title: 'Work that survives everything',
    bubbles: [
      'Missions are child processes owned by the daemon. They checkpoint, resume, and are re-adopted after a crash. Stopping drains them gracefully — and closing the TUI stops nothing at all.',
    ],
    term: [
      { t: 'cmd', s: 'kairos missions --state running' },
      { t: 'out', s: 'm-8fd19f95  running  12m  "add tests to the parser"' },
      { t: 'cmd', s: 'kairos mission m-8fd19f95 --resume' },
      { t: 'ok', s: '✓ resumed from checkpoint' },
      { t: 'cmd', s: 'kairos stop' },
      { t: 'out', s: 'draining — missions checkpoint and resume next start' },
    ],
  },
  {
    id: 'tui',
    kicker: 'THE COCKPIT',
    title: 'A seven-page TUI',
    bubbles: [
      'The cockpit streams everything live. Approvals appear inline on the Live page, one keypress away. Four accent themes, three Live layouts, full reduced-motion and mono modes.',
    ],
    term: [
      { t: 'out', s: '[1] LIVE      steps · output · inline approvals' },
      { t: 'out', s: '[2] MEMORY    palace events · skills graded A–D' },
      { t: 'out', s: '[3] METRICS   latency p95 · spend ledger · quality' },
      { t: 'out', s: '[4] CHAT      direct LLM chat, tool-approval modal' },
      { t: 'out', s: '[5] ARENA     multi-model debate → ranked synthesis' },
      { t: 'out', s: '[6] VOICE     mic telemetry + speaker-verify scores' },
      { t: 'out', s: '[7] ONTOLOGY  domains · proposal queue · activity' },
      { t: 'dim', s: '/theme aurora·ocean·ember·lime — /layout split·focus·wide' },
    ],
  },
  {
    id: 'palette',
    kicker: 'THE COCKPIT',
    title: 'The / command palette',
    bubbles: [
      'Hit / for the palette — fuzzy-filtered, tab-completed. Reads run in-process, instant. Token-spending lenses spawn the real CLI: the TUI is a faster hand on the same levers, never a second implementation.',
    ],
    term: [
      { t: 'cmd', s: '/' },
      { t: 'out', s: '/usage     spend ledger: tokens + dollars' },
      { t: 'out', s: '/verify    verifier lens — spends tokens' },
      { t: 'out', s: '/approve   approve a HITL request' },
      { t: 'out', s: '/steer     send steering message to agent' },
      { t: 'cmd', s: '/verify btoshop mini54' },
      { t: 'warn', s: 'running (spends tokens) — output opens when done' },
      { t: 'dim', s: 'plain text without a slash steers the running agent' },
    ],
  },
  {
    id: 'drop',
    kicker: 'KNOWLEDGE',
    title: 'Drop a file, get an ontology',
    bubbles: [
      'Drop CSV, JSON or Markdown into my inbox — or straight onto the Ontology page. Deterministic induction builds a typed knowledge graph: object types, instances, relationships. No model, no tokens.',
    ],
    term: [
      { t: 'cmd', s: 'kairos ontology drop --open' },
      { t: 'out', s: '📥 ~/.kairos/drop — a subfolder names the domain' },
      { t: 'out', s: 'dropped: btoshop/orders.csv · btoshop/customers.csv' },
      { t: 'ok', s: '✓ ingested → 4 object types · 312 instances · 6 relations' },
      { t: 'dim', s: 'same bytes twice? replayed — nothing ever doubles' },
    ],
  },
  {
    id: 'lenses',
    kicker: 'KNOWLEDGE',
    title: 'Three model lenses — human-fired only',
    bubbles: [
      "Verify finds what's missing. Resolve merges duplicate entities. Critique refutes wrong joins. Only a human can run them — and an unchanged domain replays the last result for free.",
    ],
    term: [
      { t: 'cmd', s: 'kairos ontology verify btoshop --model mini54' },
      { t: 'out', s: '13 proposal(s) appended, 0 discarded' },
      { t: 'cmd', s: 'kairos ontology verify btoshop --model mini54' },
      { t: 'ok', s: 'unchanged since last verify — replay, no tokens spent' },
      { t: 'warn', s: 'PII is redacted before the model sees anything — fail-closed' },
      { t: 'dim', s: 'bad or low-confidence output changes nothing (deterministic floor)' },
    ],
  },
  {
    id: 'approve',
    kicker: 'KNOWLEDGE',
    title: 'Models propose. Humans approve.',
    bubbles: [
      'A lens can only ever propose. Approving is a human act — and approving IS applying, with evidence required and an approver who must differ from the proposer. Enforced in the store, not the UI.',
    ],
    term: [
      { t: 'cmd', s: 'kairos ontology proposals btoshop' },
      { t: 'out', s: '◇ proposal:rename:ab12cd34 [candidate] (86%)' },
      { t: 'out', s: '  rename "col_7" → "unit_price" — clearer for humans' },
      { t: 'cmd', s: 'kairos ontology approve btoshop proposal proposal:rename:ab12cd34 --as suresh' },
      { t: 'ok', s: '✓ applied — object_type type:Order → v3 [approved]' },
    ],
  },
  {
    id: 'history',
    kicker: 'KNOWLEDGE',
    title: 'Journaled, releasable, time-travelable',
    bubbles: [
      'Every change is journaled: who, what, when. Pin immutable releases, diff them, replay the graph as of any date — and ask questions whose answers must cite graph nodes or be discarded.',
    ],
    term: [
      { t: 'cmd', s: 'kairos ontology release btoshop --as suresh' },
      { t: 'ok', s: '✓ rel-002 pinned — immutable, citable' },
      { t: 'cmd', s: 'kairos ontology ask btoshop "top customer by orders?"' },
      { t: 'out', s: '"Acme GmbH — 41 orders [cite:inst:Customer:acme]"' },
      { t: 'dim', s: 'diff rel-001 rel-002 · show --as-of 2026-08-01 · graph --open' },
    ],
  },
  {
    id: 'vault',
    kicker: 'SECURITY',
    title: 'The encrypted vault',
    bubbles: [
      'Credentials live in an AES-256-GCM vault whose master key sits in the OS credential store. Config files only ever hold vault: references — the registry throws if a literal key tries to sneak in.',
    ],
    term: [
      { t: 'cmd', s: 'kairos secret set llm gateway ••••••••' },
      { t: 'ok', s: '✓ vaulted — values are never echoed back' },
      { t: 'cmd', s: 'kairos secret status' },
      { t: 'out', s: 'vault: 4 secret(s) · master key: OS-protected (DPAPI)' },
      { t: 'dim', s: 'models.json holds "vault:llm.gateway" — never a key' },
    ],
  },
  {
    id: 'trust',
    kicker: 'SECURITY',
    title: 'Trust tiers: unknown means dangerous',
    bubbles: [
      "Every tool call is tiered. Unclassified tools land at tier two minimum — it's an allowlist, not a denylist. And tier three, the irreversible stuff, can never be auto-approved by anything.",
    ],
    term: [
      { t: 'out', s: 'T0  read-only local            → automatic' },
      { t: 'out', s: 'T1  reversible local write     → automatic + audited' },
      { t: 'out', s: 'T2  reversible external effect → confirm or standing grant' },
      { t: 'out', s: 'T3  irreversible / expensive   → ALWAYS confirm, never grantable' },
      { t: 'cmd', s: 'kairos trust grant write_file --workspace . --expires 8' },
      { t: 'ok', s: '✓ standing approval — scoped, expiring, revocable' },
    ],
  },
  {
    id: 'audit',
    kicker: 'SECURITY',
    title: 'One audit ledger. Real undo.',
    bubbles: [
      "One ledger answers 'what has this thing done today'. Undo recipes are recorded at the moment of each action — so whether something is reversible is known before you need to take it back.",
    ],
    term: [
      { t: 'cmd', s: 'kairos audit --limit 2' },
      { t: 'out', s: '14:02  T1  write_file  standing  ok' },
      { t: 'out', s: '14:07  T2  send_slack  approved  ok  [no undo]' },
      { t: 'cmd', s: 'kairos undo' },
      { t: 'out', s: 'a3f1…  write_file src/parser.js — restore previous content' },
      { t: 'cmd', s: 'kairos undo a3f1' },
      { t: 'ok', s: '✓ reversed' },
    ],
  },
  {
    id: 'usage',
    kicker: 'ECONOMICS',
    title: 'Every token, metered',
    bubbles: [
      'Every model call — even the health probe — flows through one choke point into a monthly ledger. Token counts come from the API itself, dollars are computed at write time, and unknown prices are surfaced, never hidden.',
    ],
    term: [
      { t: 'cmd', s: 'kairos usage' },
      { t: 'out', s: '42 call(s) · 128,411 in + 9,302 out = 137,713 tokens · $0.0341' },
      { t: 'out', s: 'BY PURPOSE  mission · ontology.verify · llm.check' },
      { t: 'warn', s: '⚠ 1,204,332 tokens UNPRICED — fix: kairos llm price <name>' },
      { t: 'dim', s: 'a later price change never rewrites history' },
    ],
  },
  {
    id: 'models',
    kicker: 'MODELS',
    title: 'A registry of real endpoints',
    bubbles: [
      'Register any OpenAI-compatible endpoint. The check is a real round trip — the model list AND an actual completion — because a wrong model id answers the first cheerfully and fails the second.',
    ],
    term: [
      { t: 'cmd', s: 'kairos llm add mini54 --url http://gw:7080/v1 --model gpt-5.4-mini --key sk-…' },
      { t: 'ok', s: '✓ key vaulted → vault:llm.mini54 · set active' },
      { t: 'cmd', s: 'kairos llm check mini54' },
      { t: 'ok', s: '✓ /models + real completion — 412ms · "ready"' },
      { t: 'dim', s: 'detects reasoning models · flags when thinking must be off' },
    ],
  },
  {
    id: 'voice',
    kicker: 'AND MORE',
    title: 'Voice, integrations, self-reports',
    bubbles: [
      "Wake-word voice that only passes your enrolled voiceprint. Real-world integrations staged from off to full — email's draft stage can't even reach send. Plus a weekly self-report and an autostart installer that shows you the command instead of running it behind your back.",
    ],
    term: [
      { t: 'cmd', s: 'kairos voice check' },
      { t: 'out', s: 'mic ✓ · whisper ✓ · speaker-verify ✓ · tts ✓ · model ✓' },
      { t: 'cmd', s: 'kairos voice listen --wake kairos' },
      { t: 'out', s: 'wake gate: enrolled voiceprint only' },
      { t: 'cmd', s: 'kairos integrations set email draft' },
      { t: 'out', s: 'create_draft reachable · send_* not reachable at all' },
      { t: 'dim', s: 'kairos report --weeks 2 · kairos logs --follow · kairos install' },
    ],
  },
];
