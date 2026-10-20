// src/kernel/client.js
// Talking to a running daemon from another process (the CLI, the TUI).
//
// Discovery is by file, not by convention: the daemon writes its real port and
// token into ~/.<brand>/run/ at 0600. That means the port can be ephemeral when
// the default is taken, and no client ever has to guess.

import fs from 'node:fs';

import { BRAND, PORT_FILE, TOKEN_FILE, PID_FILE } from './paths.js';

/** Read the daemon's connection details, or null when it isn't running. */
export function discover() {
  try {
    const port = parseInt(fs.readFileSync(PORT_FILE(), 'utf-8').trim(), 10);
    const token = fs.readFileSync(TOKEN_FILE(), 'utf-8').trim();
    if (!Number.isInteger(port) || !token) return null;
    return { port, token, host: process.env.KAIROS_DAEMON_HOST || '127.0.0.1' };
  } catch {
    return null;
  }
}

/** PID of the running daemon, or null. Distinguishes "stale files" from "up". */
export function daemonPid() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE(), 'utf-8').trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);
    return pid;
  } catch (err) {
    return err?.code === 'EPERM' ? null : null;
  }
}

export class DaemonClient {
  constructor(conn = null) {
    this.conn = conn || discover();
  }

  get available() { return !!this.conn; }

  _url(pathname, params = {}) {
    const u = new URL(`http://${this.conn.host}:${this.conn.port}${pathname}`);
    for (const [k, v] of Object.entries(params)) {
      if (v != null && v !== '') u.searchParams.set(k, String(v));
    }
    return u;
  }

  async request(method, pathname, { body = null, params = {}, timeoutMs = 15_000 } = {}) {
    if (!this.conn) {
      throw new Error(`${BRAND} is not running — start it with "${BRAND} start"`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(this._url(pathname, params), {
        method,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.conn.token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
      if (!res.ok) {
        const err = new Error(data.error || `HTTP ${res.status}`);
        err.status = res.status;
        err.data = data;
        throw err;
      }
      return data;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error(`${BRAND} did not respond within ${timeoutMs}ms`);
      if (err.cause?.code === 'ECONNREFUSED') {
        throw new Error(`${BRAND} is not accepting connections (stale run files?) — try "${BRAND} start"`);
      }
      throw err;
    }
  }

  status()               { return this.request('GET',  '/api/status'); }
  health()               { return this.request('GET',  '/api/health'); }
  sessions()             { return this.request('GET',  '/api/sessions'); }
  createSession(body)    { return this.request('POST', '/api/sessions', { body }); }
  closeSession(id)       { return this.request('DELETE', `/api/sessions/${encodeURIComponent(id)}`); }
  missions(params = {})  { return this.request('GET',  '/api/missions', { params }); }
  mission(id)            { return this.request('GET',  `/api/missions/${encodeURIComponent(id)}`); }
  submitMission(body)    { return this.request('POST', '/api/missions', { body }); }
  stopMission(id)        { return this.request('POST', `/api/missions/${encodeURIComponent(id)}/stop`); }
  cancelMission(id)      { return this.request('POST', `/api/missions/${encodeURIComponent(id)}/cancel`); }
  resumeMission(id)      { return this.request('POST', `/api/missions/${encodeURIComponent(id)}/resume`); }
  say(body)              { return this.request('POST', '/api/say', { body }); }
  logs(params = {})      { return this.request('GET',  '/api/logs', { params }); }
  shutdown()             { return this.request('POST', '/api/stop'); }

  /**
   * Stream events. Yields parsed events until the caller breaks or the daemon
   * closes the stream.
   * @param {object} [opts]
   * @param {string} [opts.after]  last event id already seen — exact catch-up
   */
  async *stream({ after = null, signal = null } = {}) {
    if (!this.conn) throw new Error(`${BRAND} is not running`);
    const res = await fetch(this._url('/events', { after }), {
      headers: { Authorization: `Bearer ${this.conn.token}` },
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`event stream failed: HTTP ${res.status}`);

    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      // SSE frames are separated by a blank line; a chunk boundary can split one
      // mid-frame, so only complete frames are parsed and the tail is kept.
      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLine = frame.split('\n').find(l => l.startsWith('data: '));
        if (!dataLine) continue; // comment frame: ": heartbeat"
        try { yield JSON.parse(dataLine.slice(6)); } catch { /* skip malformed */ }
      }
    }
  }
}
