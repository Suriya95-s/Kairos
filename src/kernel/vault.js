// src/kernel/vault.js
// Secrets & credential vault (S1).
//
// The daemon holds API keys today and, after P7, OAuth tokens for email and
// calendar — the most sensitive data in the system. One accessor, one file,
// encrypted at rest.
//
// Key handling, in order of preference:
//   1. OS credential store for the MASTER KEY — DPAPI on Windows (via
//      PowerShell's ConvertFrom-SecureString), Keychain on macOS (`security`),
//      libsecret on Linux (`secret-tool`). No native modules: this project is
//      zero-dependency and stays that way.
//   2. A 0600 key file, if no OS store is reachable.
//
// Option 2 is honestly labelled `unprotected` rather than quietly pretending.
// A key sitting next to the data it encrypts protects against a stray `cat` and
// against nothing else, and a vault that overstates its own guarantees is worse
// than one that admits them — the user decides what to store based on what we
// claim. `status()` surfaces the backend and every client shows it.
//
// The payload itself is AES-256-GCM: authenticated, so a tampered vault fails
// loudly instead of decrypting to garbage.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { BRAND, dir as kernelDir, ensureHome, readRegistry, writeRegistry, SCHEMA_VERSION } from './paths.js';
import { registerSecretValue, forgetSecretValue } from '../learning/redactor.js';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const ACCOUNT = `${BRAND}-vault-master`;

/** Where the encrypted blob and the fallback key live. */
export function vaultFile() { return path.join(kernelDir('vault'), 'secrets.enc'); }
export function keyFile()   { return path.join(kernelDir('vault'), 'master.key'); }
export function metaFile()  { return path.join(kernelDir('vault'), 'meta.json'); }

// ── OS credential-store backends ────────────────────────────────────────────

function run(cmd, args, input = null) {
  return execFileSync(cmd, args, {
    input: input ?? undefined,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10_000,
    windowsHide: true,
  });
}

const BACKENDS = {
  // DPAPI, user-scoped. The ciphertext is only decryptable by this Windows user
  // on this machine, which is exactly the guarantee we want for a local daemon.
  dpapi: {
    available() {
      if (process.platform !== 'win32') return false;
      try { run('powershell', ['-NoProfile', '-Command', 'exit 0']); return true; } catch { return false; }
    },
    store(secretHex) {
      const out = run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `$s = Read-Host -AsSecureString; ConvertFrom-SecureString -SecureString $s`], `${secretHex}\n`);
      return out.trim();
    },
    load(blob) {
      const out = run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `$sec = '${blob}' | ConvertTo-SecureString; ` +
        `[Runtime.InteropServices.Marshal]::PtrToStringAuto(` +
        `[Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))`]);
      return out.trim();
    },
  },

  keychain: {
    available() {
      if (process.platform !== 'darwin') return false;
      try { run('security', ['-h']); return true; } catch { return false; }
    },
    store(secretHex) {
      try { run('security', ['delete-generic-password', '-a', ACCOUNT, '-s', ACCOUNT]); } catch { /* absent */ }
      run('security', ['add-generic-password', '-a', ACCOUNT, '-s', ACCOUNT, '-w', secretHex]);
      return ACCOUNT;
    },
    load() {
      return run('security', ['find-generic-password', '-a', ACCOUNT, '-s', ACCOUNT, '-w']).trim();
    },
  },

  libsecret: {
    available() {
      if (process.platform === 'win32' || process.platform === 'darwin') return false;
      try { run('secret-tool', ['--version']); return true; } catch { return false; }
    },
    store(secretHex) {
      run('secret-tool', ['store', '--label', `${BRAND} vault master key`, 'service', ACCOUNT], `${secretHex}\n`);
      return ACCOUNT;
    },
    load() {
      return run('secret-tool', ['lookup', 'service', ACCOUNT]).trim();
    },
  },
};

/** First usable OS backend for this platform, or null. */
export function detectBackend() {
  for (const [name, backend] of Object.entries(BACKENDS)) {
    try { if (backend.available()) return name; } catch { /* try the next */ }
  }
  return null;
}

// ── Vault ───────────────────────────────────────────────────────────────────

