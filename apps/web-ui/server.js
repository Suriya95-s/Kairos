#!/usr/bin/env node
// apps/web-ui/server.js
// Zero-dep SSE Live View server for Kairos HITL.
// Port: AGENT_HITL_WEB_PORT (default 5180)
// Serves static files from ./public/ and exposes:
//   GET  /          → public/index.html
//   GET  /events    → SSE stream of step + HITL events
//   GET  /api/pending   → JSON list of pending approval requests
//   POST /api/approve/:id → approve a request
//   POST /api/deny/:id   → deny a request  (body: { reason? })
//   POST /api/steer      → inject steering message (body: { message })
//   GET  /api/status → { paused, pendingCount }

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Per-session bearer token guarding every state-changing / data route. The agent
// can approve destructive HITL actions through this UI, so the control plane must
// not be open. Override with AGENT_HITL_WEB_TOKEN to share a stable token across
// restarts; otherwise a fresh random token is minted per process.
const AUTH_TOKEN = process.env.AGENT_HITL_WEB_TOKEN || crypto.randomBytes(24).toString('hex');

// Bind to loopback by default. Setting AGENT_HITL_WEB_HOST to a non-loopback
// address is an explicit opt-in to expose the control plane on the network.
const BIND_HOST = process.env.AGENT_HITL_WEB_HOST || '127.0.0.1';

/** Extract the presented token from the Authorization header or ?token= query. */
function presentedToken(req, url) {
  const auth = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m) return m[1].trim();
  return url.searchParams.get('token') || '';
}

/** Constant-time token comparison; returns true when the request is authorized. */
function isAuthorized(req, url) {
  const got = presentedToken(req, url);
  if (!got || got.length !== AUTH_TOKEN.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(AUTH_TOKEN));
  } catch { return false; }
}

// Workspace is passed as first CLI arg or from env
const workspace = process.argv[2] || process.env.AGENT_WORKSPACE || process.cwd();

