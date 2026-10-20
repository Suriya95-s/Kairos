// src/mcp/client.js
// MCP transport layer — JSON-RPC 2.0 over stdio or HTTP/SSE.
// Zero external dependencies; uses Node built-ins only.
//
// Protocol reference: https://spec.modelcontextprotocol.io/specification/
// Both transports expose the same async API so callers are transport-agnostic.

import { spawn }       from 'node:child_process';
import { EventEmitter } from 'node:events';
import http            from 'node:http';
import https           from 'node:https';
import config          from '../config.js';

let _nextId = 1;
function nextId() { return _nextId++; }

// ── Base client ────────────────────────────────────────────────────────────────

class McpClientBase extends EventEmitter {
  constructor(name) {
    super();
    this.name    = name;
    this._pending = new Map(); // id → { resolve, reject, timer }
  }

  _dispatch(message) {
    if (message.id !== undefined && this._pending.has(message.id)) {
      const { resolve, reject, timer } = this._pending.get(message.id);
      clearTimeout(timer);
      this._pending.delete(message.id);
      if (message.error) {
        reject(Object.assign(new Error(message.error.message || 'MCP error'), { code: message.error.code }));
      } else {
        resolve(message.result);
      }
    } else if (message.method) {
      // Server-sent notification — emit for optional listeners
      this.emit('notification', message);
    }
  }

