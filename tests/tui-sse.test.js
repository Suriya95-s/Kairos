// tests/tui-sse.test.js — the SSE client must reconnect after a dropped/idle stream.
// Regression for the freeze: an established stream that went silent (sleep / network
// drop) used to be torn down WITHOUT reconnecting, so returning to the TUI showed a
// frozen screen with no further events.
import { test, describe } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { connectSSE } from '../apps/tui/src/client/sse.js';

describe('SSE auto-reconnect', () => {
  test('a dropped established stream triggers a reconnect (≥2 connections)', async () => {
    let connections = 0;
    const events = [];
    const statuses = [];
    const server = http.createServer((req, res) => {
      connections++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"type":"paused"}\n\n');
      setTimeout(() => { try { res.destroy(); } catch {} }, 50); // simulate the stream dropping
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const stop = connectSSE(port, (ev) => events.push(ev), (s) => statuses.push(s));
    // connect (0s) → event → drop → retry (retryDelay 3s) → reconnect
    await new Promise(r => setTimeout(r, 3600));
    stop();
    await new Promise(r => server.close(r));

    assert.ok(connections >= 2, `expected a reconnect, got ${connections} connection(s)`);
    assert.ok(events.some(e => e.type === 'paused'), 'the event was delivered');
    assert.ok(statuses.includes('connected'), 'reported connected');
    assert.ok(statuses.includes('disconnected'), 'reported the drop');
  });

  test('stop() halts reconnects (no connections after teardown)', async () => {
    let connections = 0;
    const server = http.createServer((req, res) => {
      connections++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': hb\n\n');
      setTimeout(() => { try { res.destroy(); } catch {} }, 30);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const stop = connectSSE(port, () => {}, () => {});
    await new Promise(r => setTimeout(r, 100));
    stop();
    const after = connections;
    await new Promise(r => setTimeout(r, 3600)); // longer than retryDelay — must NOT reconnect
    await new Promise(r => server.close(r));

    assert.equal(connections, after, 'no new connections after stop()');
  });
});
