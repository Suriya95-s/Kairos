#!/usr/bin/env node
// src/kernel/cli.js
// Daemon control surface (3.7): start · stop · status · say · missions · logs.
//
// Every verb goes through the HTTP protocol rather than reaching into the
// registries directly. The daemon is the single writer; a CLI that edited
// missions/index.json behind its back would reintroduce exactly the concurrent
// mutation the kernel exists to prevent.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { BRAND, ensureHome, dir as kernelDir, home, PORT_FILE } from './paths.js';
import { DaemonClient, discover, daemonPid } from './client.js';
import { autostartArtifact, writeAutostartArtifact } from './daemon.js';
import { getVault } from './vault.js';

// fileURLToPath, not .pathname — see the note in missions.js.
const DAEMON_MAIN = fileURLToPath(new URL('./daemonMain.js', import.meta.url));

const HELP = `
${BRAND} — presence daemon

  ${BRAND} start [--foreground] [--auto-resume]
      Start the daemon. Detaches by default; --foreground keeps it attached.

  ${BRAND} stop [--force]
      Drain running missions (they checkpoint and become resumable), then exit.
      --force skips the drain.

  ${BRAND} status
      Health, uptime, sessions, missions, today's spend.

  ${BRAND} say "…" [--workspace DIR] [--profile NAME] [--session ID] [--follow]
      Send an utterance. Today it starts a mission; from Phase 4 the router
      decides between a reflex answer and a mission.

  ${BRAND} missions [--state STATE] [--watch]
      List missions. States: queued starting running stopping done failed
      stopped interrupted cancelled

  ${BRAND} mission <id> [--stop | --cancel | --resume]
      Inspect or control one mission.

  ${BRAND} logs [--limit N] [--kinds a,b] [--session ID] [--follow]
      Read the event journal. --follow streams live.

  ${BRAND} secret list | set <scope> <key> <value> | delete <scope> <key> | status
      Manage stored credentials. Config files reference them as
      "vault:<scope>.<key>" so they stay committable.

  ${BRAND} llm [list | add <name> --url URL --model ID [--key KEY] | use <name> | check [<name> | --all] | remove <name> | price <name> [--in USD --out USD]]
      Named model endpoints, checked one by one. "use" picks the default;
      AGENT_BASE_URL / AGENT_MODEL env vars still override it per process.
      Keys go into the vault — models.json only ever holds "vault:…" references.
      "price" sets what a model costs per 1M tokens, for the spend meter.

  ${BRAND} usage [--month YYYY-MM | --all] [--json]
      The spend meter. Every model call is logged with the token counts the
      API itself returned and the dollars they cost at that moment — totals,
      per model, per purpose, per day.

  ${BRAND} ontology [list | show <domain> | history [<domain>] [--limit N] | ingest|add <file> [--domain NAME] | remove <domain> --force | graph [<domain>] [--open] | verify <domain> [--model NAME] [--force] | resolve <domain> [--model NAME] [--force] | critique <domain> [--model NAME] [--force] | ask <domain> <question…> [--offline] | proposals <domain> | approve <domain> <kind> <id> [--as NAME] | release <domain> [--as NAME] | releases <domain> | diff <domain> <relA> <relB> | drop [--open]]
      Drag-and-drop ontology engine. Drop files into the drop folder (subfolder
      = domain); the daemon ingests them into evidence-backed candidates and
      refreshes a knowledge-graph view (graph.html). Approval is always human.
      "history" shows when each domain was built and its latest journal events;
      "remove" deletes a domain permanently (asks first; --force to mean it).

  ${BRAND} trust [list | grant <tool> [--workspace DIR] [--prefix ARG=VAL] [--expires HOURS] | revoke <id> | revoke-all]
      Standing approvals. T3 (irreversible) actions can never be granted one.

  ${BRAND} audit [--limit N] [--tier T2] [--summary]
      Every consequential action: who, what, why, outcome.

  ${BRAND} undo [<action-id>]
      Reverse an action where a recipe exists. Bare lists what is reversible.

  ${BRAND} integrations [list | set <capability> <stage> | audit | check <tool>]
      Enable real-world capabilities in stages. Everything starts off.

  ${BRAND} voice [check | listen | devices]
      Speak to it. "check" reports what is missing and how to install it.
      listen [--wake WORD | --no-wake] [--stt CMD] [--model PATH] [--tts CMD]
             [--device NAME] [--silence MS] [--once] [--timing]

  ${BRAND} report [--weeks N]
      The self-report: missions, cost, what improved, what got worse.

  ${BRAND} install [--write]
      Print the OS autostart artifact for this platform. --write saves it;
      enabling it is always left to you.

Environment:
  KAIROS_HOME    override ~/.${BRAND}
  KAIROS_BRAND   rename the system (this is the only knob that does it)
`;

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=');
      const next = argv[i + 1];
      if (inline !== undefined) flags[k] = inline;
      else if (next && !next.startsWith('--')) { flags[k] = next; i++; }
      else flags[k] = true;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function out(text) { process.stdout.write(text + '\n'); }
function err(text) { process.stderr.write(text + '\n'); }