export class Vault {
  /**
   * @param {object}  [opts]
   * @param {string}  [opts.backend]  force a backend name, or 'file' to skip the OS store
   * @param {boolean} [opts.autoCreate]
   */
  constructor({ backend = undefined, autoCreate = true } = {}) {
    this._forcedBackend = backend;
    this._autoCreate = autoCreate;
    this._key = null;
    this._backend = null;
    this._secrets = null;
  }

  /** Which key backend is in use, and whether it is actually protecting anything. */
  status() {
    this._ensureKey();
    return {
      backend: this._backend,
      protected: this._backend !== 'file',
      path: vaultFile(),
      entries: Object.keys(this._load()).length,
      // Said plainly so a client can warn rather than imply safety we don't have.
      warning: this._backend === 'file'
        ? 'no OS credential store available — the master key sits beside the vault at 0600; treat this host as trusted'
        : null,
    };
  }

  _ensureKey() {
    if (this._key) return this._key;
    ensureHome();
    fs.mkdirSync(kernelDir('vault'), { recursive: true });

    const meta = readRegistry(metaFile(), null);
    const wanted = this._forcedBackend ?? meta?.backend ?? detectBackend() ?? 'file';

    if (wanted !== 'file' && BACKENDS[wanted]) {
      try {
        this._key = Buffer.from(this._loadOsKey(wanted, meta), 'hex');
        this._backend = wanted;
        if (this._key.length === KEY_BYTES) return this._key;
      } catch {
        // A keychain that was available at store time can be locked or missing
        // now. Falling back silently would decrypt nothing and look like data
        // loss, so surface it by degrading to the file backend explicitly.
        this._key = null;
      }
    }

    this._backend = 'file';
    this._key = this._loadFileKey();
    return this._key;
  }

  _loadOsKey(name, meta) {
    const backend = BACKENDS[name];
    if (meta?.blob || name !== 'dpapi') {
      const hex = name === 'dpapi' ? backend.load(meta.blob) : backend.load();
      if (hex) return hex;
    }
    if (!this._autoCreate) throw new Error('no master key in the OS credential store');

    const fresh = crypto.randomBytes(KEY_BYTES).toString('hex');
    const blob = backend.store(fresh);
    writeRegistry(metaFile(), { schemaVersion: SCHEMA_VERSION, backend: name, blob: name === 'dpapi' ? blob : null });
    return fresh;
  }

  _loadFileKey() {
    const p = keyFile();
    try {
      const hex = fs.readFileSync(p, 'utf-8').trim();
      const buf = Buffer.from(hex, 'hex');
      if (buf.length === KEY_BYTES) return buf;
    } catch { /* create below */ }

    if (!this._autoCreate) throw new Error('vault master key is missing');
    const fresh = crypto.randomBytes(KEY_BYTES);
    fs.writeFileSync(p, fresh.toString('hex'), { encoding: 'utf-8', mode: 0o600 });
    try { fs.chmodSync(p, 0o600); } catch { /* non-POSIX */ }
    writeRegistry(metaFile(), { schemaVersion: SCHEMA_VERSION, backend: 'file', blob: null });
    return fresh;
  }

  // ── Storage ─────────────────────────────────────────────────────────────

  _load() {
    if (this._secrets) return this._secrets;
    const key = this._ensureKey();
    let raw;
    try { raw = fs.readFileSync(vaultFile()); } catch { this._secrets = {}; return this._secrets; }

    try {
      const iv = raw.subarray(0, IV_BYTES);
      const tag = raw.subarray(IV_BYTES, IV_BYTES + 16);
      const body = raw.subarray(IV_BYTES + 16);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf-8');
      this._secrets = JSON.parse(plain);
    } catch (err) {
      // GCM authentication failed: either the wrong key or a tampered file.
      // Refuse loudly. Silently starting empty would look like "your
      // integrations were de-authorized" and invite the user to re-enter every
      // credential into a vault that may be under someone else's control.
      throw new Error(
        `vault could not be decrypted (${err.message}). ` +
        `The master key may have changed, or ${vaultFile()} was modified. ` +
        `Delete the vault to start over — every integration will need re-authorizing.`
      );
    }
    // Everything we hold is, by definition, a secret worth keeping out of logs.
    for (const scope of Object.values(this._secrets)) {
      for (const value of Object.values(scope)) registerSecretValue(value);
    }
    return this._secrets;
  }

