// src/kernel/daemon.js
// The resident process (3.1) — plus resource governance (S2) and degraded-mode
// operation (S3), which only mean anything once something is always running.
//
// The daemon owns exactly three things: the registries (one writer, no locks
// needed between it and its children), the health state, and the budget. It
// deliberately does NOT own the agent loop — missions are child processes, so
// the thing that must never die contains none of the code most likely to.
//
// Health is honest by construction. `degraded(llm)` is a state a client can
// render, not a silent retry loop that looks healthy while answering nothing:
// a Jarvis at 3am with the endpoint down has to say so.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BRAND,
  SCHEMA_VERSION,
  home,
  ensureHome,
  DAEMON_STATE_FILE,
  PID_FILE,
  readRegistry,
  writeRegistry,
  migrateRegistry,
} from './paths.js';
import { Bus, getBus } from './bus.js';
import { SessionRegistry } from './sessions.js';
import { MissionManager } from './missions.js';
import { inferUserState as inferUserStateImpl } from '../triggers/etiquette.js';
import { readState as readBrainState } from '../brain/neuromodulator.js';

/** Daemon health states (S3). Every one of these is surfaced to every client. */
export const HEALTH_STATES = Object.freeze([
  'starting', 'healthy', 'degraded_llm', 'degraded_memory', 'budget_hold', 'stopping', 'stopped',
]);

/** Mission states that count as a finished attempt for B1's confidence dial. */
const TERMINAL_MISSION_STATES = Object.freeze(['done', 'failed', 'cancelled']);

/** How many finished missions feed the confidence dial. */
const BRAIN_OUTCOME_WINDOW = 10;

/** Defaults for the S2 budgets. An always-on process must bound its appetite. */
export const DEFAULT_BUDGETS = Object.freeze({
  maxDollarsPerDay: 0,        // 0 = unbounded (opt-in ceiling)
  maxConcurrentMissions: 2,
  maxReflexPerHour: 0,        // 0 = unbounded; P4 populates this
  journalRetentionDays: 30,
  diskQuotaBytes: 2 * 1024 * 1024 * 1024,
  diskWarnRatio: 0.8,
});

const MIGRATIONS = {
  1: (data) => ({ ...data }),
};