function fmtDuration(ms) {
  if (!ms || ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// ── Verbs ───────────────────────────────────────────────────────────────────

async function cmdStart(flags) {
  ensureHome();
  const pid = daemonPid();
  if (pid) {
    out(`${BRAND} is already running (pid ${pid}).`);
    return 0;
  }
  // Stale run files from a crashed daemon would otherwise make every client
  // try to connect to a port nobody is listening on.
  try { fs.rmSync(PORT_FILE()); } catch { /* nothing to clear */ }

  const env = { ...process.env };
  if (flags['auto-resume']) env.KAIROS_AUTO_RESUME = '1';

  if (flags.foreground) {
    const child = spawn(process.execPath, [DAEMON_MAIN], { env, stdio: 'inherit' });
    return new Promise(resolve => child.on('exit', code => resolve(code ?? 0)));
  }

  const logPath = path.join(kernelDir('logs'), 'daemon.out.log');
  const logFd = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, [DAEMON_MAIN], {
    env,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    // Detach from the launching terminal's console. Without this the daemon —
    // and every mission it forks — stays in that console's process group, and
    // the group gets CTRL_C when the terminal's foreground process exits.
    windowsHide: true,
  });
  child.unref();

  // Wait for the port file rather than declaring success on spawn: a daemon
  // that dies during boot would otherwise be reported as started.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const conn = discover();
    if (conn) {
      out(`${BRAND} started — pid ${child.pid}, port ${conn.port}`);
      out(`  home: ${home()}`);
      out(`  logs: ${logPath}`);
      return 0;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  err(`${BRAND} did not come up within 15s — see ${logPath}`);
  return 1;
}

async function cmdStop(flags) {
  const pid = daemonPid();
  if (!pid) { out(`${BRAND} is not running.`); return 0; }

  if (flags.force) {
    process.kill(pid, 'SIGKILL');
    out(`${BRAND} killed (pid ${pid}). Missions left running will be re-adopted on next start.`);
    return 0;
  }

  try {
    const client = new DaemonClient();
    await client.shutdown();
    out(`${BRAND} is draining missions and shutting down…`);
  } catch {
    // The HTTP surface may already be gone; the signal path still works.
    process.kill(pid, 'SIGTERM');
    out(`${BRAND} sent SIGTERM (pid ${pid}).`);
  }

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (!daemonPid()) { out(`${BRAND} stopped.`); return 0; }
    await new Promise(r => setTimeout(r, 250));
  }
  err(`${BRAND} did not exit within 60s — use "${BRAND} stop --force" if it is wedged.`);
  return 1;
}

async function cmdStatus() {
  const pid = daemonPid();
  if (!pid) {
    out(`${BRAND}: not running`);
    out(`  home: ${home()}`);
    return 1;
  }
  const s = await new DaemonClient().status();
  const healthMark = s.health === 'healthy' ? '●' : '◐';
  out(`${BRAND}: ${healthMark} ${s.health}${s.healthReason ? ` — ${s.healthReason}` : ''}`);
  out(`  pid ${s.pid} · up ${fmtDuration(s.uptimeMs)} · ${s.home}`);
  out(`  sessions: ${s.sessions}`);
  out(`  missions: ${s.missions.active} active · ${s.missions.queued} queued · ${s.missions.total} total`);
  const cap = s.budgets.maxDollarsPerDay;
  out(`  spend today: $${(s.spendToday || 0).toFixed(4)}${cap > 0 ? ` / $${cap}` : ' (no cap)'}`);
  out(`  disk: ${(s.diskBytes / 1024 / 1024).toFixed(1)} MB`);
  return 0;
}

/**
 * Remember the last session per workspace.
 *
 * Without this every `say` mints a fresh session, so the daemon sees no running
 * missions for it and "also add tests" starts a rival mission instead of
 * steering the one already going. Conversational continuity across separate CLI
 * invocations is the whole point of a resident system — each command is a new
 * process, but it is not a new conversation.
 */
function sessionMemoryFile() {
  return path.join(kernelDir('run'), 'cli-sessions.json');
}

function rememberSession(workspace, sessionId) {
  try {
    const f = sessionMemoryFile();
    let map = {};
    try { map = JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { map = {}; }
    map[workspace] = { sessionId, ts: Date.now() };
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(map, null, 2));
  } catch { /* continuity is a convenience, never a hard failure */ }
}

function recallSession(workspace) {
  try {
    const map = JSON.parse(fs.readFileSync(sessionMemoryFile(), 'utf-8'));
    const entry = map[workspace];
    if (!entry) return null;
    // A day-old session is a different conversation. Resuming it would drag
    // yesterday's context into today's first sentence.
    if (Date.now() - entry.ts > 12 * 3600_000) return null;
    return entry.sessionId;
  } catch {
    return null;
  }
}

async function cmdSay(positional, flags) {
  const text = positional.join(' ').trim();
  if (!text) { err(`Usage: ${BRAND} say "what you want"`); return 2; }

  const workspace = flags.workspace ? path.resolve(String(flags.workspace)) : process.cwd();
  const client = new DaemonClient();
  const res = await client.say({
    text,
    workspace,
    profile: flags.profile || null,
    sessionId: flags.session || (flags['new-session'] ? null : recallSession(workspace)),
  });

  if (res.sessionId) rememberSession(workspace, res.sessionId);

  // The router has five possible verdicts and only two of them produce a
  // mission. Assuming otherwise crashed on the first question anyone asked.
  if (res.text) out(res.text);

  if (res.mission) {
    out(`mission ${res.mission.id} — ${res.mission.state}`);
    if (res.mission.blockedReason) out(`  blocked: ${res.mission.blockedReason}`);
    if (flags.follow) return followMission(client, res.mission.id);
    out(`  follow with: ${BRAND} logs --follow --session ${res.sessionId}`);
  } else if (res.proposal) {
    out(`  start it with: ${BRAND} say "${res.proposal.task.replace(/"/g, '\\"')}" --workspace ${workspace}`);
  }

  return res.action === 'clarify' ? 1 : 0;
}

/** Stream a single mission's events until it reaches a terminal state. */
async function followMission(client, missionId) {
  for await (const evt of client.stream()) {
    if (evt.kind !== 'mission_update' || evt.payload.missionId !== missionId) continue;
    const p = evt.payload;
    if (p.action === 'step') {
      out(`  [${p.step}] ${p.tool ?? ''} ${String(p.resultPreview ?? '').slice(0, 100).replace(/\n/g, ' ')}`);
    } else if (p.action === 'ended') {
      out(`${p.state}${p.exitReason ? ` (${p.exitReason})` : ''}${p.error ? ` — ${p.error}` : ''}`);
      return p.state === 'done' ? 0 : 1;
    } else if (p.action === 'blocked') {
      out(`  blocked: ${p.blockedReason}`);
    }
  }
  return 0;
}

async function cmdMissions(flags) {
  const client = new DaemonClient();
  const { missions } = await client.missions(flags.state ? { state: flags.state } : {});
  if (!missions.length) { out('no missions'); return 0; }

  for (const m of missions) {
    const when = m.endedAt ? `ended ${fmtDuration(Date.now() - m.endedAt)} ago`
      : m.startedAt ? `running ${fmtDuration(Date.now() - m.startedAt)}`
      : 'queued';
    out(`${m.id}  ${m.state.padEnd(11)} ${when.padEnd(22)} ${m.title}`);
    if (m.blockedReason) out(`${' '.repeat(13)}blocked: ${m.blockedReason}`);
    if (m.error)         out(`${' '.repeat(13)}error: ${m.error}`);
  }
  return 0;
}

async function cmdMission(positional, flags) {
  const id = positional[0];
  if (!id) { err(`Usage: ${BRAND} mission <id> [--stop|--cancel|--resume]`); return 2; }
  const client = new DaemonClient();

  if (flags.stop)   { out(`stopping ${id}…`);  await client.stopMission(id);   return 0; }
  if (flags.cancel) { out(`cancelling ${id}…`); await client.cancelMission(id); return 0; }
  if (flags.resume) { out(`resuming ${id}…`);  await client.resumeMission(id); return 0; }

  const { mission } = await client.mission(id);
  out(JSON.stringify(mission, null, 2));
  return 0;
}

async function cmdLogs(flags) {
  const client = new DaemonClient();
  const params = {};
  if (flags.limit)   params.limit = flags.limit;
  if (flags.kinds)   params.kinds = flags.kinds;
  if (flags.session) params.sessionId = flags.session;

  const { events } = await client.logs(params);
  let last = null;
  for (const e of events) { printEvent(e); last = e.id; }
  if (!flags.follow) return 0;

  for await (const e of client.stream({ after: last })) {
    if (flags.kinds && !String(flags.kinds).split(',').includes(e.kind)) continue;
    if (flags.session && e.sessionId !== flags.session) continue;
    printEvent(e);
  }
  return 0;
}

function printEvent(e) {
  const ts = new Date(e.ts).toISOString().slice(11, 19);
  const detail = e.payload?.action
    ? `${e.payload.action}${e.payload.missionId ? ` ${e.payload.missionId}` : ''}`
    : JSON.stringify(e.payload).slice(0, 120);
  out(`${ts} ${e.kind.padEnd(15)} ${detail}`);
}

function cmdSecret(positional) {
  const [sub, scope, key, ...rest] = positional;
  const vault = getVault();

  if (!sub || sub === 'list') {
    const listed = vault.list();
    const scopes = Object.keys(listed);
    if (!scopes.length) { out('no secrets stored'); return 0; }
    for (const s of scopes) out(`${s}: ${listed[s].join(', ')}`);
    return 0;
  }

  if (sub === 'status') {
    const s = vault.status();
    out(`backend: ${s.backend} (${s.protected ? 'OS-protected' : 'UNPROTECTED'})`);
    out(`entries: ${s.entries}`);
    out(`file:    ${s.path}`);
    if (s.warning) out(`warning: ${s.warning}`);
    return 0;
  }

  if (sub === 'set') {
    const value = rest.join(' ');
    if (!scope || !key || !value) {
      err(`Usage: ${BRAND} secret set <scope> <key> <value>`);
      return 2;
    }
    vault.set(scope, key, value);
    // Never echo the value back — shell history is bad enough already.
    out(`stored ${scope}.${key} — reference it as "vault:${scope}.${key}"`);
    return 0;
  }

  if (sub === 'delete') {
    if (!scope || !key) { err(`Usage: ${BRAND} secret delete <scope> <key>`); return 2; }
    out(vault.delete(scope, key) ? `deleted ${scope}.${key}` : `${scope}.${key} was not set`);
    return 0;
  }

  err(`unknown secret subcommand "${sub}" (list | set | delete | status)`);
  return 2;
}

async function cmdOntology(positional, flags) {
  const store = await import('../ontology/store.js');
  const engine = await import('../ontology/engine.js');
  const graph = await import('../ontology/graph.js');
  const [sub, a, b, c] = positional;

  const { spawn } = await import('node:child_process');
  const openInShell = (target) => {
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', target]]
      : process.platform === 'darwin' ? ['open', [target]]
      : ['xdg-open', [target]];
    try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); } catch { /* print the path instead */ }
  };

  if (!sub || sub === 'list') {
    const domains = store.listDomains();
    out(`drop folder: ${engine.dropDir()}   (drag files here; a subfolder names its domain)`);
    if (!domains.length) {
      out(`no ontology domains yet — drop a .csv/.json/.jsonl/.md file, or:`);
      out(`  ${BRAND} ontology ingest <file> [--domain NAME]`);
      return 0;
    }
    for (const d of domains) {
      const counts = store.loadProjection(d).counts;
      out(`  ${d}: ${counts.object_type || 0} types, ${counts.instance || 0} instances, ${counts.relationship || 0} relations, ${counts.ingest || 0} ingests`);
    }
    return 0;
  }

  if (sub === 'show') {
    if (!a) { err(`Usage: ${BRAND} ontology show <domain> [--as-of ISO]`); return 2; }
    let proj;
    if (flags['as-of'] && flags['as-of'] !== true) {
      const ts = Date.parse(String(flags['as-of']));
      if (Number.isNaN(ts)) { err(`--as-of needs a parseable date, got "${flags['as-of']}"`); return 2; }
      proj = store.loadProjectionAsOf(a, ts);
      out(`(as of ${new Date(ts).toISOString()})`);
    } else {
      proj = store.loadProjection(a);
    }
    if (!proj.counts.object_type && !proj.counts.instance) { out(`domain "${a}" is empty or unknown`); return 1; }
    for (const t of proj.object_type.values()) {
      const insts = [...proj.instance.values()].filter((i) => i.type === t.name);
      const approved = insts.filter((i) => i.state === 'approved').length;
      out(`◆ ${t.name} [${t.state}] — ${insts.length} instance(s), ${approved} approved`);
      for (const p of t.properties || []) out(`    ${p.name}: ${p.type}${p.enum ? ` {${p.enum.join('|')}}` : ''}${t.keyProperty === p.name ? '  ← key' : ''}`);
    }
    const refs = [...proj.relationship.values()].filter((r) => r.kind === 'reference');
    for (const r of refs) out(`→ ${r.fromType}.${r.viaProperty} refers to ${r.toType} [${r.state}] (coverage ${Math.round((r.coverage || 0) * 100)}%)`);
    return 0;
  }

  // `add` is an alias for `ingest` — "how do I add files?" deserves a verb
  // that answers itself.
  if (sub === 'ingest' || sub === 'add') {
    if (!a) { err(`Usage: ${BRAND} ontology ${sub} <file> [--domain NAME]`); return 2; }
    const domain = flags.domain && flags.domain !== true ? String(flags.domain) : 'default';
    const res = engine.ingestFile(domain, a);
    if (!res.ok) { err(`not ingested: ${res.reason}`); return 1; }
    out(`ingested ${res.file} → domain "${res.domain}" (${res.appended} new document(s))`);
    out(`  types ${res.counts.object_type || 0} · instances ${res.counts.instance || 0} · relations ${res.counts.relationship || 0}`);
    const html = graph.writeGraphHtml(res.domain);
    out(`  graph: ${html}`);
    return 0;
  }

  // What was built, and when — folded from each domain's own journal.
  if (sub === 'history') {
    const fmtTs = (ms) => ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : '—';
    if (!a) {
      const domains = store.listDomains();
      if (!domains.length) { out('no ontology domains yet'); return 0; }
      out('domain histories (newest activity first):');
      const rows = domains.map((d) => store.domainHistory(d, { limit: 0 }))
        .sort((x, z) => (z.lastAt || 0) - (x.lastAt || 0));
      for (const h of rows) {
        const kinds = Object.entries(h.byKind).map(([k, n]) => `${n} ${k}`).join(' · ') || 'empty';
        out(`  ${h.domain}: created ${fmtTs(h.createdAt)} · last change ${fmtTs(h.lastAt)} · ${h.docs} document(s)`);
        out(`    ${kinds}`);
      }
      out(`details:  ${BRAND} ontology history <domain> [--limit N]`);
      return 0;
    }
    const limit = flags.limit && flags.limit !== true ? parseInt(String(flags.limit), 10) : 30;
    const h = store.domainHistory(a, { limit: Number.isFinite(limit) && limit > 0 ? limit : 30 });
    if (!h.docs) { out(`domain "${a}" is empty or unknown`); return 1; }
    out(`${h.domain}: created ${fmtTs(h.createdAt)} · last change ${fmtTs(h.lastAt)} · ${h.docs} document(s)`);
    out(`  ${Object.entries(h.byKind).map(([k, n]) => `${n} ${k}`).join(' · ')}`);
    out(`latest ${h.entries.length} event(s), newest first:`);
    for (const e of h.entries) {
      const by = e.by ? `  by ${e.by}` : '';
      const state = e.state ? `  [${e.state}]` : '';
      out(`  ${fmtTs(e.at)}  ${e.kind.padEnd(17)} ${e.id} v${e.version}${state}${by}`);
    }
    return 0;
  }

  // Deleting a domain is irreversible — the ceremony lives here, on purpose:
  // the bare command tells you what you are about to destroy and how to mean it.
  if (sub === 'remove') {
    if (!a) { err(`Usage: ${BRAND} ontology remove <domain> --force`); return 2; }
    if (!store.listDomains().includes(a)) { err(`no domain named "${a}" — see: ${BRAND} ontology list`); return 1; }
    const h = store.domainHistory(a, { limit: 0 });
    let intakeFiles = 0;
    try { intakeFiles = fs.readdirSync(path.join(store.domainDir(a), 'intake')).length; } catch { /* no intake */ }
    if (a === 'kairos' && !flags['loop-memory']) {
      err(`"kairos" is the loop's own memory — mission outcomes and learnings live there.`);
      err(`If you truly want it gone: ${BRAND} ontology remove kairos --force --loop-memory`);
      return 2;
    }
    if (!flags.force) {
      out(`"${a}" holds ${h.docs} journal document(s) (${Object.entries(h.byKind).map(([k, n]) => `${n} ${k}`).join(' · ') || 'nothing'})`);
      if (intakeFiles) out(`and ${intakeFiles} ingested source file(s) in its intake folder — deleted with it.`);
      out(`This cannot be undone. To proceed:  ${BRAND} ontology remove ${a} --force`);
      return 0;
    }
    store.removeDomain(a);
    out(`removed domain "${a}" (${h.docs} document(s)${intakeFiles ? ` + ${intakeFiles} intake file(s)` : ''})`);
    out(`re-create it any time by dropping files into: ${engine.dropDir()}\\${a}`);
    return 0;
  }

  if (sub === 'graph') {
    const domain = a || store.listDomains()[0];
    if (!domain) { err(`no domains yet — drop or ingest a file first`); return 1; }
    let asOf = null;
    if (flags['as-of'] && flags['as-of'] !== true) {
      asOf = Date.parse(String(flags['as-of']));
      if (Number.isNaN(asOf)) { err(`--as-of needs a parseable date, got "${flags['as-of']}"`); return 2; }
    }
    const html = graph.writeGraphHtml(domain, { asOf });
    out(html);
    if (flags.open) openInShell(html);
    return 0;
  }

  if (sub === 'diff') {
    if (!a || !b || !c) { err(`Usage: ${BRAND} ontology diff <domain> <releaseA> <releaseB>`); return 2; }
    let d;
    try { d = store.diffReleases(a, b, c); } catch (e) { err(e.message); return 1; }
    out(`${d.from} → ${d.to}`);
    if (!d.added.length && !d.removed.length && !d.changed.length) { out('  identical approved sets'); return 0; }
    for (const k of d.added) out(`  ${'+'} ${k}`);
    for (const k of d.removed) out(`  ${'-'} ${k}`);
    for (const k of d.changed) out(`  ~ ${k}`);
    return 0;
  }

  if (sub === 'approve' || sub === 'retire') {
    if (!a || !b || !c) { err(`Usage: ${BRAND} ontology ${sub} <domain> <kind> <id> [--as NAME]`); return 2; }
    const approver = flags.as && flags.as !== true ? String(flags.as) : (process.env.USERNAME || process.env.USER || 'owner');
    // Approving a proposal IS applying it — an approved-but-unapplied proposal
    // would be a lie in the journal.
    if (sub === 'approve' && b === 'proposal') {
      const res = store.applyProposal(a, c, approver);
      out(`proposal ${c} approved by ${approver} — applied ${res.op}:`);
      for (const d of res.applied) out(`  ${d.kind}/${d.id} → v${d.version}`);
      return 0;
    }
    const res = store.setPublicationState(a, b, c, sub === 'approve' ? 'approved' : 'retired', approver);
    out(`${b}/${c} → ${res.payload.state}${sub === 'approve' ? ` (by ${approver})` : ''}`);
    return 0;
  }

  // verify / resolve / critique are the three model lenses. All CLI-only —
  // token spend stays a human act; the daemon never runs these on its own.
  if (sub === 'verify' || sub === 'resolve' || sub === 'critique') {
    if (!a) { err(`Usage: ${BRAND} ontology ${sub} <domain> [--model NAME] [--force]`); return 2; }
    const { chatCompletion } = await import('../llm.js');
    let llmOpts = {};
    if (flags.model && flags.model !== true) {
      const { resolveModel } = await import('./models.js');
      const m = resolveModel(String(flags.model));
      llmOpts = { baseURL: m.baseURL, model: m.model, apiKey: m.apiKey };
    }
    // The lens contract is llm(messages) → reply TEXT. chatCompletion returns
    // a {content, usage, …} envelope; forgetting .content turned every live
    // reply into "[object Object]" and floored the first real verify run.
    const llm = async (messages) => (await chatCompletion(messages, { ...llmOpts, temperature: 0, purpose: `ontology.${sub}` })).content;
    let res;
    if (sub === 'resolve') {
      const resolve = await import('../ontology/resolve.js');
      res = await resolve.resolveEntities(a, { llm, force: !!flags.force });
    } else {
      const verifier = await import('../ontology/verifier.js');
      res = sub === 'critique'
        ? await verifier.critiqueDomain(a, { llm, force: !!flags.force })
        : await verifier.verifyDomain(a, { llm, force: !!flags.force });
    }
    if (res.skipped) { out(res.skipped); return 0; }
    if (res.floor) { err(`${sub} fell back to the deterministic floor — ontology unchanged: ${res.reason}`); return 1; }
    if (res.replay) { out(`unchanged since last ${sub} (key ${res.key}) — replay, no tokens spent. Use --force to re-run.`); }
    if (res.slices && res.slices.skipped > 0) out(`slices: ${res.slices.reviewed}/${res.slices.total} reviewed (${res.slices.skipped} unchanged since their last review)`);
    if (sub === 'resolve' && !res.replay) out(`${res.pairs} candidate pair(s) judged, ${res.keptApart || 0} confidently kept apart`);
    out(`${res.proposals.length} proposal(s) appended, ${res.discarded || 0} discarded (low confidence / invalid target)`);
    for (const id of res.proposals) out(`  ${id}`);
    if (res.proposals.length) out(`review with: ${BRAND} ontology proposals ${a}`);
    return 0;
  }

  if (sub === 'ask') {
    if (!a || positional.length < 3) { err(`Usage: ${BRAND} ontology ask <domain> <question…> [--model NAME] [--release ID] [--offline]`); return 2; }
    const question = positional.slice(2).join(' ');
    const query = await import('../ontology/query.js');
    let llm = null;
    if (!flags.offline) {
      const { chatCompletion } = await import('../llm.js');
      let llmOpts = {};
      if (flags.model && flags.model !== true) {
        const { resolveModel } = await import('./models.js');
        const m = resolveModel(String(flags.model));
        llmOpts = { baseURL: m.baseURL, model: m.model, apiKey: m.apiKey };
      }
      llm = async (messages) => (await chatCompletion(messages, { ...llmOpts, temperature: 0, purpose: 'ontology.ask' })).content;
    }
    const releaseId = flags.release && flags.release !== true ? String(flags.release) : null;
    const res = await query.answerQuestion(a, question, { llm, releaseId });
    if (!res.answer) { out(res.reason || 'the graph has nothing matching that question'); return 1; }
    if (res.floor) out(`(deterministic facts — ${res.floor})`);
    out(res.answer);
    out(`\nplan ${res.plan.id} · ${res.plan.nodes} node(s)${res.plan.release ? ` · pinned to ${res.plan.release}` : ''} · ${(res.cites || []).length} citation(s)`);
    return 0;
  }

  if (sub === 'proposals') {
    if (!a) { err(`Usage: ${BRAND} ontology proposals <domain>`); return 2; }
    const proj = store.loadProjection(a);
    const props = [...(proj.proposal || new Map()).entries()];
    if (!props.length) { out(`no proposals in "${a}" — run: ${BRAND} ontology verify ${a}`); return 0; }
    for (const [id, p] of props) {
      const what = p.change?.op === 'rename' ? `rename ${p.target?.id} → "${p.change.name}"`
        : p.change?.op === 'describe' ? `describe ${p.target?.id}: "${p.change.description}"`
        : p.change?.op === 'merge_types' ? `merge type ${p.change.retire} into ${p.change.keep}`
        : p.change?.op === 'merge_instances' ? `merge instance ${p.change.retire} into ${p.change.keep}`
        : p.change?.op === 'retire_relation' ? `retire relation ${p.target?.id}`
        : p.change?.op === 'retype_property' ? `retype ${p.target?.id}.${p.change.property} → ${p.change.type}`
        : p.change?.op === 'annotate' ? `annotate ${p.target?.id} [${(p.change.annotation?.tags || []).join(', ')}]${p.change.annotation?.note ? ` — ${p.change.annotation.note}` : ''}`
        : `relate ${p.change?.relation?.from} —${p.change?.relation?.name}→ ${p.change?.relation?.to}`;
      out(`◇ ${id} [${p.state}] (${Math.round((p.confidence || 0) * 100)}%)`);
      out(`    ${what}`);
      if (p.rationale) out(`    why: ${p.rationale}`);
    }
    out(`apply one with: ${BRAND} ontology approve ${a} proposal <id>   (or retire it)`);
    return 0;
  }

  if (sub === 'release') {
    if (!a) { err(`Usage: ${BRAND} ontology release <domain> [--as NAME]`); return 2; }
    const createdBy = flags.as && flags.as !== true ? String(flags.as) : (process.env.USERNAME || process.env.USER || 'owner');
    let res;
    try { res = store.createRelease(a, { createdBy }); } catch (e) { err(e.message); return 1; }
    const what = Object.entries(res.counts).map(([k, n]) => `${n} ${k}`).join(', ');
    if (res.existed) out(`approved set unchanged — already pinned as ${res.id} (${what})`);
    else out(`pinned ${res.id} (${what}) — this exact approved graph is now citable forever`);
    out(`  ${res.file}`);
    return 0;
  }

  if (sub === 'releases') {
    if (!a) { err(`Usage: ${BRAND} ontology releases <domain>`); return 2; }
    const rels = store.listReleases(a);
    if (!rels.length) { out(`no releases in "${a}" — pin one with: ${BRAND} ontology release ${a}`); return 0; }
    for (const r of rels) {
      const what = Object.entries(r.counts || {}).map(([k, n]) => `${n} ${k}`).join(', ');
      out(`◈ ${r.id}  ${new Date(r.createdAt).toISOString()}  by ${r.createdBy}  (${what})`);
    }
    return 0;
  }

  if (sub === 'drop') {
    const dir = engine.dropDir();
    out(dir);
    if (flags.open) openInShell(dir);
    return 0;
  }

  err(`unknown ontology subcommand "${sub}" — try: list | show | history | ingest | add | remove | graph | verify | resolve | critique | ask | proposals | approve | retire | release | releases | diff | drop`);
  return 2;
}

