// src/kernel/server.js
// The daemon's client protocol (3.5): loopback HTTP + SSE.
//
// This is a control plane. Through it a client can start missions, stop them,
// and (from P7) approve real-world actions — so it is bound to loopback and
// every route requires a bearer token, exactly like the existing web-ui server.
// The token lives in a 0600 file under the daemon home; co-operating local
// processes read it, and nothing else can.
//
// SSE rather than websockets: the repo already has 16 SSE event types and a TUI
// that speaks them, the traffic is one-directional, and it survives a proxy.
// Reconnection is exact rather than lossy — a client passes the last event id
// it saw and the journal replays the gap.

import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';

import { BRAND, ensureHome, PORT_FILE, TOKEN_FILE } from './paths.js';
import { WEB_CLIENT_HTML } from './webclient.js';

const DEFAULT_PORT = parseInt(process.env.KAIROS_DAEMON_PORT || '5181', 10);
const BIND_HOST = process.env.KAIROS_DAEMON_HOST || '127.0.0.1';
const MAX_BODY_BYTES = 256 * 1024;

export class DaemonServer {
  /**
   * @param {object} opts
   * @param {object} opts.daemon   the Daemon instance this exposes
   * @param {number} [opts.port]   0 → ephemeral
   * @param {string} [opts.token]  override the generated session token
   */
  constructor({ daemon, port = DEFAULT_PORT, host = BIND_HOST, token = null } = {}) {
    if (!daemon) throw new Error('DaemonServer requires a daemon');
    this.daemon = daemon;
    this.bus = daemon.bus;
    this._port = port;
    this._host = host;
    this.token = token || process.env.KAIROS_DAEMON_TOKEN || crypto.randomBytes(24).toString('hex');
    this._server = null;
    this._sseClients = new Set();
    this._unsubscribe = null;
  }

  get port() {
    const addr = this._server?.address();
    return addr && typeof addr === 'object' ? addr.port : this._port;
  }

  /** Start listening. Falls back to an ephemeral port when the default is taken. */
  async listen() {
    ensureHome();
    this._server = http.createServer((req, res) => this._handle(req, res));

    // One bus subscription fans out to every connected client; N clients must
    // not mean N subscriptions to clean up.
    this._unsubscribe = this.bus.subscribe('*', (evt) => this._broadcast(evt));

    await new Promise((resolve, reject) => {
      const onError = (err) => {
        if (err.code === 'EADDRINUSE' && this._port !== 0) {
          // Another process has 5181. An ephemeral port still works because
          // clients discover the real one from the port file.
          this._port = 0;
          this._server.listen(0, this._host);
          return;
        }
        reject(err);
      };
      this._server.on('error', onError);
      this._server.listen(this._port, this._host, () => {
        this._server.off('error', onError);
        resolve();
      });
    });

    this._writeDiscoveryFiles();
    return { port: this.port, host: this._host, token: this.token };
  }

  /**
   * Publish the port and token so local clients can find and authenticate to
   * the daemon. Mode 0600 — the same pattern Jupyter uses.
   */
  _writeDiscoveryFiles() {
    fs.writeFileSync(PORT_FILE(), String(this.port), { encoding: 'utf-8', mode: 0o600 });
    fs.writeFileSync(TOKEN_FILE(), this.token, { encoding: 'utf-8', mode: 0o600 });
    // chmod again explicitly: the mode argument is only applied at creation, so
    // an existing file from a previous run would keep its old permissions.
    for (const f of [PORT_FILE(), TOKEN_FILE()]) {
      try { fs.chmodSync(f, 0o600); } catch { /* non-POSIX */ }
    }
  }

  async close() {
    if (this._unsubscribe) { this._unsubscribe(); this._unsubscribe = null; }
    for (const res of this._sseClients) { try { res.end(); } catch { /* already gone */ } }
    this._sseClients.clear();
    if (this._server) {
      await new Promise(resolve => this._server.close(resolve));
      this._server = null;
    }
    for (const f of [PORT_FILE(), TOKEN_FILE()]) {
      try { fs.rmSync(f); } catch { /* already gone */ }
    }
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  _authorized(req, url) {
    const auth = req.headers['authorization'] || '';
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    const got = m ? m[1].trim() : (url.searchParams.get('token') || '');
    if (!got || got.length !== this.token.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(this.token));
    } catch {
      return false;
    }
  }

  // ── Routing ───────────────────────────────────────────────────────────────

  _handle(req, res) {
    const url = new URL(req.url, `http://${this._host}`);
    const p = url.pathname;

    // The HTML shell is the one unauthenticated route, and only on loopback.
    // A browser cannot send an Authorization header for its first navigation,
    // so the page has to load before it can read `?token=` and authenticate
    // everything after. The shell itself contains no secrets and no data — it
    // is a static string, and every API call it makes is gated below.
    if (p === '/' && req.method === 'GET') return this._serveClient(res);

    if (!this._authorized(req, url)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"error":"unauthorized"}');
      return;
    }