// Dynamic imports from workspace's src/ — takes explicit ws path to avoid
// using the module-level `workspace` which may be stale when imported by cli.js
async function loadHitl(ws) {
  const srcBase = path.resolve(ws, 'src');
  const [config, aqMod, gwMod, steerMod, clarMod] = await Promise.all([
    import(path.join(srcBase, 'config.js')),
    import(path.join(srcBase, 'hitl', 'approvalQueue.js')),
    import(path.join(srcBase, 'hitl', 'gateway.js')),
    import(path.join(srcBase, 'hitl', 'steeringChannel.js')),
    import(path.join(srcBase, 'hitl', 'clarificationQueue.js')),
  ]);
  return {
    config: config.default,
    aq: aqMod,
    gw: gwMod,
    steer: steerMod,
    clar: clarMod,
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * Start the live-view SSE server in-process.
 * Call this from cli.js before running the loop so the SSE bus (gateway._sseListeners)
 * is shared in the same Node.js module instance.
 * @param {string} ws  - workspace directory
 * @param {number} [p] - port (default: AGENT_HITL_WEB_PORT or 5180)
 */
export async function startServer(ws, p) {
  // Override the module-level workspace so loadHitl() picks up the right path
  if (ws) Object.assign(globalThis, { _kairosWebUiWorkspace: ws });
  if (p)  Object.assign(globalThis, { _kairosWebUiPort: p });
  return start(ws, p);
}

async function start(wsOverride, portOverride) {
  const ws = wsOverride || workspace;

  const { config, aq, gw, steer, clar } = await loadHitl(ws);
  config._workspace = ws;

  const port = portOverride || config.hitlWebUiPort || 5180;
  const publicDir = path.join(__dirname, 'public');

  // Publish the session token to a loopback-local file so co-operating local
  // processes (the TUI, `agent` CLI) can authenticate to this server. Mode 0600,
  // under .agent/ (runtime state, gitignored). This is the same pattern Jupyter
  // uses for its token; it only ever needs to be readable by the same user.
  try {
    const tokenDir = path.join(ws, '.agent');
    fs.mkdirSync(tokenDir, { recursive: true });
    const tokenFile = path.join(tokenDir, 'web-ui-token');
    fs.writeFileSync(tokenFile, AUTH_TOKEN, { encoding: 'utf-8', mode: 0o600 });
    try { fs.chmodSync(tokenFile, 0o600); } catch { /* best-effort on non-POSIX */ }
  } catch (err) {
    console.error(`[live-view] could not write token file: ${err.message}`);
  }

  // SSE client registry
  const sseClients = new Set();
  gw.addSseListener(payload => {
    for (const res of sseClients) {
      try { res.write(`data: ${payload}\n\n`); } catch { sseClients.delete(res); }
    }
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const pathname = url.pathname;

    // ── Auth gate ──────────────────────────────────────────────
    // Every /events and /api/* route requires the session token. Static assets
    // (the loopback-served HTML) are public so the page can bootstrap and read
    // its token from the ?token= query.
    if (pathname === '/events' || pathname.startsWith('/api/')) {
      if (!isAuthorized(req, url)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"error":"unauthorized"}');
        return;
      }
    }

    // ── SSE /events ────────────────────────────────────────────
    if (pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(': connected\n\n');
      sseClients.add(res);

      // Heartbeat every 15s to prevent proxy timeouts
      const hb = setInterval(() => {
        try { res.write(': heartbeat\n\n'); } catch { clearInterval(hb); sseClients.delete(res); }
      }, 15000);

      req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
      return;
    }

    // ── API ────────────────────────────────────────────────────
    if (pathname === '/api/pending' && req.method === 'GET') {
      const pending = aq.listPending();
      const clarify = clar.getPendingClarifications();
      _json(res, { pending, clarify });
      return;
    }

    if (pathname === '/api/status' && req.method === 'GET') {
      _json(res, { paused: gw.isPaused(), pendingCount: aq.listPending().length, workspace: ws });
      return;
    }

    if (pathname.startsWith('/api/approve/') && req.method === 'POST') {
      const id = pathname.slice('/api/approve/'.length);
      _readBody(req, body => {
        const reason = (body?.reason || 'approved via web UI');
        aq.writeResponse(id, true, reason);
        gw.appendAudit({ type: 'approval_response', id, approved: true, reason, source: 'web-ui' });
        _json(res, { ok: true, id });
      });
      return;
    }

    if (pathname.startsWith('/api/deny/') && req.method === 'POST') {
      const id = pathname.slice('/api/deny/'.length);
      _readBody(req, body => {
        const reason = body?.reason || 'denied via web UI';
        aq.writeResponse(id, false, reason);
        gw.appendAudit({ type: 'approval_response', id, approved: false, reason, source: 'web-ui' });
        _json(res, { ok: true, id });
      });
      return;
    }

    if (pathname.startsWith('/api/clarify/') && req.method === 'POST') {
      const id = pathname.slice('/api/clarify/'.length);
      _readBody(req, body => {
        const answer = body?.answer || '';
        if (!answer) { res.writeHead(400); res.end('{"error":"answer required"}'); return; }
        clar.answerClarification(id, answer);
        gw.appendAudit({ type: 'clarification_answered', id, answer, source: 'tui' });
        _json(res, { ok: true, id });
      });
      return;
    }

    if (pathname === '/api/memory' && req.method === 'GET') {
      const sub = url.searchParams.get('sub') || 'status';
      const q = url.searchParams.get('q') || '';
      memoryReport(ws, sub, q).then(text => _json(res, { ok: true, sub, text }))
        .catch(err => _json(res, { ok: false, sub, text: `memory query failed: ${err.message}` }));
      return;
    }

    if (pathname === '/api/steer' && req.method === 'POST') {
      _readBody(req, body => {
        if (!body?.message) { res.writeHead(400); res.end('{"error":"message required"}'); return; }
        const id = steer.addSteeringMessage(body.message);
        _json(res, { ok: true, id });
      });
      return;
    }

    if (pathname === '/api/pause' && req.method === 'POST') {
      gw.pause();
      _json(res, { ok: true, paused: true });
      return;
    }

    if (pathname === '/api/resume' && req.method === 'POST') {
      gw.resume();
      _json(res, { ok: true, paused: false });
      return;
    }

    // ── Static files ───────────────────────────────────────────
    const rel = pathname === '/' ? '/index.html' : pathname;
    // Canonicalize then confine to publicDir (a denylist like .replace(/\.\./)
    // is bypassable; resolve + prefix check is not).
    const filePath = path.resolve(publicDir, '.' + rel);
    if (filePath !== publicDir && !filePath.startsWith(publicDir + path.sep)) {
      res.writeHead(403); res.end('Forbidden');
      return;
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(port, BIND_HOST, () => {
    const shownHost = BIND_HOST === '0.0.0.0' ? '127.0.0.1' : BIND_HOST;
    console.log(`Kairos Live View: http://${shownHost}:${port}/?token=${AUTH_TOKEN}  (workspace: ${ws})`);
    if (BIND_HOST !== '127.0.0.1' && BIND_HOST !== 'localhost') {
      console.log(`  ⚠ WARNING: bound to ${BIND_HOST} — the HITL control plane is reachable off-host. The session token is required, but treat the URL above as a secret.`);
    }
  });
}

// Build a memory-inspection report by reusing the SAME modules the CLI's
// `agent memory <sub>` subcommands call — so the TUI and CLI stay in sync.
async function memoryReport(ws, sub, q) {
  const srcBase = path.resolve(ws, 'src');
  const [{ default: config }, store, stateMod] = await Promise.all([
    import(path.join(srcBase, 'config.js')),
    import(path.join(srcBase, 'memory-store.js')),
    import(path.join(srcBase, 'state.js')),
  ]);
  stateMod.setWorkspace(ws);
  const exists = (p) => fs.existsSync(path.resolve(ws, p));

  if (sub === 'search') {
    if (!q) return 'Usage: /memory search <query>';
    return store.searchMemory(q, { maxResults: 25 });
  }
  if (sub === 'semantic') {
    if (!q) return 'Usage: /memory semantic <query>';
    // Embedding-ranked recall over daily logs; falls back to lexical when no
    // embedding endpoint is reachable.
    return store.semanticSearchMemory(q, { maxResults: 15 });
  }
  if (sub === 'recent') {
    const n = parseInt(q || '10', 10);
    return store.getRecentMemories(Number.isFinite(n) ? n : 10) || 'No recent memories recorded yet.';
  }
  if (sub === 'session') {
    if (!q) return 'Usage: /memory session <session-id>';
    const sess = await import(path.join(srcBase, 'chat', 'session.js'));
    return sess.summarizeSession(q);
  }
  if (sub === 'palace') {
    const db = config.palaceDbFile;
    return [
      '=== Memory Palace (CEI) Status ===',
      `Enabled:    ${process.env.AGENT_USE_PALACE === '1' ? 'yes' : 'no (set AGENT_USE_PALACE=1)'}`,
      `DB path:    ${db}`,
      `DB exists:  ${exists(db) ? 'yes' : 'no'}`,
      `WAL exists: ${exists(db + '-wal') ? 'yes (active writes)' : 'no'}`,
    ].join('\n');
  }
  if (sub === 'lmma') {
    const route = config.lmmaActiveRouteFile;
    const wm = config.lmmaWorkingMemoryFile;
    return [
      '=== LMMA Memory Status ===',
      `LMMA dir:       ${config.lmmaDir} (${exists(config.lmmaDir) ? 'exists' : 'absent'})`,
      `Active route:   ${exists(route) ? fs.readFileSync(path.resolve(ws, route), 'utf-8').slice(0, 400) : 'absent'}`,
      `Working memory: ${exists(wm) ? fs.readFileSync(path.resolve(ws, wm), 'utf-8').slice(0, 400) : 'absent'}`,
    ].join('\n');
  }
  // default: status
  return [
    '=== Kairos Memory Status ===',
    `Workspace:      ${ws}`,
    store.getMemorySummary(),
    `Memory Palace:  ${process.env.AGENT_USE_PALACE === '1' ? 'enabled' : 'disabled'} (${exists(config.palaceDbFile) ? 'db present' : 'no db'})`,
    `LMMA:           ${exists(config.lmmaActiveRouteFile) ? 'active route exists' : 'no active route'}`,
    `MEMORY.md:      ${exists(config.memoryFile) ? 'present' : 'absent'}`,
    '',
    'Layers: MEMORY.md (curated) · .agent/memory (daily logs) · .agent/lmma (routing) · .agent/palace (episodic CEI)',
    '',
    'Sub-commands: /memory status | recent [N] | search <q> | semantic <q> | session <id> | palace | lmma',
  ].join('\n');
}

function _json(res, data) {
  const body = JSON.stringify(data);
  // No CORS header: the control plane is same-origin only. Cross-origin pages
  // must not be able to read approvals/steering state.
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(body);
}

const MAX_BODY_BYTES = 256 * 1024;
function _readBody(req, cb) {
  let raw = '';
  let aborted = false;
  req.on('data', c => {
    if (aborted) return;
    raw += c;
    if (raw.length > MAX_BODY_BYTES) {
      aborted = true;
      try { req.destroy(); } catch {}
      cb({});
    }
  });
  req.on('end', () => {
    if (aborted) return;
    try { cb(JSON.parse(raw)); } catch { cb({}); }
  });
}

// Only auto-start when run directly (node server.js), not when imported by cli.js
import { fileURLToPath as _ftu } from 'node:url';
if (process.argv[1] === _ftu(import.meta.url)) {
  start().catch(err => { console.error('web-ui failed to start:', err.message); process.exit(1); });
}