async function cmdLlm(positional, flags) {
  const models = await import('./models.js');
  const [sub, name] = positional;

  if (!sub || sub === 'list') {
    const data = models.loadModels();
    const names = Object.keys(data.models);
    if (!names.length) {
      out(`no models registered — add one with:`);
      out(`  ${BRAND} llm add <name> --url http://localhost:8000/v1 --model <id> [--key <api-key>]`);
      return 0;
    }
    for (const n of names.sort()) {
      const m = data.models[n];
      const mark = data.active === n ? '●' : '○';
      const key = m.apiKey ? ` key=${m.apiKey}` : '';
      const check = m.lastCheck
        ? (m.lastCheck.ok ? ` — ok ${m.lastCheck.latencyMs}ms (${m.lastCheck.ts.slice(0, 10)})` : ` — FAILED (${m.lastCheck.ts.slice(0, 10)})`)
        : ' — never checked';
      out(`  ${mark} ${n}: ${m.model} @ ${m.baseURL}${key}${check}`);
    }
    if (!data.active) out(`  (none active — pick one with: ${BRAND} llm use <name>)`);
    return 0;
  }

  if (sub === 'add') {
    if (!name || !flags.url || !flags.model) {
      err(`Usage: ${BRAND} llm add <name> --url <baseURL> --model <id> [--key <api-key>] [--notes TEXT]`);
      return 2;
    }
    let keyRef = '';
    if (flags.key && flags.key !== true) {
      keyRef = String(flags.key);
      if (!keyRef.startsWith('vault:')) {
        // A literal key on the command line goes straight into the vault; only
        // the reference is written down. Same rule as mcp-servers.json.
        getVault().set('llm', name, keyRef);
        keyRef = `vault:llm.${name}`;
        out(`stored the key in the vault as ${keyRef} — models.json only holds the reference`);
      }
    }
    models.addModel(name, {
      baseURL: String(flags.url),
      model: String(flags.model),
      apiKey: keyRef,
      notes: flags.notes && flags.notes !== true ? String(flags.notes) : '',
    });
    out(`added "${name}" (${flags.model} @ ${flags.url})`);
    out(`check it with:  ${BRAND} llm check ${name}`);
    return 0;
  }

  if (sub === 'use') {
    if (!name) { err(`Usage: ${BRAND} llm use <name>`); return 2; }
    const entry = models.setActive(name);
    out(`"${name}" (${entry.model}) is now the default model.`);
    out(`New processes pick it up immediately; a running daemon keeps its old one`);
    out(`until restarted (${BRAND} stop && ${BRAND} start). Env vars still override.`);
    return 0;
  }

  if (sub === 'remove') {
    if (!name) { err(`Usage: ${BRAND} llm remove <name>`); return 2; }
    out(models.removeModel(name) ? `removed "${name}"` : `no model named "${name}"`);
    return 0;
  }

  if (sub === 'check') {
    const data = models.loadModels();
    const targets = flags.all ? Object.keys(data.models).sort() : [name || data.active].filter(Boolean);
    if (!targets.length) {
      err(`nothing to check — name a model, or add one first (${BRAND} llm add ...)`);
      return 2;
    }
    let failures = 0;
    for (const n of targets) {
      const entry = models.resolveModel(n);
      out(`${n}: ${entry.model} @ ${entry.baseURL}`);
      const r = await models.checkModel(entry);
      models.recordCheck(n, r);
      if (!r.reachable) out(`  ○ GET /models did not answer (not fatal — some servers omit it)`);
      if (r.ok) {
        out(`  ✓ completion answered in ${r.latencyMs}ms — "${r.reply}"`);
      } else {
        failures++;
        out(`  ✗ ${r.error || 'no answer'}`);
      }
      if (r.thinking?.detected) {
        const t = r.thinking;
        out(`  ⚠ reasoning model — spent ${t.reasoningTokens} tokens thinking before answering.`);
        if (t.withoutThinkingMs != null) {
          out(`    ${t.thinkingLatencyMs}ms with thinking vs ${t.withoutThinkingMs}ms without.`);
        }
        if (t.needsDisable) {
          out(`    It returned NOTHING until thinking was disabled. Set AGENT_NO_THINKING=1`);
          out(`    (config.js does this automatically for known Qwen3 profiles).`);
        }
      }
    }
    return failures ? 1 : 0;
  }

  if (sub === 'price') {
    if (!name) { err(`Usage: ${BRAND} llm price <name> [--in USD --out USD]   (per 1M tokens)`); return 2; }
    const data = models.loadModels();
    const entry = data.models[name];
    if (!entry) { err(`no model named "${name}" — see: ${BRAND} llm list`); return 2; }
    const hasIn = flags.in !== undefined && flags.in !== true;
    const hasOut = flags.out !== undefined && flags.out !== true;
    if (!hasIn && !hasOut) {
      const { priceFor } = await import('./usage.js');
      const p = priceFor(entry.model);
      if (p) out(`${name} (${entry.model}): $${p.in}/1M input · $${p.out}/1M output (${p.source === 'registry' ? 'set by you' : 'builtin table'})`);
      else out(`${name} (${entry.model}): UNPRICED — its calls are logged with real token counts but $0. Set a price: ${BRAND} llm price ${name} --in USD --out USD`);
      return 0;
    }
    if (!hasIn || !hasOut) { err(`set both rates: --in USD --out USD (per 1M tokens)`); return 2; }
    const pin = Number(flags.in);
    const pout = Number(flags.out);
    if (!Number.isFinite(pin) || pin < 0 || !Number.isFinite(pout) || pout < 0) {
      err(`prices must be numbers ≥ 0, in USD per 1M tokens (e.g. --in 0.15 --out 0.60)`);
      return 2;
    }
    entry.price = { in: pin, out: pout };
    models.saveModels(data);
    out(`"${name}" (${entry.model}) priced: $${pin}/1M input · $${pout}/1M output`);
    out(`applies to calls from now on — past ledger lines keep the rates they were billed at`);
    return 0;
  }

  err(`unknown llm subcommand "${sub}" (list | add | use | check | remove | price)`);
  return 2;
}