    try {
      if (p === '/events' && req.method === 'GET') return this._sse(req, res, url);
      if (p === '/api/status' && req.method === 'GET') return json(res, this.daemon.status());
      if (p === '/api/health' && req.method === 'GET') {
        return json(res, { health: this.daemon.health, reason: this.daemon.healthReason });
      }
      if (p === '/api/logs' && req.method === 'GET') {
        const limit = parseInt(url.searchParams.get('limit') || '100', 10);
        const kinds = url.searchParams.get('kinds')?.split(',').filter(Boolean) || null;
        const sessionId = url.searchParams.get('sessionId') || null;
        return json(res, { events: this.bus.replay({ limit, kinds, sessionId }) });
      }

      // ── Sessions ────────────────────────────────────────────
      if (p === '/api/sessions' && req.method === 'GET') {
        return json(res, { sessions: this.daemon.sessions.list() });
      }
      if (p === '/api/sessions' && req.method === 'POST') {
        return readBody(req, (body) => {
          const s = this.daemon.sessions.create({
            workspace: body.workspace || null,
            clientKind: body.clientKind || 'cli',
            title: body.title || null,
          });
          json(res, { session: s });
        });
      }
      const sessMatch = /^\/api\/sessions\/([^/]+)$/.exec(p);
      if (sessMatch && req.method === 'DELETE') {
        const s = this.daemon.sessions.close(sessMatch[1]);
        return json(res, { session: s });
      }

      // ── Missions ────────────────────────────────────────────
      if (p === '/api/missions' && req.method === 'GET') {
        const state = url.searchParams.get('state') || null;
        return json(res, { missions: this.daemon.missions.list({ state }) });
      }
      if (p === '/api/missions' && req.method === 'POST') {
        return readBody(req, (body) => {
          if (!body.task)      return json(res, { error: 'task is required' }, 400);
          if (!body.workspace) return json(res, { error: 'workspace is required' }, 400);
          const m = this.daemon.missions.submit({
            task: body.task,
            workspace: body.workspace,
            sessionId: body.sessionId || 'system',
            profile: body.profile || null,
            model: body.model || null,
            maxSteps: body.maxSteps || null,
          });
          json(res, { mission: m });
        });
      }
      const missMatch = /^\/api\/missions\/([^/]+)(?:\/(stop|cancel|resume))?$/.exec(p);
      if (missMatch) {
        const [, id, verb] = missMatch;
        if (!verb && req.method === 'GET') {
          const m = this.daemon.missions.get(id);
          return m ? json(res, { mission: m }) : json(res, { error: 'unknown mission' }, 404);
        }
        if (verb && req.method === 'POST') {
          const m = this.daemon.missions[verb](id);
          return m ? json(res, { mission: m }) : json(res, { error: 'unknown mission' }, 404);
        }
      }

      // ── Say — routed by the cognition router (4.1–4.4) ────────
      if (p === '/api/say' && req.method === 'POST') {
        return readBody(req, (body) => {
          if (!body.text) return json(res, { error: 'text is required' }, 400);
          this._say(body).then(out => json(res, out)).catch(err => json(res, { error: err.message }, 500));
        });
      }

      // ── Voice telemetry (8.x → TUI Voice view) ────────────────
      // The voice loop runs in its own process; this is how what it hears
      // reaches every attached surface. Fire-and-forget by design — a voice
      // event is telemetry, and telemetry must never block the microphone.
      if (p === '/api/voice' && req.method === 'POST') {
        return readBody(req, (body) => {
          json(res, { ok: this.daemon.noteVoice(body || {}) });
        });
      }

      // ── Approvals — the same queue the TUI and CLI write to ──
      // One queue, several front doors. A second approval path could diverge
      // from the first, and then two surfaces disagree about what was allowed.
      const apprMatch = /^\/api\/(approve|deny)\/(.+)$/.exec(p);
      if (apprMatch && req.method === 'POST') {
        const [, verb, id] = apprMatch;
        return readBody(req, (body) => {
          this._respondToApproval(verb, decodeURIComponent(id), body?.reason)
            .then(out => json(res, out))
            .catch(err => json(res, { error: err.message }, 500));
        });
      }
      if (p === '/api/pending' && req.method === 'GET') {
        return this._listPending()
          .then(pending => json(res, { pending }))
          .catch(err => json(res, { error: err.message }, 500));
      }

      // 9.4 — produce the self-report on demand rather than waiting a week.
      if (p === '/api/report' && req.method === 'POST') {
        return readBody(req, (body) => {
          this.daemon.selfReport({ periodMs: body?.periodMs || undefined })
            .then(r => json(res, { text: r.text, current: r.current, regressions: r.regressions }))
            .catch(err => json(res, { error: err.message }, 500));
        });
      }

      if (p === '/api/stop' && req.method === 'POST') {
        // Answer before draining: shutdown can take as long as the slowest
        // mission's current step, and a client waiting on a socket that the
        // shutdown itself will close would just time out.
        json(res, { ok: true, stopping: true });
        setImmediate(() => this.daemon.stop().catch(() => {}));
        return;
      }

      json(res, { error: 'not found', path: p }, 404);
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
  }

