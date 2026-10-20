// src/learning/redactor.js
// Redaction pass per Q6: strip secrets before trace export.
// Covers API keys, bearer tokens, home paths, passwords, connection strings.
// Task 5.8

// ── Secret patterns ───────────────────────────────────────────────────────────
const REDACTION_RULES = [
  // OpenAI / Anthropic / generic API keys
  { pattern: /sk-[A-Za-z0-9]{20,}/g, replacement: '[REDACTED_API_KEY]' },
  // AWS access key IDs
  { pattern: /AKIA[A-Z0-9]{16}/g, replacement: '[REDACTED_AWS_KEY]' },
  // AWS secret access keys (40 chars base64-ish after a label)
  { pattern: /(?:aws_secret_access_key|secret_access_key)\s*[=:]\s*["']?[A-Za-z0-9/+]{40}["']?/gi, replacement: '[REDACTED_AWS_SECRET]' },
  // Bearer tokens
  { pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, replacement: 'Bearer [REDACTED_TOKEN]' },
  // Authorization header values
  { pattern: /(?:Authorization|X-Api-Key|X-Auth-Token)\s*[=:]\s*["']?[A-Za-z0-9\-._~+/]{8,}["']?/gi, replacement: '[REDACTED_AUTH_HEADER]' },
  // GitHub personal access tokens (ghp_, gho_, ghs_, etc.)
  { pattern: /gh[po_][A-Za-z0-9_]{36,}/g, replacement: '[REDACTED_GH_TOKEN]' },
  // Generic password patterns
  { pattern: /(?:password|passwd|secret|credential)\s*[=:]\s*["']?(?!\*{3})[^\s"',;]{4,}["']?/gi, replacement: '[REDACTED_PASSWORD]' },
  // Home directory paths (privacy)
  { pattern: /\/home\/[a-zA-Z0-9._-]+\//g, replacement: '/home/[USER]/' },
  { pattern: /\/Users\/[a-zA-Z0-9._-]+\//g, replacement: '/Users/[USER]/' },
  // Connection strings with passwords
  { pattern: /(?:postgresql|postgres|mysql|mongodb):\/\/[^@\s]*:[^@\s]*@/gi, replacement: '[REDACTED_DB_URL]@' },
  // Generic hex secrets (32+ hex chars preceded by key indicator)
  { pattern: /(?:key|secret|token|hash)\s*[=:]\s*["']?[0-9a-f]{32,}["']?/gi, replacement: '[REDACTED_HEX_SECRET]' },
  // JWT tokens (three base64url parts separated by dots)
  { pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, replacement: '[REDACTED_JWT]' },
];

// ── Known-value registry (S1) ────────────────────────────────────────────────
// The patterns above catch secrets that *look* like secrets. The vault knows
// which strings actually ARE secrets, and registers them here as it hands them
// out — so a credential with no recognisable shape (a bare password, a tenant
// id) still never reaches a journal, an SSE client, or LLM context.
const _knownSecrets = new Set();

/**
 * Register a literal secret value for exact-match redaction.
 * Short values are ignored: redacting every occurrence of a 4-character string
 * would mangle ordinary text far more often than it would protect anything.
 */
export function registerSecretValue(value) {
  if (typeof value === 'string' && value.length >= 8) _knownSecrets.add(value);
  return _knownSecrets.size;
}

/** Stop redacting a value (e.g. after a credential is rotated out). */
export function forgetSecretValue(value) {
  return _knownSecrets.delete(value);
}

/** Test-only: empty the registry. */
export function clearSecretRegistry() {
  _knownSecrets.clear();
}

/**
 * Redact a single string value.
 * @param {string} s
 * @returns {string}
 */
export function redactString(s) {
  if (!s || typeof s !== 'string') return s;
  let out = s;
  // Longest first: a short secret that is a substring of a longer one would
  // otherwise redact part of it and leave the rest exposed.
  if (_knownSecrets.size) {
    for (const secret of [..._knownSecrets].sort((a, b) => b.length - a.length)) {
      if (out.includes(secret)) out = out.split(secret).join('[REDACTED_SECRET]');
    }
  }
  for (const { pattern, replacement } of REDACTION_RULES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

// ── Key-name redaction ───────────────────────────────────────────────────────
// Value patterns catch credentials that LOOK like credentials. They miss a key
// whose shape is unusual — `sk-super-secret-0123` has hyphens, so the
// 20-consecutive-alphanumerics rule does not fire, and it sails through.
//
// A field literally named `token` is a credential regardless of what is in it,
// so structure is the stronger signal. Found by an audit-ledger test asserting
// that no credential reaches disk: the value-pattern pass alone let it through,
// and the same gap applied to every bus event, since the bus redacts with this
// same function.
const SECRET_KEY_RE =
  /^(?:.*[_-])?(api[_-]?key|apikey|key|token|secret|password|passwd|pwd|credential|auth|authorization|bearer|access[_-]?token|refresh[_-]?token|private[_-]?key|session[_-]?id)$/i;

/** Is this object key one whose value should never be written down? */
export function isSecretKey(name) {
  return SECRET_KEY_RE.test(String(name || ''));
}

/**
 * Deep-redact a value: by key name where the structure tells us, and by value
 * pattern everywhere else.
 *
 * Returns a new object — does not mutate input.
 * @param {object} trace
 * @returns {object}
 */
export function redactTrace(trace) {
  return _deepRedact(trace);
}

function _deepRedact(value) {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(_deepRedact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // Structure first. Over-redacting a field called "key" is the safe error;
      // under-redacting one called "token" is the unsafe one.
      out[k] = isSecretKey(k) && v ? '[REDACTED]' : _deepRedact(v);
    }
    return out;
  }
  return value;
}