// ── usage — the spend meter ─────────────────────────────────────────────────
//
// Reads the ledger kernel/usage.js writes at the LLM choke point. Everything
// shown here is the API's own token accounting; dollars were computed when
// each call happened, so a price change never rewrites history.

async function cmdUsage(flags) {
  const usage = await import('./usage.js');
  let month = null;
  if (flags.month && flags.month !== true) {
    month = String(flags.month);
    if (!/^\d{4}-\d{2}$/.test(month)) { err(`--month wants YYYY-MM, got "${month}"`); return 2; }
  }
  const s = usage.summarizeUsage({ month, all: !!flags.all });
  if (flags.json) { out(JSON.stringify(s, null, 2)); return 0; }

  const n = (v) => v.toLocaleString('en-US');
  const usd = (c) => (c > 0 && c < 0.0001 ? '<$0.0001' : `$${c.toFixed(4)}`);
  const line = (label, b) =>
    `    ${label.padEnd(44)} ${String(b.calls).padStart(5)} call(s) ${n(b.promptTokens).padStart(12)} in ${n(b.completionTokens).padStart(10)} out ${usd(b.cost).padStart(10)}`;

  const scope = flags.all ? `all time (${s.months.length} month(s))` : s.months[0];
  out(`spend — ${scope}`);
  if (!s.records) {
    out(`  no model calls recorded${flags.all ? '' : ' this month'} — the ledger starts with the first completion`);
    const others = usage.listMonths().filter((m) => !s.months.includes(m));
    if (others.length) out(`  other months on record: ${others.join(', ')} (see --month or --all)`);
    return 0;
  }
  const t = s.totals;
  out(`  ${s.records} call(s) · ${n(t.promptTokens)} in + ${n(t.completionTokens)} out = ${n(t.totalTokens)} tokens · ${usd(t.cost)}`);
  if (t.unpricedTokens > 0) {
    out(`  ⚠ ${n(t.unpricedTokens)} of those tokens are UNPRICED (model not in any price table) —`);
    out(`    real counts, unknown dollars. Fix: ${BRAND} llm price <name> --in USD --out USD`);
  }
  const sections = [['by model', s.byModel], ['by purpose', s.byPurpose], ['by day', s.byDay]];
  for (const [title, map] of sections) {
    out(`  ${title}:`);
    const keys = Object.keys(map).sort((a, b) => map[b].cost - map[a].cost || map[b].totalTokens - map[a].totalTokens);
    for (const k of keys) out(line(k, map[k]));
  }
  if (!flags.all) {
    const others = usage.listMonths().filter((m) => !s.months.includes(m));
    if (others.length) out(`  (--all also sums: ${others.join(', ')})`);
  }
  return 0;
}

