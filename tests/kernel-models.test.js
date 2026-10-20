// tests/kernel-models.test.js
// The LLM model registry — named endpoints for the multi-model brain.
//
// The invariants under test:
//   1. models.json NEVER holds a credential — only `vault:` references.
//   2. Env vars beat the registry: an explicit override must win, always.
//   3. `check` is a real completion, not a ping — reachability alone lies.
//
// checkModel is exercised through an injected fetchFn; no test opens a socket.
// The config fallback is proved in a child process, because config.js resolves
// its environment once at module load and this process has long since loaded it.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  modelsFile, loadModels, saveModels, addModel, removeModel,
  setActive, resolveModel, recordCheck, checkModel,
} from '../src/kernel/models.js';
import { Vault, getVault, resetVault } from '../src/kernel/vault.js';
import { resolveApiKey } from '../src/llm.js';

const REPO = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

let tmpHome;
const savedHome = process.env.KAIROS_HOME;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-models-'));
  process.env.KAIROS_HOME = tmpHome;
  resetVault();
  getVault({ backend: 'file' }); // seed the singleton so nothing touches the OS credential store
});

afterEach(() => {
  resetVault();
  if (savedHome === undefined) delete process.env.KAIROS_HOME;
  else process.env.KAIROS_HOME = savedHome;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

// ── Registry CRUD ────────────────────────────────────────────────────────────

describe('model registry', () => {
  test('add then load round-trips, and the first model becomes active', () => {
    addModel('qwen36', { baseURL: 'http://localhost:8000/v1', model: 'qwen3.6-35b' });
    const data = loadModels();
    assert.equal(data.active, 'qwen36');
    assert.equal(data.models.qwen36.model, 'qwen3.6-35b');
    assert.equal(data.models.qwen36.baseURL, 'http://localhost:8000/v1');
  });

  test('a second model does not steal active', () => {
    addModel('a', { baseURL: 'http://localhost:8000/v1', model: 'm-a' });
    addModel('b', { baseURL: 'http://localhost:9000/v1', model: 'm-b' });
    assert.equal(loadModels().active, 'a');
  });

  test('trailing slashes are stripped from the base URL', () => {
    addModel('m', { baseURL: 'http://localhost:8000/v1///', model: 'x' });
    assert.equal(loadModels().models.m.baseURL, 'http://localhost:8000/v1');
  });

  test('re-adding a name keeps its addedAt and lastCheck', () => {
    addModel('m', { baseURL: 'http://localhost:8000/v1', model: 'x' });
    recordCheck('m', { ok: true, latencyMs: 42, reply: 'ready' });
    const before = loadModels().models.m;
    addModel('m', { baseURL: 'http://localhost:8001/v1', model: 'y' });
    const after = loadModels().models.m;
    assert.equal(after.addedAt, before.addedAt);
    assert.equal(after.lastCheck.latencyMs, 42);
    assert.equal(after.baseURL, 'http://localhost:8001/v1');
  });

  test('a bad name is rejected', () => {
    assert.throws(() => addModel('has spaces', { baseURL: 'http://x/v1', model: 'm' }), /not a valid model name/);
    assert.throws(() => addModel('', { baseURL: 'http://x/v1', model: 'm' }), /not a valid model name/);
  });

  test('a non-URL and a non-http scheme are rejected', () => {
    assert.throws(() => addModel('m', { baseURL: 'localhost:8000', model: 'x' }), /not a URL|http/);
    assert.throws(() => addModel('m', { baseURL: 'ftp://host/v1', model: 'x' }), /http/);
  });

  test('a missing model id is rejected', () => {
    assert.throws(() => addModel('m', { baseURL: 'http://localhost:8000/v1' }), /model id is required/);
  });

  test('INVARIANT: a plaintext api key never reaches models.json', () => {
    assert.throws(
      () => addModel('gpt', { baseURL: 'https://api.example.com/v1', model: 'g', apiKey: 'sk-verysecret123' }),
      /never stored in models\.json/,
    );
    // and nothing was written on the failed attempt
    assert.ok(!fs.existsSync(modelsFile()) || !fs.readFileSync(modelsFile(), 'utf-8').includes('sk-verysecret123'));
  });

  test('a vault: reference is accepted and stored verbatim', () => {
    addModel('gpt', { baseURL: 'https://api.example.com/v1', model: 'g', apiKey: 'vault:llm.gpt' });
    assert.equal(loadModels().models.gpt.apiKey, 'vault:llm.gpt');
  });

  test('setActive switches; an unknown name throws with a pointer to list', () => {
    addModel('a', { baseURL: 'http://localhost:8000/v1', model: 'm-a' });
    addModel('b', { baseURL: 'http://localhost:9000/v1', model: 'm-b' });
    setActive('b');
    assert.equal(loadModels().active, 'b');
    assert.throws(() => setActive('ghost'), /no model named "ghost"/);
  });

  test('removing the active model clears active rather than pointing at a ghost', () => {
    addModel('only', { baseURL: 'http://localhost:8000/v1', model: 'x' });
    assert.equal(removeModel('only'), true);
    const data = loadModels();
    assert.equal(data.active, null);
    assert.equal(Object.keys(data.models).length, 0);
  });

  test('removing an unknown model reports false, not a throw', () => {
    assert.equal(removeModel('nope'), false);
  });

  test('a corrupt models.json falls back to empty instead of crashing', () => {
    fs.mkdirSync(path.dirname(modelsFile()), { recursive: true });
    fs.writeFileSync(modelsFile(), '{ not json', 'utf-8');
    const data = loadModels();
    assert.deepEqual(data.models, {});
  });

  test('recordCheck persists the verdict; unknown names report false', () => {
    addModel('m', { baseURL: 'http://localhost:8000/v1', model: 'x' });
    assert.equal(recordCheck('m', { ok: false, error: 'boom' }), true);
    const saved = loadModels().models.m.lastCheck;
    assert.equal(saved.ok, false);
    assert.equal(saved.error, 'boom');
    assert.ok(saved.ts);
    assert.equal(recordCheck('ghost', { ok: true }), false);
  });
});

// ── Vault resolution ─────────────────────────────────────────────────────────

describe('resolveModel', () => {
  test('resolves the vault reference to the real key', () => {
    const v = new Vault({ backend: 'file' });
    v.set('llm', 'gpt', 'sk-real-key-material-12345');
    addModel('gpt', { baseURL: 'https://api.example.com/v1', model: 'g', apiKey: 'vault:llm.gpt' });
    const entry = resolveModel('gpt', { vault: v });
    assert.equal(entry.apiKey, 'sk-real-key-material-12345');
    assert.equal(entry.name, 'gpt');
  });

  test('a reference whose secret was never set throws the actionable vault error', () => {
    addModel('gpt', { baseURL: 'https://api.example.com/v1', model: 'g', apiKey: 'vault:llm.gpt' });
    assert.throws(() => resolveModel('gpt', { vault: new Vault({ backend: 'file' }) }), /is not set/);
  });

  test('a keyless local model resolves with an empty key', () => {
    addModel('local', { baseURL: 'http://localhost:8000/v1', model: 'q' });
    assert.equal(resolveModel('local', { vault: new Vault({ backend: 'file' }) }).apiKey, '');
  });

  test('an unknown name throws', () => {
    assert.throws(() => resolveModel('ghost'), /no model named/);
  });
});

// ── checkModel (injected fetch — no sockets) ─────────────────────────────────

function fakeFetch(handlers) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const route = String(url).endsWith('/models') ? 'models' : 'completions';
    const h = handlers[route];
    if (h instanceof Error) throw h;
    return {
      ok: h.status >= 200 && h.status < 300,
      status: h.status,
      json: async () => h.body,
      text: async () => JSON.stringify(h.body ?? ''),
    };
  };
  fn.calls = calls;
  return fn;
}

