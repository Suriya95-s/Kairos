import { execFileSync } from 'node:child_process';
import { getWorkspace } from '../../state.js';
import { ok, fail } from '../utils/toolResult.js';

export const definition = {
  type: 'function',
  function: {
    name: 'webfetch',
    description: 'Fetch the content of a URL using curl. Returns raw response body.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch' },
      },
      required: ['url'],
    },
  },
};

// SSRF defense: reject requests aimed at the loopback interface, the cloud
// metadata endpoint, or RFC1918 / link-local / ULA address space. Hostnames
// are matched literally; IP literals are range-checked. (Note: a hostname that
// resolves to an internal IP via DNS is not caught here — curl runs without
// -L so redirects are not followed, which removes the common rebinding pivot.)
function isBlockedHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === 'metadata.google.internal' || h.endsWith('.internal') || h.endsWith('.local')) return true;

  // IPv4 literal
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127) return true;          // this-host / private / loopback
    if (a === 169 && b === 254) return true;                    // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;           // private
    if (a === 192 && b === 168) return true;                    // private
    if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT
    return false;
  }

  // IPv6 literal
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return true;                 // loopback / unspecified
    if (h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd')) return true; // link-local / ULA
    if (h.startsWith('::ffff:')) {                              // IPv4-mapped
      return isBlockedHost(h.slice('::ffff:'.length));
    }
    return false;
  }

  return false;
}

export function handler({ url }) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return fail('Invalid URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return fail('Invalid URL. Only http/https are allowed.');
  }
  if (isBlockedHost(parsed.hostname)) {
    return fail(`Blocked: "${parsed.hostname}" targets a private/loopback/metadata address (SSRF protection).`);
  }

  try {
    const output = execFileSync(
      // No -L: redirects are not followed (closes the redirect-to-internal pivot).
      // --max-filesize caps the download so a huge body can't exhaust memory.
      'curl',
      ['-s', '--proto', '=http,https', '--max-filesize', '5242880', '--max-time', '15', url],
      {
        cwd: getWorkspace(),
        encoding: 'utf-8',
        timeout: 15000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    return ok(output);
  } catch (err) {
    return fail(`Fetch error: ${err.message}`);
  }
}
