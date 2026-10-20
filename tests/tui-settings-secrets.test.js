// tests/tui-settings-secrets.test.js
// Closes the oldest live finding in this project.
//
// From Phase 0: the TUI writes .agent/tui-settings.json with mode 0600, Windows
// reports it as 666, and the API key sat in it in plaintext. The fix is not a
// better file mode — `chmod` is not a security mechanism on NTFS — it is not
// keeping the secret there at all.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { externalizeSecrets, resolveSecrets, isVaultRef, SECRET_KEYS, SECRET_JSON_KEYS } from '../apps/tui/src/settingsSecrets.js';
import { resetVault, getVault } from '../src/kernel/vault.js';
import { clearSecretRegistry } from '../src/learning/redactor.js';

let tmpHome;
const savedHome = process.env.KAIROS_HOME;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-tuisec-'));
  process.env.KAIROS_HOME = tmpHome;
  resetVault();
  clearSecretRegistry();
});

afterEach(() => {
  resetVault();
  clearSecretRegistry();
  if (savedHome === undefined) delete process.env.KAIROS_HOME;
  else process.env.KAIROS_HOME = savedHome;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

const SETTINGS = {
  model: 'qwen3-coder-30b',
  serverUrl: 'http://localhost:8000/v1',
  apiKey: 'sk-a-real-looking-api-key-0123456789',
  openrouterKey: 'sk-or-v1-another-real-looking-key-9876',
  temperature: 0.1,
};

describe('externalising credentials', () => {
  test('the written settings contain a reference, never the key', async () => {
    const { settings, stored } = await externalizeSecrets(SETTINGS);

    assert.equal(settings.apiKey, 'vault:tui.apiKey');
    assert.equal(settings.openrouterKey, 'vault:tui.openrouterKey');
    assert.deepEqual(stored.sort(), ['apiKey', 'openrouterKey']);

    const serialized = JSON.stringify(settings);
    assert.ok(!serialized.includes('sk-a-real-looking-api-key'), 'the api key must not be serialisable');
    assert.ok(!serialized.includes('sk-or-v1-another'), 'nor the openrouter key');
  });

  test('non-secret settings are untouched', async () => {
    const { settings } = await externalizeSecrets(SETTINGS);
    assert.equal(settings.model, 'qwen3-coder-30b');
    assert.equal(settings.serverUrl, 'http://localhost:8000/v1');
    assert.equal(settings.temperature, 0.1);
  });

  test('the input object is not mutated — the TUI keeps its live values', async () => {
    const input = { ...SETTINGS };
    await externalizeSecrets(input);
    assert.equal(input.apiKey, SETTINGS.apiKey, 'in-memory state must still hold the real key');
  });

  test('a round trip returns the original values', async () => {
    const { settings } = await externalizeSecrets(SETTINGS);
    const restored = await resolveSecrets(settings);
    assert.equal(restored.apiKey, SETTINGS.apiKey);
    assert.equal(restored.openrouterKey, SETTINGS.openrouterKey);
  });

  test('saving twice does not re-store a reference as if it were a key', async () => {
    const first = await externalizeSecrets(SETTINGS);
    const second = await externalizeSecrets(first.settings);
    assert.equal(second.settings.apiKey, 'vault:tui.apiKey');
    assert.deepEqual(second.stored, [], 'nothing new to store on the second save');
    assert.equal((await resolveSecrets(second.settings)).apiKey, SETTINGS.apiKey,
      'and the real key is still recoverable');
  });

  test('an empty key is skipped rather than stored as an empty secret', async () => {
    const { settings, stored } = await externalizeSecrets({ ...SETTINGS, apiKey: '', openrouterKey: '' });
    assert.deepEqual(stored, []);
    assert.equal(settings.apiKey, '');
  });
});

describe('migration from an existing plaintext file', () => {
  test('a legacy settings object migrates on first externalise', async () => {
    // Someone who has been running this for months has the key on disk right
    // now. Migration must not require them to re-enter it.
    const legacy = { model: 'x', apiKey: 'sk-legacy-plaintext-key-01234567' };
    const { settings } = await externalizeSecrets(legacy);
    assert.ok(isVaultRef(settings.apiKey));
    assert.equal((await resolveSecrets(settings)).apiKey, 'sk-legacy-plaintext-key-01234567');
  });

  test('a settings file with no references is returned unchanged by resolve', async () => {
    const plain = { model: 'x', apiKey: 'sk-still-plaintext-0123456789' };
    assert.equal(await resolveSecrets(plain), plain, 'no vault work when there is nothing to resolve');
  });
});

describe('failure behaviour', () => {
  test('a stale reference resolves to empty, never to the literal string', async () => {
    // Sending the string "vault:tui.apiKey" to a provider as a bearer token
    // would be a confusing 401 instead of an obvious "enter your key".
    const { settings } = await externalizeSecrets(SETTINGS);
    getVault().destroy();
    resetVault();

    const restored = await resolveSecrets(settings);
    assert.equal(restored.apiKey, '');
    assert.ok(!isVaultRef(restored.apiKey));
  });

  test('every secret-bearing settings key is covered', () => {
    // If a new credential field is added to the TUI, it belongs in one of these.
    assert.deepEqual([...SECRET_KEYS].sort(), ['apiKey', 'openrouterKey']);
    assert.deepEqual([...SECRET_JSON_KEYS].sort(), ['keyHistory']);
  });

  test('keyHistory is vaulted — it holds EVERY key the user ever pasted', async () => {
    // The leak I nearly shipped: I fixed the field I went looking for and left
    // a ten-entry archive of credentials sitting beside it. Caught only by
    // asserting on the whole file rather than on the field.
    const withHistory = {
      ...SETTINGS,
      keyHistory: [
        { provider: 'openai', key: 'sk-old-key-one-0123456789abcd', last4: 'abcd' },
        { provider: 'anthropic', key: 'sk-ant-old-key-two-9876543210', last4: '3210' },
      ],
    };
    const { settings, stored } = await externalizeSecrets(withHistory);

    assert.ok(stored.includes('keyHistory'));
    const serialized = JSON.stringify(settings);
    assert.ok(!serialized.includes('sk-old-key-one'), 'historic keys must not be on disk either');
    assert.ok(!serialized.includes('sk-ant-old-key-two'));

    const restored = await resolveSecrets(settings);
    assert.equal(restored.keyHistory.length, 2, 'and the history still works');
    assert.equal(restored.keyHistory[0].key, 'sk-old-key-one-0123456789abcd');
  });

  test('an empty history stays a plain empty array', async () => {
    const { settings } = await externalizeSecrets({ ...SETTINGS, keyHistory: [] });
    assert.deepEqual(settings.keyHistory, []);
  });

  test('an unresolvable history becomes empty, never a string', async () => {
    // The UI iterates this; handing it a raw "vault:tui.keyHistory" string
    // would throw somewhere far from here.
    const { settings } = await externalizeSecrets({ ...SETTINGS, keyHistory: [{ provider: 'x', key: 'sk-abcdefgh12345678', last4: '5678' }] });
    getVault().destroy();
    resetVault();
    const restored = await resolveSecrets(settings);
    assert.ok(Array.isArray(restored.keyHistory));
    assert.equal(restored.keyHistory.length, 0);
  });

  test('the secret is registered for redaction once vaulted', async () => {
    const { redactString } = await import('../src/learning/redactor.js');
    await externalizeSecrets(SETTINGS);
    assert.ok(!redactString(`key is ${SETTINGS.apiKey}`).includes(SETTINGS.apiKey),
      'a vaulted key must not be able to reach a log or the bus');
  });
});

describe('the settings file on disk', () => {
  test('a full write cycle leaves no credential material in the file', async () => {
    // The end-to-end version of the S1 criterion, for this specific file.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-tui-ws-'));
    try {
      const file = path.join(dir, 'tui-settings.json');
      const full = { ...SETTINGS, keyHistory: [{ provider: 'openai', key: 'sk-historic-key-0123456789', last4: '6789' }] };
      const { settings } = await externalizeSecrets(full);
      fs.writeFileSync(file, JSON.stringify(settings, null, 2), { mode: 0o600 });

      const onDisk = fs.readFileSync(file, 'utf-8');
      for (const secret of [SETTINGS.apiKey, SETTINGS.openrouterKey, 'sk-historic-key-0123456789']) {
        assert.ok(!onDisk.includes(secret), 'no credential may appear in tui-settings.json');
      }
      assert.ok(onDisk.includes('vault:tui.apiKey'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the vault is created lazily', () => {
  test('saving settings with no secrets does not create the vault at all', async () => {
    // Minting a master key (and on Windows, shelling out to PowerShell) to save
    // a theme preference is both slow and surprising. It also created
    // ~/.<brand>/ as a side effect, which is how four unrelated TUI tests
    // started writing into the developer's real home directory.
    const { settings, vaulted } = await externalizeSecrets({ model: 'x', theme: 'dark' });
    assert.equal(vaulted, false);
    assert.deepEqual(settings, { model: 'x', theme: 'dark' });
    assert.equal(fs.existsSync(path.join(tmpHome, 'vault')), false,
      'no vault directory should exist yet');
  });

  test('an empty key and an empty history do not trigger vault creation', async () => {
    await externalizeSecrets({ apiKey: '', openrouterKey: '', keyHistory: [] });
    assert.equal(fs.existsSync(path.join(tmpHome, 'vault')), false);
  });

  test('but a real secret does create it', async () => {
    await externalizeSecrets({ apiKey: 'sk-a-genuine-secret-0123456789' });
    assert.equal(fs.existsSync(path.join(tmpHome, 'vault')), true);
  });

  test('re-saving already-externalised settings does not reopen the vault', async () => {
    const { settings } = await externalizeSecrets({ apiKey: 'sk-a-genuine-secret-0123456789' });
    resetVault();
    fs.rmSync(path.join(tmpHome, 'vault'), { recursive: true, force: true });

    const again = await externalizeSecrets(settings);
    assert.equal(again.vaulted, false, 'references alone are not secrets to store');
    assert.equal(fs.existsSync(path.join(tmpHome, 'vault')), false);
  });
});