describe('checkModel', () => {
  const ENTRY = { name: 'm', baseURL: 'http://localhost:8000/v1', model: 'test-model', apiKey: '' };
  const READY = { status: 200, body: { choices: [{ message: { content: '  ready  ' } }] } };

  test('healthy endpoint: reachable, ok, measured latency, trimmed reply', async () => {
    const f = fakeFetch({ models: { status: 200, body: {} }, completions: READY });
    const r = await checkModel(ENTRY, { fetchFn: f });
    assert.equal(r.reachable, true);
    assert.equal(r.ok, true);
    assert.equal(r.reply, 'ready');
    assert.equal(typeof r.latencyMs, 'number');
    assert.equal(r.error, null);
  });

  test('a server without /models still passes on the completion alone', async () => {
    const f = fakeFetch({ models: new Error('ECONNREFUSED'), completions: READY });
    const r = await checkModel(ENTRY, { fetchFn: f });
    assert.equal(r.reachable, false);
    assert.equal(r.ok, true);
  });

  test('reachable but failing completions is a failure — reachability alone must not pass', async () => {
    const f = fakeFetch({
      models: { status: 200, body: {} },
      completions: { status: 404, body: { error: 'model not found' } },
    });
    const r = await checkModel(ENTRY, { fetchFn: f });
    assert.equal(r.reachable, true);
    assert.equal(r.ok, false);
    assert.match(r.error, /HTTP 404/);
  });

  test('a dead endpoint reports the network error', async () => {
    const boom = new Error('fetch failed');
    const f = fakeFetch({ models: boom, completions: boom });
    const r = await checkModel(ENTRY, { fetchFn: f });
    assert.equal(r.ok, false);
    assert.match(r.error, /fetch failed/);
  });

  test('thinking-model block arrays keep only the text blocks', async () => {
    const f = fakeFetch({
      models: { status: 200, body: {} },
      completions: {
        status: 200,
        body: { choices: [{ message: { content: [
          { type: 'thinking', thinking: 'hmm let me ponder' },
          { type: 'text', text: 'ready' },
        ] } }] },
      },
    });
    const r = await checkModel(ENTRY, { fetchFn: f });
    assert.equal(r.reply, 'ready');
  });

  test('the api key travels as Authorization on both probes — and never when absent', async () => {
    const f1 = fakeFetch({ models: { status: 200, body: {} }, completions: READY });
    await checkModel({ ...ENTRY, apiKey: 'sk-abc' }, { fetchFn: f1 });
    assert.equal(f1.calls[0].opts.headers.Authorization, 'Bearer sk-abc');
    assert.equal(f1.calls[1].opts.headers.Authorization, 'Bearer sk-abc');

    const f2 = fakeFetch({ models: { status: 200, body: {} }, completions: READY });
    await checkModel(ENTRY, { fetchFn: f2 });
    assert.equal(f2.calls[0].opts.headers?.Authorization, undefined);
    assert.equal(f2.calls[1].opts.headers.Authorization, undefined);
  });

  test('the completion asks for the registered model id', async () => {
    const f = fakeFetch({ models: { status: 200, body: {} }, completions: READY });
    await checkModel(ENTRY, { fetchFn: f });
    const body = JSON.parse(f.calls[1].opts.body);
    assert.equal(body.model, 'test-model');
    assert.equal(body.stream, false);
  });
});

