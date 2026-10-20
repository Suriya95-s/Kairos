// tests/tracer.test.js — record / replay determinism at the LLM+tool boundary.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setWorkspace } from '../src/state.js';
import { traced, resetTracer, tracerMode } from '../src/tracer.js';

let dir;
const ENV_KEYS = ['AGENT_RECORD', 'AGENT_REPLAY', 'AGENT_REPLAY_STRICT'];
let saved;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-'));
  setWorkspace(dir);
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  ENV_KEYS.forEach((k) => delete process.env[k]);
  resetTracer();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('tracer off mode', () => {
  test('passes through and writes no trace', async () => {
    assert.equal(tracerMode(), 'off');
    const r = await traced('llm', { m: 1 }, async () => 'live');
    assert.equal(r, 'live');
    assert.ok(!fs.existsSync(path.join(dir, '.agent', 'traces')));
  });
});

describe('tracer record → replay', () => {
  test('records each boundary call, then replays them without doing real work', async () => {
    // ── record ──
    process.env.AGENT_RECORD = 't1';
    resetTracer();
    assert.equal(tracerMode(), 'record');
    const a = await traced('llm',  { m: 1 }, async () => ({ content: 'A' }));
    const b = await traced('tool', { t: 1 }, async () => ({ result: 'B', error: false }));
    const c = await traced('llm',  { m: 2 }, async () => ({ content: 'C' }));
    assert.deepEqual(a, { content: 'A' });
    assert.deepEqual(b, { result: 'B', error: false });
    assert.deepEqual(c, { content: 'C' });

    const traceFile = path.join(dir, '.agent', 'traces', 't1.jsonl');
    const lines = fs.readFileSync(traceFile, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 3, 'three boundary calls recorded');
    assert.equal(JSON.parse(lines[0]).kind, 'llm');
    assert.equal(JSON.parse(lines[1]).kind, 'tool');

    // ── replay (same id) ── produce() must NOT run; recorded results returned.
    delete process.env.AGENT_RECORD;
    process.env.AGENT_REPLAY = 't1';
    resetTracer();
    assert.equal(tracerMode(), 'replay');
    const boom = async () => { throw new Error('produce must not run during replay'); };
    assert.deepEqual(await traced('llm',  { m: 1 }, boom), { content: 'A' });
    assert.deepEqual(await traced('tool', { t: 1 }, boom), { result: 'B', error: false });
    assert.deepEqual(await traced('llm',  { m: 2 }, boom), { content: 'C' });
  });

  test('replay throws when the run runs longer than the recording', async () => {
    process.env.AGENT_RECORD = 't2';
    resetTracer();
    await traced('llm', { m: 1 }, async () => ({ content: 'only-one' }));

    delete process.env.AGENT_RECORD;
    process.env.AGENT_REPLAY = 't2';
    resetTracer();
    await traced('llm', { m: 1 }, async () => ({ content: 'x' })); // ok
    await assert.rejects(
      () => traced('llm', { m: 2 }, async () => ({ content: 'x' })),
      /replay exhausted/,
    );
  });

  test('strict replay rejects on input divergence', async () => {
    process.env.AGENT_RECORD = 't3';
    resetTracer();
    await traced('tool', { name: 'read', args: { path: 'a' } }, async () => ({ result: 'ok' }));

    delete process.env.AGENT_RECORD;
    process.env.AGENT_REPLAY = 't3';
    process.env.AGENT_REPLAY_STRICT = '1';
    resetTracer();
    await assert.rejects(
      () => traced('tool', { name: 'read', args: { path: 'DIFFERENT' } }, async () => ({ result: 'ok' })),
      /key divergence/,
    );
  });

  test('a recorded error is re-thrown on replay (sequence stays aligned)', async () => {
    process.env.AGENT_RECORD = 't4';
    resetTracer();
    await assert.rejects(() => traced('tool', { t: 1 }, async () => { throw new Error('boom'); }), /boom/);

    delete process.env.AGENT_RECORD;
    process.env.AGENT_REPLAY = 't4';
    resetTracer();
    await assert.rejects(() => traced('tool', { t: 1 }, async () => ({ result: 'never' })), /boom/);
  });
});