  _persist() {
    const key = this._ensureKey();
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([
      cipher.update(JSON.stringify(this._secrets ?? {}), 'utf-8'),
      cipher.final(),
    ]);
    const out = Buffer.concat([iv, cipher.getAuthTag(), body]);

    fs.mkdirSync(path.dirname(vaultFile()), { recursive: true });
    const tmp = `${vaultFile()}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, out, { mode: 0o600 });
    fs.renameSync(tmp, vaultFile());
    try { fs.chmodSync(vaultFile(), 0o600); } catch { /* non-POSIX */ }
  }

  // ── Accessor API ────────────────────────────────────────────────────────

  /**
   * The single credential accessor. Nothing else in the codebase may read a
   * credential from env or file directly (see the lint check in the tests).
   */
  get(scope, key) {
    const all = this._load();
    return all[scope]?.[key] ?? null;
  }

  set(scope, key, value) {
    if (typeof value !== 'string' || !value) throw new Error('a secret must be a non-empty string');
    const all = this._load();
    all[scope] = all[scope] || {};
    all[scope][key] = value;
    registerSecretValue(value);
    this._persist();
    return true;
  }

  delete(scope, key) {
    const all = this._load();
    const value = all[scope]?.[key];
    if (value === undefined) return false;
    forgetSecretValue(value);
    delete all[scope][key];
    if (Object.keys(all[scope]).length === 0) delete all[scope];
    this._persist();
    return true;
  }

  /** Scope/key names only — never values. Safe to log, safe to send to a client. */
  list() {
    const all = this._load();
    const out = {};
    for (const [scope, entries] of Object.entries(all)) out[scope] = Object.keys(entries).sort();
    return out;
  }

  has(scope, key) { return this.get(scope, key) != null; }

  /**
   * Delete the vault and its key. Per the S1 acceptance criterion this cleanly
   * de-authorizes every integration.
   */
  destroy() {
    const all = this._secrets || {};
    for (const scope of Object.values(all)) {
      for (const value of Object.values(scope)) forgetSecretValue(value);
    }
    for (const f of [vaultFile(), keyFile(), metaFile()]) {
      try { fs.rmSync(f); } catch { /* already gone */ }
    }
    this._secrets = null;
    this._key = null;
    return true;
  }

  /**
   * Resolve a `vault:scope.key` reference. Config files (mcp-servers.json) hold
   * these instead of literals, so they stay committable.
   * Non-references pass through unchanged.
   */
  resolve(value) {
    if (typeof value !== 'string' || !value.startsWith('vault:')) return value;
    const ref = value.slice('vault:'.length);
    const dot = ref.indexOf('.');
    const [scope, key] = dot === -1 ? ['default', ref] : [ref.slice(0, dot), ref.slice(dot + 1)];
    const got = this.get(scope, key);
    if (got == null) throw new Error(`vault reference "${value}" is not set — add it with: ${BRAND} secret set ${scope} ${key}`);
    return got;
  }

  /** Deep-resolve every `vault:` reference in a config object. */
  resolveConfig(node) {
    if (typeof node === 'string') return this.resolve(node);
    if (Array.isArray(node)) return node.map(n => this.resolveConfig(n));
    if (node && typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) out[k] = this.resolveConfig(v);
      return out;
    }
    return node;
  }

  /**
   * Bootstrap-only migration: move credentials that arrived via environment
   * variables into the vault on first daemon start. Env stays a valid *source*,
   * never a storage location.
   * @returns {string[]} keys imported
   */
  migrateFromEnv(env = process.env, { scope = 'llm' } = {}) {
    const CANDIDATES = ['AGENT_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];
    const imported = [];
    for (const name of CANDIDATES) {
      const value = env[name];
      // Local-inference placeholders ("ollama", "lm-studio") are not secrets and
      // storing them just makes the vault noisy.
      if (!value || value.length < 8) continue;
      if (this.has(scope, name)) continue;
      this.set(scope, name, value);
      imported.push(name);
    }
    return imported;
  }
}

/** Process-wide vault, reset-able for tests (no import-time singletons). */
let _vault = null;

export function getVault(opts) {
  if (!_vault) _vault = new Vault(opts);
  return _vault;
}

export function resetVault() {
  _vault = null;
}
