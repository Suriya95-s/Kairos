// src/mcp/configValidator.js
// Validates mcp-servers.json against the JSON schema without external deps.
// Produces line-numbered error messages so the user knows exactly what to fix.

import fs   from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// fileURLToPath — NOT `new URL(...).pathname`. On Windows the latter yields
// "/C:/Users/..." which path.join turns into "C:\C:\Users\..." and every read
// fails with ENOENT. Same rule applies anywhere a module resolves its own dir.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, 'config-schema.json'), 'utf-8'));

/**
 * Validate a parsed config object against the schema.
 * Returns an array of error strings (empty = valid).
 * Minimal validation — covers the fields users are most likely to misconfigure.
 *
 * @param {unknown} config
 * @returns {string[]}
 */
export function validateConfig(cfg) {
  const errors = [];

  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return ['Root must be an object with a "servers" key.'];
  }

  if (!Array.isArray(cfg.servers)) {
    errors.push('"servers" must be an array.');
    return errors;
  }

  const names = new Set();
  cfg.servers.forEach((srv, i) => {
    const loc = `servers[${i}]`;
    if (!srv || typeof srv !== 'object') { errors.push(`${loc}: must be an object`); return; }

    if (!srv.name || typeof srv.name !== 'string') {
      errors.push(`${loc}: "name" is required and must be a string`);
    } else if (!/^[a-z][a-z0-9_-]*$/.test(srv.name)) {
      errors.push(`${loc}: "name" must match ^[a-z][a-z0-9_-]*$ (got "${srv.name}")`);
    } else if (names.has(srv.name)) {
      errors.push(`${loc}: duplicate server name "${srv.name}"`);
    } else {
      names.add(srv.name);
    }

    if (!['stdio', 'http', 'sse'].includes(srv.transport)) {
      errors.push(`${loc}: "transport" must be one of stdio, http, sse (got "${srv.transport}")`);
    }

    if (srv.transport === 'stdio' && !srv.command) {
      errors.push(`${loc}: stdio transport requires "command"`);
    }
    if ((srv.transport === 'http' || srv.transport === 'sse') && !srv.url) {
      errors.push(`${loc}: http/sse transport requires "url"`);
    }

    const extraKeys = Object.keys(srv).filter(k =>
      !['name','transport','command','args','env','url','headers','disabled','autoApprove','requireApproval'].includes(k)
    );
    if (extraKeys.length > 0) {
      errors.push(`${loc}: unknown keys: ${extraKeys.join(', ')}`);
    }
  });

  return errors;
}

/**
 * Load and validate an mcp-servers config file.
 * @param {string} filePath
 * @returns {{ config: object|null, errors: string[] }}
 */
export function loadAndValidate(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    return { config: null, errors: [`Cannot read ${filePath}: ${err.message}`] };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Provide approximate line number from SyntaxError message
    const lineMatch = err.message.match(/line (\d+)/i);
    const lineHint  = lineMatch ? ` (line ${lineMatch[1]})` : '';
    return { config: null, errors: [`JSON parse error${lineHint}: ${err.message}`] };
  }

  const errors = validateConfig(parsed);
  return { config: errors.length === 0 ? parsed : null, errors };
}