async function cmdTrust(positional, flags) {
  const { getStandingApprovals } = await import('../trust/approvals.js');
  const { classify } = await import('../trust/tiers.js');
  const sa = getStandingApprovals();
  const [sub, tool] = positional;

  if (!sub || sub === 'list') {
    const live = sa.list();
    if (!live.length) { out('no standing approvals — every gated action is confirmed each time'); return 0; }
    for (const a of live) {
      const scope = a.workspace ? ` in ${a.workspace}` : '';
      const limit = a.maxUses ? ` (${a.uses}/${a.maxUses} uses)` : ` (${a.uses} uses)`;
      const match = a.argMatch ? ` where ${JSON.stringify(a.argMatch)}` : '';
      out(`${a.id}  ${a.tier}  ${a.tool}${scope}${match}${limit}`);
    }
    return 0;
  }

  if (sub === 'grant') {
    if (!tool) { err(`Usage: ${BRAND} trust grant <tool> [--workspace DIR] [--prefix arg=value]`); return 2; }
    const argMatch = {};
    if (flags.prefix) {
      const [k, ...rest] = String(flags.prefix).split('=');
      argMatch[k] = { prefix: rest.join('=') };
    }
    try {
      const g = sa.grant({
        tool,
        workspace: flags.workspace ? path.resolve(String(flags.workspace)) : null,
        argMatch: Object.keys(argMatch).length ? argMatch : null,
        expiresAt: flags.expires ? Date.now() + parseFloat(flags.expires) * 3600_000 : null,
        maxUses: flags.uses ? parseInt(flags.uses, 10) : null,
      });
      out(`granted ${g.id} — ${g.tool} (${g.tier})`);
      if (!g.argMatch && !g.workspace) {
        // An unconstrained grant on an external-effect tool is a broad thing to
        // hand out; say so rather than let it pass silently.
        out(`  note: unconstrained. Narrow it with --workspace or --prefix, or revoke with "${BRAND} trust revoke ${g.id}".`);
      }
      return 0;
    } catch (e) {
      err(e.message);
      return 1;
    }
  }

  if (sub === 'revoke') {
    if (!tool) { err(`Usage: ${BRAND} trust revoke <id>`); return 2; }
    out(sa.revoke(tool) ? `revoked ${tool}` : `no live approval ${tool}`);
    return 0;
  }

  if (sub === 'revoke-all') {
    out(`revoked ${sa.revokeAll()} standing approval(s)`);
    return 0;
  }

  if (sub === 'check') {
    if (!tool) { err(`Usage: ${BRAND} trust check <tool>`); return 2; }
    const c = classify(tool, {});
    out(`${tool}: ${c.tier} — ${c.reason}`);
    return 0;
  }

  err(`unknown trust subcommand "${sub}" (list | grant | revoke | revoke-all | check)`);
  return 2;
}

