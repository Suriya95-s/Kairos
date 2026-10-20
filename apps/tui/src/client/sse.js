// src/client/sse.js — SSE subscription with auto-reconnect

import http from 'node:http';

// Translate a low-level connection error into an actionable, human diagnostic.
function diagnose(err, port) {
  const code = err?.code || '';
  if (code === 'ECONNREFUSED') {
    return `No Kairos agent on port ${port}. Start one (type a task or /run <task>). On WSL2, ensure the agent and TUI share the same host.`;
  }
  if (code === 'EADDRINUSE') {
    return `Port ${port} is already in use by another process. Change the port in Settings (,) or free it, then [R] reconnect.`;
  }
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET') {
    return `Connection to port ${port} timed out/reset. The agent may be busy or the WSL2 port proxy is stale. [R] to retry.`;
  }
  if (code === 'ENOTFOUND') {
    return `Host not found for port ${port}. Check the server URL in Settings (,).`;
  }
  return code ? `Connection error (${code}) on port ${port}. [R] to retry.` : '';
}

export function connectSSE(port, onEvent, onStatus, getToken = () => '') {
  let active = true;
  let retryDelay = 3000;
  let retryTimer = null;
  let currentReq = null;

  function attempt() {
    if (!active) return;
    onStatus('connecting');

    // Read the token per attempt: the live-view server may start after the TUI,
    // so the token file can appear on a later retry. /events now requires it.
    const token = getToken();
    const url = `http://127.0.0.1:${port}/events${token ? `?token=${encodeURIComponent(token)}` : ''}`;

    // Use 127.0.0.1 (not localhost): on WSL2/dual-stack, localhost resolves to
    // IPv6 ::1 and a missing server hangs instead of refusing. The agent server
    // binds all interfaces, so IPv4 connects and fails fast when it's down.
    const req = http.get(url, (res) => {
      if (res.statusCode === 401) {
        res.resume();
        onStatus('disconnected', `Live-view auth failed on port ${port} (token missing/stale). It will retry once the agent writes .agent/web-ui-token. [R] to retry.`);
        retry();
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        onStatus('disconnected', `Agent server on port ${port} returned HTTP ${res.statusCode}. [R] to retry.`);
        retry();
        return;
      }
      onStatus('connected');
      retryDelay = 3000;

      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try { onEvent(JSON.parse(line.slice(6))); } catch {}
          }
        }
      });

      res.on('end', () => {
        onStatus('disconnected', `Agent stream on port ${port} ended. It may have finished or stopped. [R] to retry.`);
        retry();
      });

      res.on('error', (err) => {
        onStatus('disconnected', diagnose(err, port));
        retry();
      });
    });

    currentReq = req;
    req.on('error', (err) => {
      onStatus('disconnected', diagnose(err, port));
      retry();
    });

    // Watchdog: no bytes for 20s. A healthy stream resets this on the server's 15s
    // heartbeat, so it only fires when the connection is genuinely dead — either it
    // never responded, OR (the real bug) an ESTABLISHED stream went silent because
    // the machine slept / the network dropped while you were away. In BOTH cases we
    // must reconnect; the previous code skipped retry() once established, so coming
    // back to the TUI left it permanently frozen with no events.
    let established = false;
    req.on('response', () => { established = true; });
    req.setTimeout(20_000, () => {
      req.destroy();
      onStatus('disconnected', established
        ? `Live-view stream on port ${port} went idle (no heartbeat in 20s) — reconnecting…`
        : `No response from port ${port} within 20s — agent not running or WSL2 port proxy is stale. [R] to retry.`);
      retry();
    });
  }

  // Schedule a single reconnect. Guarded so the several paths that can fire on one
  // dropped connection (timeout + 'error' + 'end') collapse into one attempt.
  function retry() {
    if (!active || retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = null; attempt(); }, retryDelay);
    retryDelay = Math.min(retryDelay * 1.5, 30000);
  }

  attempt();

  return () => {
    active = false;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    try { currentReq?.destroy(); } catch { /* best-effort */ }
  };
}