// ── llm.js key resolution ────────────────────────────────────────────────────

describe('resolveApiKey', () => {
  test('a literal key passes through untouched', async () => {
    assert.equal(await resolveApiKey('sk-literal'), 'sk-literal');
    assert.equal(await resolveApiKey(''), '');
    assert.equal(await resolveApiKey(undefined), undefined);
  });

  test('a vault: reference resolves to the stored secret', async () => {
    getVault().set('llm', 'resolve-test-a', 'sk-from-vault-a');
    assert.equal(await resolveApiKey('vault:llm.resolve-test-a'), 'sk-from-vault-a');
  });

  test('resolution is once-per-process — the vault is not consulted again', async () => {
    getVault().set('llm', 'resolve-test-b', 'sk-from-vault-b');
    assert.equal(await resolveApiKey('vault:llm.resolve-test-b'), 'sk-from-vault-b');
    getVault().delete('llm', 'resolve-test-b');
    assert.equal(await resolveApiKey('vault:llm.resolve-test-b'), 'sk-from-vault-b');
  });

  test('an unset reference throws the actionable vault error', async () => {
    await assert.rejects(resolveApiKey('vault:llm.never-set-xyz'), /is not set/);
  });
});

// ── config.js fallback (child process — config resolves env at import) ───────

describe('config registry fallback', () => {
  const PROBE = `import(${JSON.stringify(pathToFileURL(path.join(REPO, 'src/config.js')).href)})
    .then(m => console.log(JSON.stringify({
      baseURL: m.default.baseURL, model: m.default.model, apiKey: m.default.apiKey,
      maxOutputTokens: m.default.maxOutputTokens, contextWindow: m.default.contextWindow,
    })));`;

  function probeConfig(extraEnv = {}) {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (/^(AGENT_|OPENAI_|KAIROS_)/.test(k)) continue;
      // The child stands in for a real CLI process, not a test. Inheriting the
      // runner's marker would make config skip the registry — which is exactly
      // the behaviour the last test in this block asserts, and the opposite of
      // what these three need.
      if (k === 'NODE_TEST_CONTEXT') continue;
      env[k] = v;
    }
    Object.assign(env, { KAIROS_HOME: tmpHome }, extraEnv);
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE], {
      env, encoding: 'utf-8', cwd: REPO,
    });
    assert.equal(res.status, 0, res.stderr);
    return JSON.parse(res.stdout.trim());
  }

  test('with no env vars, the active registry entry supplies endpoint, model, and key reference', () => {
    addModel('qwen36', {
      baseURL: 'http://localhost:7777/v1', model: 'qwen3.6-35b', apiKey: 'vault:llm.qwen36',
    });
    const cfg = probeConfig();
    assert.equal(cfg.baseURL, 'http://localhost:7777/v1');
    assert.equal(cfg.model, 'qwen3.6-35b');
    assert.equal(cfg.apiKey, 'vault:llm.qwen36');
    // the model profile auto-matched from the registry-supplied id
    assert.equal(cfg.maxOutputTokens, 8192);
  });

  test('env vars beat the registry — an explicit override must win', () => {
    addModel('qwen36', { baseURL: 'http://localhost:7777/v1', model: 'qwen3.6-35b' });
    const cfg = probeConfig({
      AGENT_BASE_URL: 'http://localhost:9999/v1',
      AGENT_MODEL: 'someone-else',
      AGENT_API_KEY: 'sk-env-wins',
    });
    assert.equal(cfg.baseURL, 'http://localhost:9999/v1');
    assert.equal(cfg.model, 'someone-else');
    assert.equal(cfg.apiKey, 'sk-env-wins');
  });

  test('a partial env override mixes per-field: env URL wins, registry fills the model', () => {
    // The full-override test above never reads the registry at all (both env
    // vars set short-circuits the disk read), so it cannot catch a flipped
    // precedence. This one can: the registry IS read here, and its baseURL
    // must still lose to the env var.
    addModel('qwen36', { baseURL: 'http://localhost:7777/v1', model: 'qwen3.6-35b' });
    const cfg = probeConfig({ AGENT_BASE_URL: 'http://localhost:9999/v1' });
    assert.equal(cfg.baseURL, 'http://localhost:9999/v1');
    assert.equal(cfg.model, 'qwen3.6-35b');
  });

  test('no registry file at all leaves the shipped defaults intact', () => {
    const cfg = probeConfig();
    assert.equal(cfg.baseURL, 'http://localhost:8000/v1');
    assert.equal(cfg.model, 'gpt-oss-120b');
  });

  test('HERMETICITY: the test runner never sees the registry', () => {
    // A registered model must not change what the suite observes. This escaped
    // once already: adding a 128K-context model moved config.contextWindow from
    // 32000 to 131072, which moved a truncation limit inside context.js, which
    // failed a context-building test in a different file that had nothing to do
    // with models. Whether a developer has run `kairos llm add` is not allowed
    // to be an input to the test suite.
    addModel('huge', {
      baseURL: 'http://localhost:7777/v1', model: 'qwen3.6-35b',
    });
    setActive('huge');

    const asTest = probeConfig({ NODE_TEST_CONTEXT: 'child-v8' });
    assert.equal(asTest.baseURL, 'http://localhost:8000/v1', 'the registry endpoint must not leak into a test');
    assert.equal(asTest.model, 'gpt-oss-120b');
    assert.equal(asTest.contextWindow, 32000, 'the shipped default, not the registered model’s 131072');

    // ...and the same registry IS honoured outside the runner, so this is
    // hermeticity rather than the feature being quietly disabled.
    const asCli = probeConfig();
    assert.equal(asCli.baseURL, 'http://localhost:7777/v1');
    assert.equal(asCli.contextWindow, 131072);
  });

  test('KAIROS_NO_MODEL_REGISTRY=1 opts out explicitly', () => {
    addModel('local', { baseURL: 'http://localhost:7777/v1', model: 'qwen3.6-35b' });
    const cfg = probeConfig({ KAIROS_NO_MODEL_REGISTRY: '1' });
    assert.equal(cfg.baseURL, 'http://localhost:8000/v1');
  });
});