async function cmdAudit(flags) {
  const { getActuationLedger } = await import('../trust/ledger.js');
  const l = getActuationLedger();

  if (flags.summary) {
    const s = l.summary({ since: flags.since ? Date.now() - parseFloat(flags.since) * 3600_000 : null });
    out(`${s.total} actions — ${s.external} external, ${s.irreversible} irreversible`);
    out(`  by tier:    ${JSON.stringify(s.byTier)}`);
    out(`  by outcome: ${JSON.stringify(s.byOutcome)}`);
    return 0;
  }

  const entries = l.read({
    limit: flags.limit ? parseInt(flags.limit, 10) : 40,
    tier: flags.tier || null,
  });
  if (!entries.length) { out('no recorded actions'); return 0; }
  for (const e of entries) {
    const when = new Date(e.ts).toISOString().slice(11, 19);
    const mark = e.outcome === 'ok' ? ' ' : '!';
    out(`${mark}${when} ${e.tier} ${e.tool.padEnd(24)} ${e.grant.padEnd(9)} ${e.outcome}${e.irreversible ? ' [no undo]' : ''}`);
    if (e.why) out(`${' '.repeat(11)}${e.why}`);
  }
  return 0;
}

async function cmdUndo(positional) {
  const { getActuationLedger } = await import('../trust/ledger.js');
  const l = getActuationLedger();
  const id = positional[0];

  if (!id) {
    const list = l.undoable();
    if (!list.length) { out('nothing recorded that can be reversed'); return 0; }
    out('reversible actions (newest first):');
    for (const e of list) {
      out(`  ${e.id}  ${new Date(e.ts).toISOString().slice(11, 19)}  ${e.tool}  → ${e.undo.kind}`);
    }
    out(``);
    out(`Undo one with: ${BRAND} undo <id>`);
    return 0;
  }

  const res = await l.undo(id);
  if (res.ok) { out(res.reason); return 0; }
  err(res.reason);
  if (res.manual) err(`  ${res.manual}`);
  return 1;
}

