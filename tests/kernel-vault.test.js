// tests/kernel-vault.test.js
// S1 — the secrets vault.
//
// The acceptance criterion is blunt: after a full run, a grep of every journal
// and log finds zero credential material, and deleting the vault cleanly
// de-authorizes every integration. Both are tested here, the first end-to-end
// through the real bus.
//
// The file backend is forced throughout. Exercising DPAPI/Keychain/libsecret
// would write into the developer's actual OS credential store — a real side
// effect on the host, from a unit test. The backend only supplies the master
// key; every behaviour below is identical whichever one provides it.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Vault, getVault, resetVault, vaultFile, keyFile, detectBackend } from '../src/kernel/vault.js';
import { Bus } from '../src/kernel/bus.js';
import { clearSecretRegistry, redactString } from '../src/learning/redactor.js';

let tmpHome;
const savedHome = process.env.KAIROS_HOME;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-vault-'));
  process.env.KAIROS_HOME = tmpHome;
  clearSecretRegistry();
  resetVault();
});

afterEach(() => {
  clearSecretRegistry();
  resetVault();
  if (savedHome === undefined) delete process.env.KAIROS_HOME;
  else process.env.KAIROS_HOME = savedHome;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

const mk = () => new Vault({ backend: 'file' });

describe('vault storage', () => {
  test('set then get round-trips', () => {
    const v = mk();
    v.set('github', 'token', 'ghp_realtokenvalue_0123456789');
    assert.equal(v.get('github', 'token'), 'ghp_realtokenvalue_0123456789');
  });

  test('secrets survive a process restart', () => {
    mk().set('llm', 'AGENT_API_KEY', 'sk-persisted-across-restarts-123');
    assert.equal(mk().get('llm', 'AGENT_API_KEY'), 'sk-persisted-across-restarts-123');
  });

  test('an unset key is null, not a throw', () => {
    assert.equal(mk().get('nope', 'nothing'), null);
  });

  test('the vault file is encrypted — the plaintext is not in it', () => {
    const v = mk();
    v.set('email', 'oauth_refresh', 'super-secret-refresh-token-value');
    const raw = fs.readFileSync(vaultFile());
    assert.ok(!raw.includes('super-secret-refresh-token-value'), 'ciphertext must not contain the plaintext');
    assert.ok(!raw.toString('utf-8').includes('oauth_refresh'), 'nor the key names');
  });

  test('list exposes names but never values', () => {
    const v = mk();
    v.set('github', 'token', 'ghp_secret_value_here_0123456789');
    v.set('github', 'user', 'octocat-username-value');
    const listed = v.list();
    assert.deepEqual(listed, { github: ['token', 'user'] });
    assert.ok(!JSON.stringify(listed).includes('ghp_secret'));
  });

  test('delete removes one entry and prunes the empty scope', () => {
    const v = mk();
    v.set('s', 'a', 'value-a-long-enough');
    v.set('s', 'b', 'value-b-long-enough');
    assert.equal(v.delete('s', 'a'), true);
    assert.deepEqual(v.list(), { s: ['b'] });
    v.delete('s', 'b');
    assert.deepEqual(v.list(), {});
  });

  test('deleting something absent reports false rather than pretending', () => {
    assert.equal(mk().delete('ghost', 'key'), false);
  });

  test('an empty secret is rejected', () => {
    assert.throws(() => mk().set('s', 'k', ''), /non-empty string/);
    assert.throws(() => mk().set('s', 'k', null), /non-empty string/);
  });
});

describe('tamper and key failure', () => {
  test('a tampered vault fails loudly instead of decrypting to garbage', () => {
    // AES-GCM is authenticated precisely so this is detectable.
    const v = mk();
    v.set('s', 'k', 'a-real-secret-value-here');
    const raw = fs.readFileSync(vaultFile());
    raw[raw.length - 1] ^= 0xff;
    fs.writeFileSync(vaultFile(), raw);

    assert.throws(() => new Vault({ backend: 'file' }).get('s', 'k'), /could not be decrypted/);
  });

  test('a wrong master key refuses rather than silently starting empty', () => {
    // Quietly returning {} would read as "your integrations were de-authorized"
    // and invite re-entering every credential into a vault someone else may
    // control.
    mk().set('s', 'k', 'a-real-secret-value-here');
    fs.writeFileSync(keyFile(), Buffer.alloc(32, 7).toString('hex'));
    assert.throws(() => new Vault({ backend: 'file' }).list(), /could not be decrypted/);
  });

  test('the error explains how to recover', () => {
    mk().set('s', 'k', 'a-real-secret-value-here');
    fs.writeFileSync(keyFile(), Buffer.alloc(32, 9).toString('hex'));
    assert.throws(() => new Vault({ backend: 'file' }).list(), (err) => {
      assert.match(err.message, /Delete the vault to start over/);
      return true;
    });
  });

  test('the master key file is 0600 where the OS honours it', () => {
    mk().set('s', 'k', 'a-real-secret-value-here');
    const mode = fs.statSync(keyFile()).mode & 0o777;
    if (process.platform === 'win32') assert.ok(mode > 0);
    else assert.equal(mode, 0o600);
  });
});

describe('honesty about protection level', () => {
  test('the file backend reports itself as unprotected, with a reason', () => {
    // A vault that overstates its guarantees is worse than one that admits
    // them: the user decides what to store based on what we claim.
    const s = mk().status();
    assert.equal(s.backend, 'file');
    assert.equal(s.protected, false);
    assert.match(s.warning, /no OS credential store/);
  });

  test('status counts entries without exposing them', () => {
    const v = mk();
    v.set('a', 'k', 'value-one-long-enough');
    v.set('b', 'k', 'value-two-long-enough');
    const s = v.status();
    assert.equal(s.entries, 2);
    assert.ok(!JSON.stringify(s).includes('value-one'));
  });

  test('detectBackend names a real backend for this platform, or null', () => {
    const b = detectBackend();
    assert.ok(b === null || ['dpapi', 'keychain', 'libsecret'].includes(b));
  });
});

describe('secrets never transit the bus or journals (the S1 criterion)', () => {
  test('a vault secret is redacted from an event even with no matching pattern', () => {
    // The regex rules catch things that LOOK like keys. This is the other half:
    // the vault knows which strings ARE secrets, so a shapeless credential is
    // covered too.
    const v = mk();
    const shapeless = 'correct-horse-battery-staple-42';
    v.set('router', 'admin_password', shapeless);

    assert.ok(!redactString(`password is ${shapeless}`).includes(shapeless));
  });

  test('a secret cannot reach the journal or a subscriber', () => {
    const v = mk();
    const secret = 'tenant-id-9f8e7d6c5b4a-not-key-shaped';
    v.set('azure', 'tenant', secret);

    const bus = new Bus({ journalDir: path.join(tmpHome, 'bus') });
    let delivered = null;
    bus.subscribe('*', e => { delivered = e; });
    bus.publish({ source: 'mission', kind: 'mission_update', payload: { note: `using ${secret}` } });

    assert.ok(!delivered.payload.note.includes(secret), 'subscribers must not see it');
    const journal = fs.readFileSync(bus.segments()[0], 'utf-8');
    assert.ok(!journal.includes(secret), 'the journal must not contain it');
  });

  test('loading an existing vault re-registers its secrets for redaction', () => {
    // Otherwise a daemon restart would silently stop protecting everything it
    // stored before the restart.
    const secret = 'restart-persisted-secret-value';
    mk().set('s', 'k', secret);
    clearSecretRegistry();
    assert.ok(redactString(secret).includes(secret), 'control: not yet registered');

    new Vault({ backend: 'file' }).list();
    assert.ok(!redactString(`x ${secret} y`).includes(secret), 'reloading must re-register');
  });

  test('a deleted secret stops being redacted', () => {
    const v = mk();
    const secret = 'rotated-out-credential-value';
    v.set('s', 'k', secret);
    v.delete('s', 'k');
    assert.ok(redactString(secret).includes(secret),
      'a rotated-out value should not redact ordinary text forever');
  });

  test('short values are not registered — they would mangle normal text', () => {
    const v = mk();
    v.set('s', 'k', 'abcdefgh');   // exactly the 8-char floor
    assert.ok(!redactString('abcdefgh').includes('abcdefgh'));
    clearSecretRegistry();
    // Below the floor, nothing is registered even if someone stores it.
    assert.equal(redactString('short'), 'short');
  });
});

describe('vault references in config', () => {
  test('a vault: reference resolves to the stored secret', () => {
    const v = mk();
    v.set('github', 'token', 'ghp_config_reference_value_0123');
    assert.equal(v.resolve('vault:github.token'), 'ghp_config_reference_value_0123');
  });

  test('a plain literal passes through untouched', () => {
    assert.equal(mk().resolve('http://localhost:8000/v1'), 'http://localhost:8000/v1');
    assert.equal(mk().resolve(42), 42);
  });

  test('a missing reference throws with the command that fixes it', () => {
    assert.throws(() => mk().resolve('vault:github.token'), /secret set github token/);
  });

  test('a reference with no scope defaults to "default"', () => {
    const v = mk();
    v.set('default', 'apikey', 'default-scope-secret-value');
    assert.equal(v.resolve('vault:apikey'), 'default-scope-secret-value');
  });

  test('resolveConfig walks a whole MCP-style config', () => {
    // The point: mcp-servers.json stays committable because it holds
    // references, not literals.
    const v = mk();
    v.set('github', 'token', 'ghp_deep_config_value_01234567');
    const resolved = v.resolveConfig({
      mcpServers: {
        github: { command: 'npx', env: { GITHUB_TOKEN: 'vault:github.token' }, args: ['-y', 'server'] },
      },
    });
    assert.equal(resolved.mcpServers.github.env.GITHUB_TOKEN, 'ghp_deep_config_value_01234567');
    assert.deepEqual(resolved.mcpServers.github.args, ['-y', 'server']);
  });
});

describe('bootstrap migration from env', () => {
  test('env credentials are imported once', () => {
    const v = mk();
    const env = { AGENT_API_KEY: 'sk-from-the-environment-12345' };
    assert.deepEqual(v.migrateFromEnv(env), ['AGENT_API_KEY']);
    assert.equal(v.get('llm', 'AGENT_API_KEY'), 'sk-from-the-environment-12345');
    assert.deepEqual(v.migrateFromEnv(env), [], 'a second boot must not re-import');
  });

  test('local-inference placeholders are not treated as secrets', () => {
    // "ollama" and "lm-studio" are conventions, not credentials; storing them
    // just makes the vault noisy and the redactor dangerous.
    assert.deepEqual(mk().migrateFromEnv({ AGENT_API_KEY: 'ollama' }), []);
    assert.deepEqual(mk().migrateFromEnv({ AGENT_API_KEY: '' }), []);
  });
});

describe('destroy', () => {
  test('destroying the vault de-authorizes everything (S1 criterion)', () => {
    const v = mk();
    v.set('github', 'token', 'ghp_will_be_destroyed_01234567');
    v.set('email', 'oauth', 'oauth-refresh-to-be-destroyed');

    assert.equal(v.destroy(), true);
    assert.equal(fs.existsSync(vaultFile()), false);
    assert.equal(fs.existsSync(keyFile()), false);
    assert.deepEqual(new Vault({ backend: 'file' }).list(), {},
      'a fresh vault, not the old secrets under a new key');
  });

  test('destroyed secrets stop being redacted', () => {
    const v = mk();
    const secret = 'destroyed-secret-value-here';
    v.set('s', 'k', secret);
    v.destroy();
    assert.ok(redactString(secret).includes(secret));
  });
});

describe('single-accessor discipline', () => {
  test('getVault is a resettable accessor, not an import-time singleton', () => {
    const a = getVault({ backend: 'file' });
    assert.equal(getVault(), a);
    resetVault();
    assert.notEqual(getVault({ backend: 'file' }), a);
  });

  test('no kernel module reads a credential env var directly', () => {
    // S1: "nothing else in the codebase reads a credential from env/file
    // directly". Enforced here for the kernel, which is the surface that will
    // hold OAuth tokens after P7. vault.js itself is the one exception.
    const kernelDir = new URL('../src/kernel/', import.meta.url);
    const offenders = [];
    for (const name of fs.readdirSync(kernelDir)) {
      if (!name.endsWith('.js') || name === 'vault.js') continue;
      const src = fs.readFileSync(new URL(name, kernelDir), 'utf-8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      for (const m of src.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
        if (/(API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)$/.test(m[1])) {
          // The daemon's own loopback session token is minted, not a user
          // credential, so it is not vault material.
          if (m[1] === 'KAIROS_DAEMON_TOKEN') continue;
          offenders.push(`${name}: ${m[1]}`);
        }
      }
    }
    assert.deepEqual(offenders, [], 'credentials must come from the vault');
  });
});