// ── CLI (through main(), the real entry) ─────────────────────────────────────

describe('kairos llm CLI', () => {
  async function run(argv) {
    const { main } = await import('../src/kernel/cli.js');
    const lines = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s) => { lines.push(String(s)); return true; };
    try {
      const code = await main(argv);
      return { code, stdout: lines.join('') };
    } finally {
      process.stdout.write = orig;
    }
  }

  test('add with a plaintext --key vaults it — models.json holds only the reference', async () => {
    const { code, stdout } = await run([
      'llm', 'add', 'gptmini',
      '--url', 'https://api.example.com/v1', '--model', 'gpt-4o-mini', '--key', 'sk-plaintext-9876',
    ]);
    assert.equal(code, 0);
    assert.match(stdout, /vault:llm\.gptmini/);
    const raw = fs.readFileSync(modelsFile(), 'utf-8');
    assert.ok(!raw.includes('sk-plaintext-9876'), 'the literal key must not be on disk in models.json');
    assert.equal(loadModels().models.gptmini.apiKey, 'vault:llm.gptmini');
    assert.equal(getVault().get('llm', 'gptmini'), 'sk-plaintext-9876');
  });

  test('list marks the active model and shows check state', async () => {
    addModel('a', { baseURL: 'http://localhost:8000/v1', model: 'm-a' });
    addModel('b', { baseURL: 'http://localhost:9000/v1', model: 'm-b' });
    recordCheck('a', { ok: true, latencyMs: 88, reply: 'ready' });
    const { code, stdout } = await run(['llm', 'list']);
    assert.equal(code, 0);
    assert.match(stdout, /● a: m-a .*ok 88ms/);
    assert.match(stdout, /○ b: m-b .*never checked/);
  });

  test('use switches the default and says how it takes effect', async () => {
    addModel('a', { baseURL: 'http://localhost:8000/v1', model: 'm-a' });
    addModel('b', { baseURL: 'http://localhost:9000/v1', model: 'm-b' });
    const { code, stdout } = await run(['llm', 'use', 'b']);
    assert.equal(code, 0);
    assert.equal(loadModels().active, 'b');
    assert.match(stdout, /restart/i);
  });

  test('check with nothing registered exits 2 with guidance, not a crash', async () => {
    const { code } = await run(['llm', 'check']);
    assert.equal(code, 2);
  });

  test('an unknown subcommand exits 2', async () => {
    const { code } = await run(['llm', 'frobnicate']);
    assert.equal(code, 2);
  });
});