async function cmdReport(flags) {
  const client = new DaemonClient();
  const weeks = flags.weeks ? parseFloat(flags.weeks) : 1;
  const res = await client.request('POST', '/api/report', { body: { periodMs: weeks * 7 * 86400000 } });
  out(res.text || 'nothing to report');
  return 0;
}

async function cmdIntegrations(positional, flags) {
  const { getIntegrationRegistry, INTEGRATIONS, STAGES, auditServerTools } =
    await import('../trust/integrations.js');
  const reg = getIntegrationRegistry();
  const [sub, capability, stage] = positional;

  if (!sub || sub === 'list') {
    out('Integrations enable in stages. Each starts "off"; advancing is your decision.');
    out('');
    for (const i of reg.list()) {
      const mark = i.stage === 'off' ? ' ' : '●';
      out(`${mark} ${String(i.order)}. ${i.label.padEnd(14)} ${i.stage.padEnd(6)} ${i.servers.slice(0, 3).join(', ')}`);
      if (i.jumped) out(`${' '.repeat(6)}note: advanced more than one stage at once`);
    }
    out('');
    out(`Stages: ${STAGES.join(' → ')}`);
    out(`Set one with: ${BRAND} integrations set <capability> <stage>`);
    return 0;
  }

  if (sub === 'set') {
    if (!capability || !stage) {
      err(`Usage: ${BRAND} integrations set <capability> <stage>`);
      err(`  capabilities: ${Object.keys(INTEGRATIONS).join(', ')}`);
      err(`  stages:       ${STAGES.join(', ')}`);
      return 2;
    }
    try {
      const res = reg.setStage(capability, stage, { by: 'cli', reason: flags.reason || '' });
      out(`${capability}: ${res.from} → ${res.to}`);
      if (res.jumped) {
        // Worth saying rather than silently allowing: the skipped stage is where
        // you would have discovered the server names its tools unexpectedly.
        out('  you skipped a stage — run "integrations audit" to see what is now reachable');
      }
      if (stage === 'full' && capability === 'email') {
        out('  email sending is now enabled. It is still confirmed per action (T2).');
      }
      return 0;
    } catch (e) { err(e.message); return 1; }
  }

  if (sub === 'audit') {
    // Check what a connected server's REAL tool names classify as, before
    // trusting the verb heuristics with anything that matters.
    const { getAllMcpTools } = await import('../mcp/registry.js');
    const names = getAllMcpTools().map(t => t.name);
    if (!names.length) {
      out('no MCP tools are connected — start the daemon with AGENT_MCP_ENABLED=1 first');
      return 0;
    }
    const { tools, warnings } = auditServerTools(names, reg);
    for (const t of tools) {
      const mark = t.allowed ? ' ' : '×';
      out(`${mark} ${t.tier} ${t.tool.padEnd(38)} ${t.allowed ? 'reachable' : `needs stage "${t.needsStage}"`}`);
    }
    if (warnings.length) {
      out('');
      for (const w of warnings) out(`! ${w}`);
    }
    return 0;
  }

  if (sub === 'check') {
    if (!capability) { err(`Usage: ${BRAND} integrations check <tool-name>`); return 2; }
    const res = reg.check(capability);
    out(`${capability}: ${res.allowed ? 'reachable' : 'BLOCKED'} — ${res.reason}`);
    return res.allowed ? 0 : 1;
  }

  err(`unknown integrations subcommand "${sub}" (list | set | audit | check)`);
  return 2;
}

