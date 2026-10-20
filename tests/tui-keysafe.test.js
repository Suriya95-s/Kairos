// tests/tui-keysafe.test.js — F-4: safe multi-provider API-key entry.
import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROVIDER_PRESETS } from '../apps/tui/src/views/settings.js';
import { sanitizeArgsForAudit } from '../src/hitl/gateway.js';

describe('provider presets', () => {
  test('openai / anthropic prefill their public endpoints', () => {
    assert.equal(PROVIDER_PRESETS.openai, 'https://api.openai.com/v1');
    assert.equal(PROVIDER_PRESETS.anthropic, 'https://api.anthropic.com/v1');
  });
  test('custom leaves the URL untouched (null)', () => {
    assert.equal(PROVIDER_PRESETS.custom, null);
  });
});

describe('credential redaction in audit/SSE args', () => {
  test('key/token/secret-named args are redacted', () => {
    const out = sanitizeArgsForAudit({
      path: 'a.txt', api_key: 'sk-123', token: 'abc', AUTHORIZATION: 'Bearer x', password: 'p', normal: 'keep',
    });
    assert.equal(out.api_key, '[REDACTED]');
    assert.equal(out.token, '[REDACTED]');
    assert.equal(out.AUTHORIZATION, '[REDACTED]');
    assert.equal(out.password, '[REDACTED]');
    assert.equal(out.path, 'a.txt');      // ordinary args pass through
    assert.equal(out.normal, 'keep');
  });
  test('large content is still summarized, not dumped', () => {
    const out = sanitizeArgsForAudit({ content: 'x'.repeat(500) });
    assert.match(out.content, /\[\d+ chars\]/);
  });
  test('non-object args pass through untouched', () => {
    assert.equal(sanitizeArgsForAudit('plain'), 'plain');
    assert.equal(sanitizeArgsForAudit(null), null);
  });
});

describe('the settings file never holds the API key', () => {
  // This test used to assert mode 0600 and skip on Windows, where the mode is
  // reported as 666 no matter what is requested — which meant the one platform
  // that could not honour the protection was also the one that did not check
  // it. `chmod` was never the right mechanism; the key simply should not be in
  // this file. It now lives in the encrypted vault (S1) and the file holds a
  // `vault:tui.apiKey` reference, so this assertion works identically on every
  // platform and no longer skips.
  test('/apikey stores a vault reference, not the credential', async () => {
    // saveSettings resolves SETTINGS_PATH from cwd at import time, so chdir
    // before importing app.js.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keysafe-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keysafe-home-'));
    const orig = process.cwd();
    const savedHome = process.env.KAIROS_HOME;
    process.env.KAIROS_HOME = home;
    process.chdir(tmp);
    try {
      const { executeCmd } = await import('../apps/tui/src/app.js');
      await executeCmd('/apikey sk-secret-abcdefghijklmnop');

      // The write path is async now — it consults the vault before persisting,
      // so the file does not exist the instant executeCmd returns. Poll on the
      // CONTENT, not just the path: the fallback branch writes the file too, and
      // catching it mid-fallback would assert against the wrong version.
      const f = path.join(tmp, '.agent', 'tui-settings.json');
      // Generous budget: on Windows the vault shells out to PowerShell for
      // DPAPI, and execFileSync blocks the event loop for ~1s per round-trip —
      // twice on the very first key store. Real, but only on first use.
      let onDisk = '';
      for (let i = 0; i < 200; i++) {
        await new Promise(r => setTimeout(r, 50));
        if (!fs.existsSync(f)) continue;
        onDisk = fs.readFileSync(f, 'utf-8');
        if (onDisk.includes('vault:tui.apiKey')) break;
      }
      assert.ok(fs.existsSync(f), 'settings file written');

      assert.ok(!onDisk.includes('sk-secret-abcdefghijklmnop'),
        'the API key must not be readable from the settings file on any platform');
      assert.ok(onDisk.includes('vault:tui.apiKey'),
        'and it should be replaced by a reference, not merely dropped');
    } finally {
      process.chdir(orig);
      // KAIROS_HOME is deliberately NOT restored here. saveSettings' vault write
      // is fire-and-forget, so a later flush can land after this block runs —
      // and with the variable already restored it would write into the
      // developer's real ~/.kairos. (It did, once. The suite must never touch
      // anything outside a temp directory.) This file is its own process, so
      // leaving the override in place costs nothing.
      fs.rmSync(tmp, { recursive: true, force: true });
      // The home dir is left for the OS to reap: removing it while an async
      // vault write may still be in flight is the same race in reverse.
      void home;
      void savedHome;
    }
  });
});
