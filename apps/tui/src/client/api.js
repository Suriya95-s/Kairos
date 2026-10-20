// src/client/api.js — HTTP API calls to the Kairos HITL server

import http from 'node:http';

// Token provider set by the app once it knows the project root. The live-view
// server requires a bearer token on every /api route; without it the agent
// server returns 401 and the TUI silently can't act. Read fresh per request.
let _tokenProvider = () => '';
export function setTokenProvider(fn) { if (typeof fn === 'function') _tokenProvider = fn; }

function request(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const token = _tokenProvider();
    const opts = {
      // 127.0.0.1 (not localhost): avoids the IPv6 ::1 hang on WSL2/dual-stack
      // when the agent server is down — fails fast with ECONNREFUSED instead.
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };

    const req = http.request(opts, (res) => {
      let body = '';
      res.on('data', c => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve({}); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

export const api = {
  status:  (port) => request(port, 'GET',  '/api/status',       null),
  pending: (port) => request(port, 'GET',  '/api/pending',      null),
  approve: (port, id) => request(port, 'POST', `/api/approve/${id}`, {}),
  deny:    (port, id, reason) => request(port, 'POST', `/api/deny/${id}`, { reason: reason || '' }),
  clarify: (port, id, answer) => request(port, 'POST', `/api/clarify/${id}`, { answer: answer || '' }),
  memory:  (port, sub, q) => request(port, 'GET', `/api/memory?sub=${encodeURIComponent(sub || 'status')}&q=${encodeURIComponent(q || '')}`, null),
  steer:   (port, message) => request(port, 'POST', '/api/steer', { message }),
  pause:   (port) => request(port, 'POST', '/api/pause',  {}),
  resume:  (port) => request(port, 'POST', '/api/resume', {}),
};