  async _call(method, params = {}, timeoutMs = config.mcpCallTimeoutMs) {
    const id = nextId();
    const msg = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`MCP call timed out: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      try {
        this._send(msg);
      } catch (err) {
        // Sync _send failure (e.g. not connected) — don't leak the timer/pending entry.
        clearTimeout(timer);
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  // ── Public API (same for all transports) ──────────────────────────────────

  async initialize() {
    return this._call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {}, resources: { subscribe: false }, prompts: {} },
      clientInfo: { name: 'kairos', version: '3.0.0-dev' },
    }, config.mcpConnectTimeoutMs);
  }

  async listTools() {
    const res = await this._call('tools/list');
    return res?.tools ?? [];
  }

  async callTool(name, args = {}) {
    return this._call('tools/call', { name, arguments: args });
  }

  async listResources() {
    const res = await this._call('resources/list');
    return res?.resources ?? [];
  }

  async readResource(uri) {
    return this._call('resources/read', { uri });
  }

  async listPrompts() {
    const res = await this._call('prompts/list');
    return res?.prompts ?? [];
  }

  async getPrompt(name, args = {}) {
    return this._call('prompts/get', { name, arguments: args });
  }

  async ping() {
    try {
      await this._call('ping', {}, 5000);
      return true;
    } catch {
      return false;
    }
  }
}

// ── Stdio transport ────────────────────────────────────────────────────────────

export class McpStdioClient extends McpClientBase {
  constructor(name, command, args = [], env = {}) {
    super(name);
    this._command = command;
    this._args    = args;
    this._env     = env;
    this._proc    = null;
    this._buf     = '';
  }

  async connect() {
    this._proc = spawn(this._command, this._args, {
      env: { ...process.env, ...this._env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // A bad `command` in mcp-servers.json makes spawn emit 'error' (e.g. ENOENT)
    // asynchronously. Without a listener that's an UNCAUGHT error event — it
    // crashes the whole agent. Capture it, fail any in-flight requests (incl. the
    // initialize() call below so connect() rejects instead of hanging), and
    // surface it to the connection manager via the 'error' event.
    this._proc.on('error', (err) => {
      this._spawnError = err;
      for (const { reject, timer } of this._pending.values()) {
        clearTimeout(timer);
        reject(new Error(`MCP stdio [${this.name}] spawn failed: ${err.message}`));
      }
      this._pending.clear();
      this.emit('error', err);
    });

    this._proc.stdout.setEncoding('utf-8');
    this._proc.stdout.on('data', (chunk) => {
      this._buf += chunk;
      const lines = this._buf.split('\n');
      this._buf = lines.pop(); // keep incomplete last line
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { this._dispatch(JSON.parse(trimmed)); } catch { /* skip malformed */ }
      }
    });

    this._proc.stderr.on('data', (d) => this.emit('stderr', String(d)));
    this._proc.on('exit', (code) => {
      // Fail any queued requests immediately instead of letting each hit its full
      // call timeout when the server dies mid-flight.
      for (const { reject, timer } of this._pending.values()) {
        clearTimeout(timer);
        reject(new Error(`MCP stdio [${this.name}] exited (code ${code}) with request in flight`));
      }
      this._pending.clear();
      this.emit('exit', code);
    });

    await this.initialize();
    return this;
  }

  _send(msg) {
    if (!this._proc?.stdin?.writable) throw new Error(`MCP stdio [${this.name}]: not connected`);
    this._proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  disconnect() {
    this._proc?.stdin?.end();
    this._proc?.kill();
    this._proc = null;
    for (const { reject, timer } of this._pending.values()) {
      clearTimeout(timer);
      reject(new Error('MCP client disconnected'));
    }
    this._pending.clear();
  }

  get connected() { return !!this._proc && !this._proc.killed; }
}

// ── HTTP / SSE transport ───────────────────────────────────────────────────────

export class McpHttpClient extends McpClientBase {
  constructor(name, baseUrl, headers = {}) {
    super(name);
    this._baseUrl  = baseUrl.replace(/\/$/, '');
    this._headers  = headers;
    this._sseReq   = null;
    this._sseBuf   = '';
    // Wave D-5: POST endpoint announced by the server's SSE `endpoint` event.
    // Falls back to `<baseUrl>/message` when the server doesn't announce one.
    this._messageEndpoint = null;
    this.connected = false;
  }

  async connect() {
    await this._openSse();
    await this.initialize();
    this.connected = true;
    return this;
  }

  _openSse() {
    return new Promise((resolve, reject) => {
      const url  = new URL(`${this._baseUrl}/sse`);
      const lib  = url.protocol === 'https:' ? https : http;
      const opts = {
        hostname: url.hostname,
        port:     url.port || (url.protocol === 'https:' ? 443 : 80),
        path:     url.pathname + url.search,
        method:   'GET',
        headers:  { Accept: 'text/event-stream', ...this._headers },
      };
      this._sseReq = lib.request(opts, (res) => {
        res.setEncoding('utf-8');
        res.on('data', (chunk) => {
          this._sseBuf += chunk;
          const events = this._sseBuf.split('\n\n');
          this._sseBuf = events.pop();
          for (const ev of events) this._handleSseEvent(ev);
        });
        // Wave D-5: detect a mid-session stream close/error and flag the connection
        // so the connection manager schedules a reconnect. Previously only the
        // pre-connect error was caught, so a dropped stream went unnoticed.
        const onClose = () => {
          if (!this.connected) return; // pre-connect failures handled by reject()
          this.connected = false;
          this.emit('exit');
        };
        res.on('end', onClose);
        res.on('close', onClose);
        res.on('error', (e) => { this.emit('error', e); onClose(); });
        resolve();
      });
      this._sseReq.on('error', (e) => {
        // Before connect → reject the connect promise; after → surface + reconnect.
        if (this.connected) { this.emit('error', e); this.emit('exit'); }
        else reject(e);
      });
      this._sseReq.end();
    });
  }

  /**
   * Parse one SSE event block (lines separated by \n, events by \n\n).
   * Honors the MCP `endpoint` event (announces the POST URL) in addition to the
   * default `message` events carrying JSON-RPC payloads.
   */
  _handleSseEvent(ev) {
    let eventType = 'message';
    const dataLines = [];
    for (const line of ev.split('\n')) {
      if (line.startsWith('event:')) eventType = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return;
    const data = dataLines.join('\n');
    if (eventType === 'endpoint') {
      this._messageEndpoint = this._resolveEndpoint(data);
      return;
    }
    try { this._dispatch(JSON.parse(data)); } catch { /* skip non-JSON keep-alives */ }
  }

  /** Resolve an announced endpoint (absolute URL or base-relative path). */
  _resolveEndpoint(raw) {
    try { return new URL(raw, `${this._baseUrl}/`).toString(); }
    catch { return null; }
  }

  _send(msg) {
    const body   = JSON.stringify(msg);
    // Wave D-5: prefer the server-announced endpoint when present.
    const url    = new URL(this._messageEndpoint || `${this._baseUrl}/message`);
    const lib    = url.protocol === 'https:' ? https : http;
    const opts   = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...this._headers,
      },
    };
    const req = lib.request(opts);
    req.on('error', (e) => this.emit('error', e));
    req.write(body);
    req.end();
  }

  disconnect() {
    this._sseReq?.destroy();
    this._sseReq = null;
    this.connected = false;
    for (const { reject, timer } of this._pending.values()) {
      clearTimeout(timer);
      reject(new Error('MCP HTTP client disconnected'));
    }
    this._pending.clear();
  }
}

// ── Factory ────────────────────────────────────────────────────────────────────

/**
 * Create and connect an MCP client from a server config entry.
 * @param {string} name - Server name (used for tool prefixing)
 * @param {{ transport: 'stdio'|'http', command?: string, args?: string[], env?: object, url?: string, headers?: object }} serverCfg
 * @returns {Promise<McpStdioClient|McpHttpClient>}
 */
export async function createMcpClient(name, serverCfg) {
  if (serverCfg.transport === 'http' || serverCfg.transport === 'sse') {
    const client = new McpHttpClient(name, serverCfg.url, serverCfg.headers ?? {});
    await client.connect();
    return client;
  }
  // default: stdio
  const client = new McpStdioClient(name, serverCfg.command, serverCfg.args ?? [], serverCfg.env ?? {});
  await client.connect();
  return client;
}
