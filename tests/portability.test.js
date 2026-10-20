// tests/portability.test.js
// Guards against cross-platform regressions. Kairos is becoming resident
// infrastructure (see JARVIS_EVOLUTION_PLAN.md Phase 0), so "works on Linux"
// is no longer sufficient — it must be green on the machine it lives on.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));

/** Recursively collect .js files under a directory, skipping node_modules. */
function collectJs(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJs(full, acc);
    else if (entry.name.endsWith('.js')) acc.push(full);
  }
  return acc;
}

describe('Portability guards', () => {
  test('no module resolves its own path via new URL(...).pathname', () => {
    // On Windows `new URL(import.meta.url).pathname` yields "/C:/Users/..."; a
    // subsequent path.join produces "C:\C:\Users\..." and every read ENOENTs.
    // fileURLToPath() is the only correct conversion. This bug shipped twice
    // (src/mcp/configValidator.js, src/agents/agentRunner.js) — hence the guard.
    const offenders = [];
    for (const file of [...collectJs(path.join(ROOT, 'src')), ...collectJs(path.join(ROOT, 'apps'))]) {
      const src = fs.readFileSync(file, 'utf-8');
      src.split('\n').forEach((line, i) => {
        if (line.trim().startsWith('//')) return;
        // Match `new URL(<anything involving import.meta.url>)...pathname`
        if (/new URL\([^)]*import\.meta\.url[^)]*\)[\s\S]{0,40}?\.pathname/.test(line)) {
          offenders.push(`${path.relative(ROOT, file)}:${i + 1}`);
        }
      });
    }
    assert.deepEqual(
      offenders, [],
      `Use fileURLToPath(import.meta.url) instead of .pathname — breaks on Windows.\nOffenders:\n  ${offenders.join('\n  ')}`
    );
  });

  test('the MCP config schema actually loads on this platform', async () => {
    // Direct regression test for the configValidator path bug: importing the
    // module performs a readFileSync at module scope, so a bad path throws here.
    const mod = await import('../src/mcp/configValidator.js');
    assert.equal(typeof mod.validateConfig, 'function');
  });

  test('every specialist role has a loadable identity overlay', () => {
    // Regression test for the agentRunner overlay path bug. A wrong path did not
    // throw — fs.existsSync() simply returned false and each specialist silently
    // lost its identity block, which is far worse than a crash.
    const overlayDir = path.join(ROOT, 'src', 'agents', 'identity-overlays');
    const roles = ['conductor', 'scout', 'planner', 'coder', 'reviewer', 'archivist'];
    for (const role of roles) {
      const viaFileUrl = fileURLToPath(new URL(`../src/agents/identity-overlays/${role}.md`, import.meta.url));
      assert.ok(fs.existsSync(viaFileUrl), `overlay missing or unresolvable: ${role}`);
      assert.ok(fs.readFileSync(viaFileUrl, 'utf-8').length > 0, `overlay empty: ${role}`);
    }
    assert.ok(fs.existsSync(overlayDir));
  });

  test('tests do not hardcode a bare python3 invocation for execution', () => {
    // `python3` does not exist on stock Windows (Store alias stub). Tests that
    // actually execute Python must go through tests/helpers/python.js.
    const testDir = path.join(ROOT, 'tests');
    const offenders = [];
    for (const file of collectJs(testDir)) {
      if (file.endsWith('portability.test.js') || file.includes('helpers')) continue;
      const src = fs.readFileSync(file, 'utf-8');
      src.split('\n').forEach((line, i) => {
        // Only flag lines that actually run a command, not string fixtures.
        if (/executeRegistryTool\(\s*['"]run_command['"]/.test(line) && /python3/.test(line)) {
          offenders.push(`${path.relative(ROOT, file)}:${i + 1}`);
        }
      });
    }
    assert.deepEqual(
      offenders, [],
      `Use pythonBin() from tests/helpers/python.js.\nOffenders:\n  ${offenders.join('\n  ')}`
    );
  });
});

describe('tests never write outside a temp directory', () => {
  test('every test that can trigger a vault write isolates KAIROS_HOME', () => {
    // The vault lives under KAIROS_HOME, which defaults to the developer's real
    // ~/.kairos. A test that stores a credential without overriding it writes an
    // encrypted store into their home directory — which four TUI tests silently
    // started doing the moment the TUI's API key moved into the vault.
    //
    // Source-scan rather than runtime detection: by the time a stray write is
    // observable the damage is done, and the async write can land after the
    // test that caused it has finished.
    const testsDir = new URL('./', import.meta.url);
    const offenders = [];

    for (const name of fs.readdirSync(testsDir)) {
      if (!name.endsWith('.test.js')) continue;
      const src = fs.readFileSync(new URL(name, testsDir), 'utf-8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

      // Only files that can actually STORE a credential open a vault — the
      // vault is created lazily, so merely importing app.js is harmless. The
      // risk is a direct vault import, or driving the TUI's key commands.
      const storesCredential =
        /from '\.\.\/src\/kernel\/vault\.js'/.test(code) ||
        /settingsSecrets\.js'/.test(code) ||
        /executeCmd\(\s*['\`]\/(key|apikey)/i.test(code);
      if (!storesCredential) continue;

      if (!/KAIROS_HOME/.test(code)) offenders.push(name);
    }

    assert.deepEqual(offenders, [],
      'these tests can write a vault into the real home; set process.env.KAIROS_HOME');
  });
});