export class Daemon {
  /**
   * @param {object}   [opts]
   * @param {object}   [opts.bus]
   * @param {object}   [opts.sessions]
   * @param {object}   [opts.missions]
   * @param {object}   [opts.budgets]
   * @param {function} [opts.now]
   * @param {function} [opts.llmProbe] async () => boolean — injectable for tests
   * @param {boolean}  [opts.timers]   false → no background intervals (tests drive tick())
   */
  constructor({
    bus = null,
    sessions = null,
    missions = null,
    budgets = {},
    now = Date.now,
    llmProbe = null,
    timers = true,
  } = {}) {
    this._now = now;
    this._timers = timers;
    this._llmProbe = llmProbe || defaultLlmProbe;
    this.budgets = { ...DEFAULT_BUDGETS, ...budgets };

    this.bus = bus || getBus();
    this.sessions = sessions || new SessionRegistry({ bus: this.bus, now });
    this.missions = missions || new MissionManager({
      bus: this.bus,
      sessions: this.sessions,
      maxConcurrent: this.budgets.maxConcurrentMissions,
      now,
    });

    this.memory = null;         // MemoryService, opened at start()
    this.consolidation = null;  // ConsolidationScheduler (5.4)
    this.intents = null;        // IntentLedger (6.3)
    this.scheduler = null;      // TriggerScheduler (6.1)
    this.watchers = null;       // WatcherRunner (6.2)
    this.followups = null;      // FollowUpLedger (6.4)
    this.outbox = null;         // Outbox (6.5)
    this.approvalChannel = null; // ApprovalChannel (7.5)
    this.health = 'stopped';
    /** Last VERIFIED wake word (P8 → B1). Null until the voice loop reports one. */
    this._lastVerifiedVoiceAt = null;
    this.healthReason = 'not started';
    this.startedAt = null;
    this._intervals = [];
    this._spend = {};          // 'YYYY-MM-DD' → USD
    this._reflexCalls = [];    // timestamps, for the per-hour cap
    this._stopping = false;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Boot. Order matters: claim the PID file before touching anything else, so a
   * second daemon fails fast instead of two processes writing one registry.
   */
  async start({ adopt = true, autoResume = false } = {}) {
    ensureHome();

    const existing = this.readPid();
    if (existing && existing !== process.pid && pidAlive(existing)) {
      throw new Error(`${BRAND} is already running (pid ${existing}). Use "${BRAND} stop" first.`);
    }

    this.startedAt = this._now();
    this._setHealth('starting', 'booting');
    fs.writeFileSync(PID_FILE(), String(process.pid), 'utf-8');

    this._loadState();
    this.sessions.load();
    this.missions.load();

    // Re-adopt whatever the previous daemon left in flight. This is the P3
    // acceptance criterion: kill -9 mid-mission, restart, and the *kernel*
    // picks the mission back up rather than leaving a lying registry and a
    // wedged workspace lock.
    let adoption = { adopted: [], reclaimed: [] };
    if (adopt) {
      adoption = this.missions.adopt({ autoResume });
      if (adoption.adopted.length) {
        this._publish('daemon_state', {
          action: 'adopted',
          missionIds: adoption.adopted,
          reclaimedWorkspaces: adoption.reclaimed,
        }, 'soon');
      }
    }

    await this._startMemory();
    await this._startProactivity();
    await this._startOntology();
    await this.probeHealth();
    this._startTimers();
    this.saveState();

    this._publish('daemon_state', {
      action: 'started',
      pid: process.pid,
      home: home(),
      health: this.health,
      adopted: adoption.adopted.length,
    }, 'soon');

    return { pid: process.pid, home: home(), health: this.health, adoption };
  }

  /**
   * Open the memory service and schedule its upkeep (5.1 + 5.4).
   *
   * Consolidation runs only while nothing is in flight: competing with a live
   * mission for the same database to tidy it is exactly the wrong trade, and
   * the work is never urgent.
   */
  async _startMemory() {
    try {
      const { getMemoryService } = await import('../memoryd/service.js');
      const { ConsolidationScheduler } = await import('../memoryd/consolidate.js');

      this.memory = getMemoryService();
      this.memory.open();
      // The mission manager triggers the per-workspace import (5.2).
      this.missions._memory = this.memory;
      await this._syncIdentity();

      this.consolidation = new ConsolidationScheduler({
        service: this.memory,
        isIdle: () => this.missions.activeCount() === 0,
        now: this._now,
        onRun: (result) => this._publish('daemon_state', { action: 'consolidated', ...result }, 'whenever'),
      });
      if (this._timers) this.consolidation.start();
    } catch (err) {
      // A daemon that will not boot because memory is unavailable is worse than
      // one that runs statelessly and says so (S3).
      this.memory = null;
      this._setHealth('degraded_memory', `memory service unavailable: ${err.message}`);
    }
  }

  /**
   * Wire up proactivity (Phase 6).
   *
   * Every proactive message in the system funnels through one path:
   *   trigger/observation → intent budget → etiquette → outbox or bus.
   *
   * Having exactly one path is the point. A second route that skipped the
   * budget or the etiquette check would make both of them decorative, and the
   * first thing a person does with a system that interrupts badly is turn it
   * off — after which the genuinely urgent message never arrives either.
   */
  async _startProactivity() {
    try {
      const { IntentLedger } = await import('../triggers/intents.js');
      const { TriggerScheduler } = await import('../triggers/scheduler.js');
      const { WatcherRunner } = await import('../triggers/watchers.js');
      const { FollowUpLedger } = await import('../triggers/followups.js');
      const { Outbox } = await import('../triggers/etiquette.js');

      this.intents = new IntentLedger({ bus: this.bus, now: this._now });
      this.intents.load();
      this.outbox = new Outbox({ now: this._now });

      this.scheduler = new TriggerScheduler({
        ledger: this.intents,
        now: this._now,
        onFire: (intent, meta) => this._deliver({
          text: meta.late
            ? `${intent.description} (was due ${Math.round(meta.missedBy / 60_000)} minutes ago)`
            : intent.description,
          urgency: intent.urgency,
          intentId: intent.id,
          sessionId: intent.sessionId,
        }),
      });

      this.watchers = new WatcherRunner({
        ledger: this.intents,
        now: this._now,
        onObserve: (intent, obs) => this._deliver({
          text: `${intent.description} — ${obs.from} → ${obs.to}`,
          urgency: intent.urgency,
          intentId: intent.id,
          sessionId: intent.sessionId,
        }),
      });

      this.followups = new FollowUpLedger({ intents: this.intents, memory: this.memory, now: this._now });

      // A mission that stopped without finishing becomes a follow-up (6.4).
      // Subscribing to the bus rather than reaching into the mission manager
      // keeps this a consumer of the exit taxonomy, not a second owner of it.
      this.bus.subscribe('mission_update', (evt) => {
        if (evt.payload?.action !== 'ended') return;
        try {
          const mission = this.missions.get(evt.payload.missionId);
          if (mission) this.followups.onMissionEnded(mission);
        } catch { /* a follow-up is never worth failing an event delivery over */ }
      });

      if (this._timers) { this.scheduler.start(); this.watchers.start(); }

      // Approval delivery (7.5). Reachability is a security property: an
      // approval nobody sees times out, and timeout means deny — so a gate
      // with no live channel silently blocks everything instead of asking.
      const { channelFromConfig } = await import('../trust/channel.js');
      this.approvalChannel = channelFromConfig({ bus: this.bus });

      // 9.4 — the daemon files its own weekly digest, using its own trigger
      // system. Nothing bespoke: it is a `schedule` intent like any other, so
      // it is inspectable, pausable and budgeted exactly like the rest.
      this._scheduleSelfReport();
    } catch (err) {
      this._publish('daemon_state', { action: 'proactivity_unavailable', error: err.message }, 'soon');
    }
  }

  /**
   * Wire up the ontology engine's drag-and-drop inbox (O-series).
   *
   * Boot scan first: idempotence comes from content addressing, so files
   * dropped while the daemon was down are ingested on the next start rather
   * than lost. Then a debounced watcher for live drops. Every ingest and every
   * graph refresh is a bus event — same audit discipline as everything else.
   */
  async _startOntology() {
    try {
      const engine = await import('../ontology/engine.js');
      const { writeGraphHtml } = await import('../ontology/graph.js');

      const announce = (summary) => {
        if (!summary) return;
        let graphPath = null;
        if (summary.ok) {
          try { graphPath = writeGraphHtml(summary.domain); } catch { /* view refresh is best-effort */ }
        }
        this._publish('ontology', {
          action: summary.ok ? 'ingested' : 'ingest_skipped',
          domain: summary.domain, file: summary.file,
          ...(summary.ok
            ? {
              snapshot: summary.snapshot, appended: summary.appended, counts: summary.counts, graphPath,
              ...(summary.archivedTo ? { archivedTo: summary.archivedTo } : {}),
            }
            : { reason: summary.reason }),
        }, 'whenever');
      };

      const boot = engine.scanDropFolder();
      // Only announce boot-scan files that actually changed something — the
      // idempotent replays of already-ingested drops are silence, not news.
      for (const r of boot.results) {
        if (r.ok && r.appended > 0) announce(r);
        else if (!r.ok) announce(r);
      }

      if (this._timers) this._ontologyWatchClose = engine.watchDropFolder(announce);

      // G3 — the loop memory bridge: every ended mission is PROPOSED into the
      // 'kairos' meta-domain as candidate graph facts. Subscribing to the bus
      // keeps this a consumer of the exit taxonomy, like the follow-up ledger;
      // the bridge itself never throws, and candidates await a human.
      const bridge = await import('../ontology/bridge.js');
      this.bus.subscribe('mission_update', (evt) => {
        if (evt.payload?.action !== 'ended') return;
        const mission = this.missions.get(evt.payload.missionId);
        if (!mission) return;
        const res = bridge.proposeMissionOutcome(mission);
        if (res.appended > 0) {
          this._publish('ontology', {
            action: 'loop_fact_proposed', domain: bridge.LOOP_DOMAIN,
            missionId: mission.id, appended: res.appended, instance: res.instanceId,
          }, 'whenever');
        }
      });
    } catch (err) {
      this._publish('daemon_state', { action: 'ontology_unavailable', error: err.message }, 'whenever');
    }
  }

  /**
   * Schedule the weekly self-report, unless one is already scheduled.
   *
   * Monday morning rather than Sunday night: a report about last week is
   * actionable on the day you can act on it.
   */
  _scheduleSelfReport() {
    try {
      const already = this.intents.list({ kind: 'schedule' })
        .some(i => i.condition?.selfReport === true);
      if (already) return;

      const intent = this.scheduler.scheduleCron({
        cron: process.env.KAIROS_DIGEST_CRON || '0 9 * * 1',
        description: 'weekly self-report',
        urgency: 'whenever',
        // Once a week, and if it is ever suppressed that is a bug worth seeing
        // in the suppression count rather than a flood worth tolerating.
        budget: { max: 2, windowMs: 7 * 86_400_000 },
      });
      this.intents.update(intent.id, { condition: { ...intent.condition, selfReport: true } });
    } catch { /* a missing digest must never stop a daemon booting */ }
  }

  /**
   * Build the weekly digest (9.4) and run the promotion pass (9.3).
   *
   * Exposed so `<brand> report` and the tests can produce one on demand rather
   * than waiting a week to find out whether it reads well.
   */
  async selfReport({ periodMs = 7 * 86_400_000, promote = true } = {}) {
    const { collect, compare, renderDigest, regressions } = await import('../selfimprove/metrics.js');
    const { getActuationLedger } = await import('../trust/ledger.js');
    const now = this._now();
    const ledger = getActuationLedger();

    const sources = { missions: this.missions, ledger, memory: this.memory };
    const current = collect(sources, { from: now - periodMs, to: now });
    const previous = collect(sources, { from: now - 2 * periodMs, to: now - periodMs });
    const comparison = compare(previous, current);

    let promotions = null;
    if (promote) promotions = await this._runPromotions();

    let text = renderDigest(current, comparison);
    if (promotions) {
      const { renderPromotions } = await import('../selfimprove/promotion.js');
      const line = renderPromotions(promotions);
      if (line) text += `

${line}`;
    }

    // A regression is the one part of the digest that should not wait for
    // someone to read a weekly summary — it goes through the normal
    // notification path so etiquette decides when to say it.
    const worse = regressions(comparison);
    if (worse.length) {
      this._deliver({
        text: `Something is getting worse: ${worse.map(w => w.metric).join(', ')}.`,
        urgency: 'soon',
      });
    }

    return { text, current, previous, comparison, promotions, regressions: worse };
  }

  async _runPromotions() {
    try {
      const { applyPromotions } = await import('../selfimprove/promotion.js');
      const { getStandingApprovals } = await import('../trust/approvals.js');
      const { listSkills } = await import('../skills.js').catch(() => ({ listSkills: null }));
      const skills = typeof listSkills === 'function' ? listSkills() : [];
      if (!skills.length) return null;
      return applyPromotions(skills, getStandingApprovals(), { now: this._now() });
    } catch {
      return null;
    }
  }

  /**
   * The single delivery path for anything the system says unprompted.
   *
   * Etiquette decides; the outbox holds what is deferred. `speak` goes on the
   * bus as an urgent trigger event, which is what a client renders.
   */
  _deliver(notification) {
    if (!this.outbox) return { delivery: 'drop', reason: 'proactivity not started' };

    const decision = this.outbox.route(notification, {
      userState: this._inferUserState(),
      hour: new Date(this._now()).getHours(),
      policy: this.budgets.etiquette || {},
      arousal: this.brainState().arousal,
    });

    if (decision.delivery === 'speak') {
      this._publish('trigger', {
        action: 'notify',
        text: notification.text,
        intentId: notification.intentId ?? null,
        sessionId: notification.sessionId ?? null,
      }, notification.urgency || 'soon');
    }
    return decision;
  }

  /**
   * B1 — the daemon's internal state, composed from what it already knows.
   *
   * Computed on demand, never stored: a cached mood is a stale mood, and every
   * input here is already cheap to read. Callers pass the result down; nothing
   * imports it as ambient state.
   */
  brainState() {
    const missions = this.missions.list();
    const running = missions.filter(m => m.state === 'running' || m.state === 'starting').length;
    // Newest first, so this is the most recent handful of finished missions.
    const recentOutcomes = missions
      .filter(m => TERMINAL_MISSION_STATES.includes(m.state))
      .slice(0, BRAIN_OUTCOME_WINDOW)
      .map(m => m.state === 'done');

    const cap = this.budgets.maxDollarsPerDay;
    return readBrainState({
      userState: this._inferUserState(),
      health: this.health,
      runningMissions: running,
      maxConcurrentMissions: this.budgets.maxConcurrentMissions,
      spendRatio: cap > 0 ? this.spendToday() / cap : 0,
      recentOutcomes,
      lastVerifiedVoiceAt: this._lastVerifiedVoiceAt,
      urgentPending: false,
      now: this._now(),
    });
  }

  /**
   * Record that a verified wake word was heard (P8 voice → B1).
   *
   * Only ever called for speech that passed *speaker verification*: in a shared
   * room, an unverified voice is anyone's, and treating it as presence would
   * hand a stranger the ability to raise the assistant's arousal.
   */
  noteVerifiedVoice(at = null) {
    this._lastVerifiedVoiceAt = at ?? this._now();
    return this._lastVerifiedVoiceAt;
  }

  /**
   * One event from the voice loop — heard/rejected/answered/speaking — for
   * any attached surface to render (the TUI's Voice view).
   *
   * The B1 rule holds here: only an event carrying `verified: true` (the
   * speaker gate matched) moves `_lastVerifiedVoiceAt`. Everything else is
   * display data.
   */
  noteVoice(payload = {}) {
    if (payload && payload.verified === true) this.noteVerifiedVoice();
    this._publish('voice', {
      phase: String(payload.phase || 'event'),
      text: typeof payload.text === 'string' ? payload.text.slice(0, 500) : '',
      score: Number.isFinite(payload.score) ? payload.score : null,
      threshold: Number.isFinite(payload.threshold) ? payload.threshold : null,
      verified: payload.verified === true,
      reason: typeof payload.reason === 'string' ? payload.reason.slice(0, 200) : '',
      timing: payload.timing && typeof payload.timing === 'object' ? payload.timing : null,
    }, 'whenever');
    return true;
  }

  /** What the kernel can actually observe about the user's availability. */
  _inferUserState() {
    const sessions = this.sessions.list().filter(s => s.state !== 'closed');
    const lastSeenAt = sessions.reduce((max, s) => Math.max(max, s.lastSeenAt || 0), 0);
    const clientAttached = sessions.some(s => !!s.clientKind);
    return inferUserStateImpl({
      clientAttached,
      lastSeenAt: lastSeenAt || null,
      now: this._now(),
      doNotDisturb: !!this.budgets.doNotDisturb,
    });
  }

  /**
   * Everything queued while the user was away, drained for delivery now.
   * Called when a client attaches — this is the "at the right moment" in 6.4.
   */
  greet({ sessionId = null } = {}) {
    if (!this.outbox) return { queued: [], digest: '', followups: '' };
    const queued = this.outbox.drainQueued();
    const digest = this.outbox.drainDigest();

    let followups = '';
    try {
      const pending = this.followups?.pending({ sessionId }) || [];
      const claimable = pending.filter(i => this.followups.claim(i.id));
      followups = this.followups?.render(claimable) || '';
    } catch { /* nothing worth failing a greeting over */ }

    return { queued, digest, followups };
  }

  /**
   * Lift USER.md / MEMORY.md into global scope (5.3).
   *
   * Read from the daemon's own working directory, which is where a
   * user-level install keeps its identity files. Best-effort: a daemon that
   * refuses to boot because a markdown file is missing would be absurd.
   */
  async _syncIdentity() {
    try {
      const { syncIdentityToGlobal } = await import('../memoryd/identity.js');
      const { default: cfg } = await import('../config.js');
      const readIfPresent = (rel) => {
        try { return fs.readFileSync(path.resolve(process.cwd(), rel), 'utf-8'); } catch { return ''; }
      };
      const res = syncIdentityToGlobal(this.memory, {
        userProfile: readIfPresent(cfg.userFile),
        longTermMemory: readIfPresent(cfg.memoryFile),
      });
      if (res.synced || res.pruned) {
        this._publish('daemon_state', { action: 'identity_synced', ...res }, 'whenever');
      }
    } catch { /* identity sync is an enhancement, not a boot requirement */ }
  }

  /**
   * Shut down cleanly: stop accepting work, let running missions checkpoint,
   * then release the PID file. A daemon that exits without draining turns every
   * running mission into an orphan for the next boot to clean up.
   */
  async stop({ drain = true, reason = 'stop requested' } = {}) {
    if (this._stopping) return;
    this._stopping = true;
    this._setHealth('stopping', reason);

    this._stopTimers();
    if (this.consolidation) this.consolidation.stop();
    if (this.scheduler) this.scheduler.stop();
    if (this.watchers) this.watchers.stop();
    if (this._ontologyWatchClose) { try { this._ontologyWatchClose(); } catch { /* already closed */ } this._ontologyWatchClose = null; }
    if (drain) await this.missions.stopAll({ reason });

    this.saveState();
    this._publish('daemon_state', { action: 'stopped', reason }, 'soon');

    if (this.memory) { try { this.memory.close(); } catch { /* already closed */ } }
    try { fs.rmSync(PID_FILE()); } catch { /* already gone */ }
    // Dropped so a restart in the same process reopens them rather than reusing
    // handles to a database this daemon has already closed.
    this.memory = null;
    this.consolidation = null;
    this.health = 'stopped';
    this.healthReason = reason;
    this._stopping = false;
  }

  /** PID recorded by a running daemon, or null. */
  readPid() {
    try {
      const pid = parseInt(fs.readFileSync(PID_FILE(), 'utf-8').trim(), 10);
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  /** Is a daemon actually running right now (not just claiming to be)? */
  isRunning() {
    const pid = this.readPid();
    return pid != null && pidAlive(pid);
  }

  // ── Persisted state ───────────────────────────────────────────────────────

  _loadState() {
    const raw = readRegistry(DAEMON_STATE_FILE(), null);
    if (!raw) return;
    const { data } = migrateRegistry(raw, MIGRATIONS, SCHEMA_VERSION);
    this._spend = data.spend || {};
    if (data.budgets) this.budgets = { ...this.budgets, ...data.budgets };
    this.missions.maxConcurrent = this.budgets.maxConcurrentMissions;
  }

  saveState() {
    writeRegistry(DAEMON_STATE_FILE(), {
      schemaVersion: SCHEMA_VERSION,
      brand: BRAND,
      pid: this.health === 'stopped' ? null : process.pid,
      host: os.hostname(),
      startedAt: this.startedAt,
      updatedAt: this._now(),
      health: this.health,
      healthReason: this.healthReason,
      budgets: this.budgets,
      spend: this._spend,
    });
    return this;
  }

  /** Everything a client needs to render the daemon's state. */
  status() {
    const missions = this.missions.list();
    return {
      brand: BRAND,
      pid: this.readPid(),
      running: this.isRunning(),
      home: home(),
      health: this.health,
      healthReason: this.healthReason,
      startedAt: this.startedAt,
      uptimeMs: this.startedAt ? this._now() - this.startedAt : 0,
      sessions: this.sessions.list().length,
      missions: {
        total: missions.length,
        active: this.missions.activeCount(),
        queued: missions.filter(m => m.state === 'queued').length,
      },
      budgets: this.budgets,
      spendToday: this.spendToday(),
      memory: this.memory ? this.memory.stats() : null,
      consolidation: this.consolidation ? this.consolidation.status() : null,
      proactivity: this.intents ? {
        intents: this.intents.list().length,
        scheduler: this.scheduler?.status() ?? null,
        watchers: this.watchers?.status() ?? null,
        outbox: this.outbox?.status() ?? null,
        approvalChannel: this.approvalChannel?.status() ?? null,
        userState: this._inferUserState(),
      } : null,
      diskBytes: this.diskUsage(),
    };
  }

  // ── Health (S3) ───────────────────────────────────────────────────────────

  _setHealth(state, reason) {
    if (!HEALTH_STATES.includes(state)) throw new Error(`invalid health state "${state}"`);
    if (this.health === state && this.healthReason === reason) return;
    const previous = this.health;
    this.health = state;
    this.healthReason = reason;
    // Health transitions are bus events precisely so every surface can show
    // them without polling — the TUI's reconnect-honest header generalizes.
    this._publish('health', { state, reason, previous }, state === 'healthy' ? 'whenever' : 'soon');
  }

  /**
   * Probe the LLM endpoint and set health accordingly.
   * Budget hold outranks an endpoint outage: a paused-for-money daemon that
   * reports `degraded_llm` sends the user to debug the wrong thing.
   */
  async probeHealth() {
    if (this.isOverDailyBudget()) {
      this._setHealth('budget_hold', `daily budget of $${this.budgets.maxDollarsPerDay} reached`);
      return this.health;
    }
    let ok = false;
    try {
      ok = await this._llmProbe();
    } catch {
      ok = false;
    }
    if (ok) this._setHealth('healthy', 'llm endpoint reachable');
    else this._setHealth('degraded_llm', 'llm endpoint unreachable');

    // The internal state rides along with the health probe rather than owning
    // an interval of its own: it is derived from the same observations, and a
    // second timer publishing a second mood is two sources of truth.
    // `whenever` — nothing should ever be woken up by a mood change.
    this._publish('brain', this.brainState(), 'whenever');
    return this.health;
  }

  // ── Budgets (S2) ──────────────────────────────────────────────────────────

  _today() {
    return new Date(this._now()).toISOString().slice(0, 10);
  }

  spendToday() {
    return this._spend[this._today()] || 0;
  }

  /** Record mission spend. Crossing the cap pauses new work, it does not kill running work. */
  recordSpend(usd) {
    const amount = Number(usd);
    if (!Number.isFinite(amount) || amount <= 0) return this.spendToday();
    const day = this._today();
    this._spend[day] = (this._spend[day] || 0) + amount;
    this.saveState();

    if (this.isOverDailyBudget()) {
      // Stop *dispatching*; running missions pause at their next checkpoint via
      // the existing HITL pause plumbing rather than being killed mid-write.
      this.missions.maxConcurrent = 0;
      this._setHealth('budget_hold', `daily budget of $${this.budgets.maxDollarsPerDay} reached`);
    }
    return this._spend[day];
  }

  isOverDailyBudget() {
    const cap = this.budgets.maxDollarsPerDay;
    return cap > 0 && this.spendToday() >= cap;
  }

  /** Rate-limit for P4 reflex calls. Returns false when the hourly cap is hit. */
  allowReflexCall() {
    const cap = this.budgets.maxReflexPerHour;
    if (!cap || cap <= 0) return true;
    const cutoff = this._now() - 3_600_000;
    this._reflexCalls = this._reflexCalls.filter(t => t > cutoff);
    if (this._reflexCalls.length >= cap) return false;
    this._reflexCalls.push(this._now());
    return true;
  }

  /**
   * Lift a budget hold — either because the day rolled over or because the user
   * raised the cap. Restores dispatch and re-probes health.
   */
  async clearBudgetHold() {
    if (this.isOverDailyBudget()) return false;
    this.missions.maxConcurrent = this.budgets.maxConcurrentMissions;
    await this.probeHealth();
    return true;
  }

  /** Total bytes under the daemon home — input to the disk-quota warning. */
  diskUsage() {
    return dirSize(home());
  }

  /**
   * Rotation + quota check (S2). Prunes the bus journal past the retention
   * window and warns at the quota ratio.
   */
  rotate() {
    const deleted = this.bus.prune ? this.bus.prune({ retentionDays: this.budgets.journalRetentionDays }) : [];
    const bytes = this.diskUsage();
    const quota = this.budgets.diskQuotaBytes;
    const over = quota > 0 && bytes > quota * this.budgets.diskWarnRatio;
    if (over) {
      this._publish('daemon_state', {
        action: 'disk_warning',
        bytes,
        quota,
        ratio: Number((bytes / quota).toFixed(3)),
      }, 'soon');
    }
    if (deleted.length) {
      this._publish('daemon_state', { action: 'journal_pruned', segments: deleted.length }, 'whenever');
    }
    return { deleted: deleted.length, bytes, overQuota: over };
  }

  /**
   * One maintenance cycle: health probe, budget-hold recovery, rotation.
   * Exposed so tests drive it directly instead of waiting on timers.
   */
  async tick() {
    if (this.health === 'budget_hold') await this.clearBudgetHold();
    else await this.probeHealth();
    this.rotate();
    this.saveState();
    return this.status();
  }

  _startTimers() {
    if (!this._timers) return;
    const add = (fn, ms) => {
      const t = setInterval(() => { Promise.resolve(fn()).catch(() => {}); }, ms);
      if (typeof t.unref === 'function') t.unref();
      this._intervals.push(t);
    };
    // A 30s probe is frequent enough that "the endpoint came back" is noticed
    // before the user asks, and cheap enough to run for months.
    add(() => (this.health === 'budget_hold' ? this.clearBudgetHold() : this.probeHealth()), 30_000);
    add(() => { this.rotate(); this.saveState(); }, 3_600_000);
  }

  _stopTimers() {
    for (const t of this._intervals) clearInterval(t);
    this._intervals = [];
  }

  _publish(kind, payload, urgency = 'whenever') {
    try {
      this.bus.publish({ source: 'system', kind, sessionId: null, payload, urgency });
    } catch {
      // Health and lifecycle must never be able to crash the daemon reporting them.
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Recursive size of a directory tree, tolerant of files vanishing mid-scan. */
function dirSize(root) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else {
      try { total += fs.statSync(p).size; } catch { /* raced with rotation */ }
    }
  }
  return total;
}

/**
 * Default LLM reachability probe: a models list against the configured base URL.
 * Imported lazily so constructing a Daemon never pulls in provider config.
 */
async function defaultLlmProbe() {
  const { default: config } = await import('../config.js');
  const base = String(config.baseURL || '').replace(/\/+$/, '');
  if (!base) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(`${base}/models`, {
      method: 'GET',
      signal: controller.signal,
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
    });
    // Any HTTP answer means the endpoint is up; 401 is a credential problem,
    // not an outage, and reporting it as one sends the user to restart a
    // server that was never down.
    return res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ── OS autostart (3.1) ──────────────────────────────────────────────────────

/**
 * Generate the OS-specific autostart artifact for this platform.
 *
 * Generation only — nothing is installed or executed here. Registering a
 * background process that starts at login is exactly the kind of change that
 * should require an explicit, visible action by the user, so the CLI prints
 * the command and lets them run it.
 *
 * @returns {{platform: string, kind: string, path: string|null, content: string, command: string}}
 */
export function autostartArtifact({ execPath = process.execPath, script = null, brand = BRAND } = {}) {
  const entry = script || path.resolve(process.cwd(), 'src', 'kernel', 'daemonMain.js');
  const platform = process.platform;

  if (platform === 'win32') {
    // Task Scheduler: the only mechanism that survives logoff without a service
    // wrapper. -WindowStyle Hidden keeps it out of the way.
    const command =
      `schtasks /Create /TN "${brand}" /SC ONLOGON /RL LIMITED /F ` +
      `/TR "\\"${execPath}\\" \\"${entry}\\""`;
    return {
      platform, kind: 'schtasks', path: null,
      content: command,
      command,
    };
  }

  if (platform === 'darwin') {
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `com.${brand}.daemon.plist`);
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.${brand}.daemon</string>
  <key>ProgramArguments</key>
  <array><string>${execPath}</string><string>${entry}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(home(), 'logs', 'daemon.out.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(home(), 'logs', 'daemon.err.log')}</string>
</dict>
</plist>
`;
    return {
      platform, kind: 'launchd', path: plistPath, content,
      command: `launchctl load -w "${plistPath}"`,
    };
  }

  const unitPath = path.join(os.homedir(), '.config', 'systemd', 'user', `${brand}.service`);
  const content = `[Unit]
Description=${brand} presence daemon

[Service]
Type=simple
ExecStart=${execPath} ${entry}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
  return {
    platform, kind: 'systemd', path: unitPath, content,
    command: `systemctl --user enable --now ${brand}.service`,
  };
}

/** Write the autostart artifact to disk (still does not enable it). */
export function writeAutostartArtifact(artifact) {
  if (!artifact.path) return null;
  fs.mkdirSync(path.dirname(artifact.path), { recursive: true });
  fs.writeFileSync(artifact.path, artifact.content, 'utf-8');
  return artifact.path;
}
