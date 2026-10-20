// apps/tui/src/settingsSecrets.js
// Keep API keys out of .agent/tui-settings.json (S1).
//
// This closes the oldest live finding in the project, first recorded in Phase 0:
// the TUI writes its settings with mode 0600, Windows reports that file as 666,
// and the API key sat in it in plaintext. `chmod` is not a security mechanism on
// NTFS, so the fix is not a better mode — it is not storing the secret there.
//
// The settings file keeps everything else and holds `vault:tui.apiKey` in place
// of the value. That also makes it safe to copy between machines, and safe to
// paste into a bug report.
//
// Degradation is deliberate: if the vault cannot be opened the TUI keeps
// working with the old plaintext behaviour rather than locking the user out of
// their own settings. It says so, rather than pretending.

/** Settings fields whose value is a bare credential string. */
const SECRET_KEYS = Object.freeze(['apiKey', 'openrouterKey']);

/**
 * Fields that are structured but still full of credentials.
 *
 * `keyHistory` is `[{provider, key, last4}]` — up to ten complete API keys, and
 * a strictly worse leak than the single `apiKey` field, since it accumulates
 * every key the user has ever pasted in. Found only by asserting that the
 * written file contains no credential material, rather than checking the one
 * field I had gone looking for.
 */
const SECRET_JSON_KEYS = Object.freeze(['keyHistory']);

const VAULT_SCOPE = 'tui';

async function openVault() {
  try {
    const { getVault } = await import('../../../src/kernel/vault.js');
    const vault = getVault();
    vault.status();           // forces key setup; throws here if unavailable
    return vault;
  } catch {
    return null;
  }
}

/**
 * Move secrets out of a settings object and into the vault.
 *
 * @param {object} settings  the object about to be written to disk
 * @returns {Promise<{settings: object, stored: string[], vaulted: boolean}>}
 *          a COPY safe to persist, with references in place of values
 */
export async function externalizeSecrets(settings) {
  // Open the vault only when there is genuinely something to put in it.
  // Creating one is not free: it mints a master key and, on Windows, shells out
  // to PowerShell for DPAPI. Saving a theme preference must not do that — and
  // must not create ~/.<brand>/ as a side effect either, which is exactly how
  // four unrelated TUI tests started writing into the developer's home.
  const hasSecret =
    SECRET_KEYS.some(k => typeof settings?.[k] === 'string' && settings[k] && !isVaultRef(settings[k]))
    || SECRET_JSON_KEYS.some(k => Array.isArray(settings?.[k]) && settings[k].length > 0);
  if (!hasSecret) return { settings, stored: [], vaulted: false };

  const vault = await openVault();
  if (!vault) return { settings, stored: [], vaulted: false };

  const out = { ...settings };
  const stored = [];
  for (const key of SECRET_KEYS) {
    const value = settings[key];
    if (!value || typeof value !== 'string') continue;
    // Already a reference from a previous save — nothing to do.
    if (value.startsWith('vault:')) continue;
    try {
      vault.set(VAULT_SCOPE, key, value);
      out[key] = `vault:${VAULT_SCOPE}.${key}`;
      stored.push(key);
    } catch {
      // Leave the literal in place rather than dropping the user's key on the
      // floor. Losing a credential silently is worse than storing it poorly.
    }
  }

  for (const key of SECRET_JSON_KEYS) {
    const value = settings[key];
    if (isVaultRef(value)) continue;
    // An empty history is not worth a vault entry, and writing `[]` plainly
    // keeps the file readable.
    if (!Array.isArray(value) || value.length === 0) continue;
    try {
      vault.set(VAULT_SCOPE, key, JSON.stringify(value));
      out[key] = `vault:${VAULT_SCOPE}.${key}`;
      stored.push(key);
    } catch { /* keep the literal rather than lose it */ }
  }

  return { settings: out, stored, vaulted: true };
}

/**
 * Resolve `vault:` references back to real values for use in memory.
 * Unresolvable references become empty strings — a stale reference should
 * prompt "enter your key" rather than send the literal string "vault:tui.apiKey"
 * to a provider as a bearer token.
 */
export async function resolveSecrets(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  const allKeys = [...SECRET_KEYS, ...SECRET_JSON_KEYS];
  const needs = allKeys.some(k => isVaultRef(settings[k]));
  if (!needs) return settings;

  const vault = await openVault();
  const out = { ...settings };

  for (const key of SECRET_KEYS) {
    if (!isVaultRef(settings[key])) continue;
    try {
      out[key] = vault ? vault.resolve(settings[key]) : '';
    } catch {
      out[key] = '';
    }
  }

  for (const key of SECRET_JSON_KEYS) {
    if (!isVaultRef(settings[key])) continue;
    try {
      out[key] = vault ? JSON.parse(vault.resolve(settings[key])) : [];
    } catch {
      // A stale or unparseable reference becomes an empty history rather than
      // a string the UI would try to iterate.
      out[key] = [];
    }
  }

  return out;
}

/** True when a value is a reference rather than a credential. */
export function isVaultRef(value) {
  return typeof value === 'string' && value.startsWith('vault:');
}

export { SECRET_KEYS, SECRET_JSON_KEYS, VAULT_SCOPE };