function cmdInstall(flags) {
  const artifact = autostartArtifact();
  out(`Platform: ${artifact.platform} (${artifact.kind})`);
  out('');
  if (artifact.path) {
    out(`File: ${artifact.path}`);
    out('');
    out(artifact.content);
    if (flags.write) {
      writeAutostartArtifact(artifact);
      out(`Written to ${artifact.path}`);
    } else {
      out('Re-run with --write to save it.');
    }
    out('');
  }
  out('Then enable it yourself:');
  out(`  ${artifact.command}`);
  // Registering a process that starts at login is not something an agent
  // should do on the user's behalf without them seeing the exact command.
  return 0;
}

// ── Entry ───────────────────────────────────────────────────────────────────

export async function main(argv = process.argv.slice(2)) {
  const { flags, positional } = parseArgs(argv);
  const verb = positional.shift();

  if (!verb || flags.help || verb === 'help') { out(HELP.trim()); return 0; }

  try {
    switch (verb) {
      case 'start':    return await cmdStart(flags);
      case 'stop':     return await cmdStop(flags);
      case 'status':   return await cmdStatus();
      case 'say':      return await cmdSay(positional, flags);
      case 'missions': return await cmdMissions(flags);
      case 'mission':  return await cmdMission(positional, flags);
      case 'logs':     return await cmdLogs(flags);
      case 'secret':   return cmdSecret(positional);
      case 'llm':      return await cmdLlm(positional, flags);
      case 'usage':    return await cmdUsage(flags);
      case 'ontology': return await cmdOntology(positional, flags);
      case 'trust':    return await cmdTrust(positional, flags);
      case 'audit':    return await cmdAudit(flags);
      case 'undo':     return await cmdUndo(positional);
      case 'report':   return await cmdReport(flags);
      case 'integrations': return await cmdIntegrations(positional, flags);
      case 'voice': {
        // Imported lazily: the voice modules are only needed for this one verb,
        // and every other verb pays for them at startup otherwise.
        const { cmdVoice } = await import('../voice/cli.js');
        return await cmdVoice(positional, flags);
      }
      case 'install':  return cmdInstall(flags);
      default:
        err(`unknown command "${verb}"`);
        out(HELP.trim());
        return 2;
    }
  } catch (e) {
    err(`${BRAND}: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(code => {
    // Not `process.exit(code)`. Killing the process while a socket is still
    // closing trips a libuv assertion on Windows
    // (`!(handle->flags & UV_HANDLE_CLOSING)`), which turned a successful
    // `llm check` into exit 127 — a passing command reporting failure.
    //
    // Setting exitCode lets an idle loop exit on its own with the right code.
    // The timer is the backstop for a verb that leaves something open, and it
    // is unref'd so it never delays an exit that would have happened anyway.
    process.exitCode = code;
    setTimeout(() => process.exit(code), 2000).unref();
  });
}