  /** Serve the self-contained web client (8.4). */
  _serveClient(res) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // The page runs only its own inline script and talks only to its own
      // origin. Worth stating explicitly on a page that can approve
      // irreversible actions.
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(WEB_CLIENT_HTML);
  }

  /**
   * Answer a pending approval.
   *
   * Routed through the mission's OWN workspace: the approval queue is files
   * under `<workspace>/.agent/hitl/`, and the daemon's context points somewhere
   * else entirely. Writing from here without scoping would drop the answer into
   * the wrong directory and the waiting mission would time out — which means
   * deny. The same class of bug as the P4 steering misdelivery.
   */
  async _respondToApproval(verb, id, reason) {
    const approved = verb === 'approve';
    const { AgentContext, runWithContext } = await import('../runtime/context.js');
    const { writeResponse } = await import('../hitl/approvalQueue.js');
    const { appendAudit } = await import('../hitl/gateway.js');

    const workspaces = new Set(
      this.daemon.missions.list()
        .filter(m => ['running', 'starting', 'stopping'].includes(m.state))
        .map(m => m.workspace),
    );
    if (!workspaces.size) return { ok: false, error: 'no running mission is waiting for an answer' };

    // The id is unique across workspaces, so answering in each is safe: at most
    // one has a matching request and the rest are no-ops. Searching first would
    // race the mission's own poll.
    let delivered = 0;
    for (const workspace of workspaces) {
      const ctx = new AgentContext({ workspace });
      try {
        runWithContext(ctx, () => {
          writeResponse(id, approved, reason || `${verb}d via the web client`);
          appendAudit({ type: 'approval_response', id, approved, reason, source: 'web-client' });
        });
        delivered++;
      } catch { /* not this workspace */ } finally {
        try { ctx.dispose(); } catch { /* nothing held */ }
      }
    }
    return { ok: delivered > 0, id, approved, workspaces: delivered };
  }

  /** Pending approvals across every running mission's workspace. */
  async _listPending() {
    const { AgentContext, runWithContext } = await import('../runtime/context.js');
    const { listPending } = await import('../hitl/approvalQueue.js');
    const out = [];
    for (const m of this.daemon.missions.list()) {
      if (!['running', 'starting', 'stopping'].includes(m.state)) continue;
      const ctx = new AgentContext({ workspace: m.workspace });
      try {
        for (const r of runWithContext(ctx, () => listPending())) out.push({ ...r, missionId: m.id });
      } catch { /* workspace gone */ } finally {
        try { ctx.dispose(); } catch { /* nothing held */ }
      }
    }
    return out;
  }

  /**
   * Handle one utterance: put it on the bus, then let the router decide what
   * it is (4.1) and the dispatcher decide what to do about it (4.4).
   *
   * The bus publish happens FIRST and unconditionally. Whatever the router
   * concludes — including "I don't understand" — the fact that the user said
   * something is history, and history should not depend on comprehension.
   */
  async _say(body) {
    const sessionId = body.sessionId
      || this.daemon.sessions.create({ workspace: body.workspace || null, clientKind: body.clientKind || 'cli' }).id;

    const session = this.daemon.sessions.get(sessionId);
    const workspace = body.workspace || session?.workspace || null;

    this.bus.publish({
      source: body.source || 'user.cli',
      kind: 'utterance',
      sessionId,
      payload: { text: body.text, workspace },
      urgency: 'now',
    });

    // Missions this utterance could plausibly be about: ones this session
    // started, AND ones already running in this workspace whoever started them.
    // Keying on the session alone means a `say` from a second terminal reads as
    // "nothing is running" and starts a rival mission that then queues behind
    // the first — the user asked for a change and got a twenty-minute wait.
    const active = ['running', 'starting', 'queued'];
    const running = this.daemon.missions.list()
      .filter(m => active.includes(m.state))
      .filter(m => m.sessionId === sessionId || (workspace && m.workspace === workspace));

    const { dispatch } = await import('../router/dispatch.js');
    const { getConversation } = await import('../chat/conversation.js');
    const { getMemoryService } = await import('../memoryd/service.js');

    const out = await dispatch(body.text, {
      sessionId,
      workspace,
      runningMissions: running,
      conversation: getConversation(),
      memory: getMemoryService(),
      // The daemon opts into the model fallback: for a genuinely ambiguous
      // utterance, 200ms to find out beats answering "can you say more?".
      useLlmClassifier: this.daemon.health === 'healthy',
      // Tell the dispatcher what the kernel already knows, so a reflex during
      // an outage answers instantly instead of paying the retry backoff.
      degraded: this.daemon.health === 'degraded_llm' ? this.daemon.healthReason
        : this.daemon.health === 'budget_hold' ? this.daemon.healthReason
        : null,
      autoStart: body.autoStart === true,
      startMission: async ({ task, profile }) => this.daemon.missions.submit({
        task, workspace, sessionId, profile: body.profile || profile || null,
      }),
      controlMission: async (action, missionId) => {
        if (action === 'stop')   return this.daemon.missions.stop(missionId, { reason: 'stopped by the user' });
        if (action === 'pause')  return this.daemon.missions.pause(missionId);
        if (action === 'resume') return this.daemon.missions.unpause(missionId);
        return null;
      },
      steerMission: async (missionId, message) => this.daemon.missions.steer(missionId, message),
      // G3: "ask <domain> …" answers from the ontology graph — traversal
      // retrieves, the model (when healthy) narrates with [cite:] grounding,
      // and the deterministic facts answer when it can't. Receipts on the bus.
      askGraph: async (domain, question) => {
        try {
          const { listDomains } = await import('../ontology/store.js');
          if (!listDomains().includes(domain)) return null; // not a graph ask — fall through
          const { answerQuestion } = await import('../ontology/query.js');
          let llm = null;
          if (this.daemon.health === 'healthy') {
            const { chatCompletion } = await import('../llm.js');
            llm = async (messages) => (await chatCompletion(messages, { temperature: 0, purpose: 'ontology.ask' })).content;
          }
          const res = await answerQuestion(domain, question, { llm });
          // The receipt rides its own try: a bus hiccup must never discard a
          // computed answer. (And 'system' is the registered source — the
          // event SOURCES list is closed, like the kinds list right below it.)
          try {
            this.bus.publish({
              source: 'system', kind: 'ontology', sessionId, urgency: 'whenever',
              payload: {
                action: 'graph_answer', domain, question: question.slice(0, 200),
                plan: res.plan?.id || null, nodes: res.plan?.nodes || 0,
                grounded: !!res.grounded, cites: (res.cites || []).length,
                ...(res.floor ? { floor: res.floor } : {}),
              },
            });
          } catch { /* answer still returns */ }
          return res;
        } catch {
          return null; // graph trouble must not eat the utterance — normal path answers
        }
      },
    });

    return {
      sessionId,
      action: out.action,
      text: out.text,
      mission: out.mission ?? null,
      proposal: out.proposal ?? null,
      intent: out.decision?.intent ?? null,
      // G3: when the graph plane answered, say so — plan id, grounding, cites.
      graph: out.graph ?? null,
      // Retained for older clients that only checked `accepted`.
      accepted: out.action !== 'clarify',
    };
  }

  // ── SSE ───────────────────────────────────────────────────────────────────

  _sse(req, res, url) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`: connected to ${BRAND}\n\n`);

    // Exact catch-up. A client reconnecting after a dropped socket sends the
    // last id it processed and gets precisely the gap — no duplicates to
    // de-dupe client-side, no silently missed mission completion.
    const after = req.headers['last-event-id'] || url.searchParams.get('after');
    if (after) {
      for (const evt of this.bus.replay({ afterId: after })) writeEvent(res, evt);
    }

    this._sseClients.add(res);
    const hb = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch { cleanup(); }
    }, 15_000);
    if (typeof hb.unref === 'function') hb.unref();

    const cleanup = () => {
      clearInterval(hb);
      this._sseClients.delete(res);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
  }

  _broadcast(evt) {
    for (const res of [...this._sseClients]) {
      try {
        writeEvent(res, evt);
      } catch {
        this._sseClients.delete(res);
      }
    }
  }

  /** Number of attached SSE clients — surfaced in status for debugging. */
  get clientCount() { return this._sseClients.size; }
}

function writeEvent(res, evt) {
  res.write(`id: ${evt.id}\nevent: ${evt.kind}\ndata: ${JSON.stringify(evt)}\n\n`);
}

function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  // No CORS header by design: a page on another origin must not be able to
  // read mission state or start work.
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function readBody(req, cb) {
  let raw = '';
  let aborted = false;
  req.on('data', (chunk) => {
    if (aborted) return;
    raw += chunk;
    if (raw.length > MAX_BODY_BYTES) {
      aborted = true;
      try { req.destroy(); } catch { /* already destroyed */ }
      cb({});
    }
  });
  req.on('end', () => {
    if (aborted) return;
    try { cb(raw ? JSON.parse(raw) : {}); } catch { cb({}); }
  });
}
