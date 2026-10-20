// src/mcp/resourceFetcher.js
// Exposes MCP resources as a Kairos tool: read_resource.
// Resources are read-only data exposed by MCP servers (files, DB rows, etc.)

import { getHealthyClients } from './connectionManager.js';

/**
 * List all resources available across connected MCP servers.
 * Returns [{ serverName, uri, name, mimeType, description }]
 */
export async function listAllResources() {
  const all = [];
  for (const [serverName, client] of getHealthyClients()) {
    try {
      const resources = await client.listResources();
      for (const r of resources) {
        all.push({ serverName, uri: r.uri, name: r.name, mimeType: r.mimeType, description: r.description });
      }
    } catch { /* server may not support resources */ }
  }
  return all;
}

/**
 * Read a resource by URI. Searches all connected servers.
 * URI prefix can be used to target a specific server: "server://..."
 * @param {string} uri
 * @returns {Promise<string>} rendered text content
 */
export async function readResource(uri) {
  for (const [serverName, client] of getHealthyClients()) {
    try {
      const res = await client.readResource(uri);
      if (!res) continue;
      const parts = (res.contents ?? []).map(c => {
        if (c.text !== undefined) return c.text;
        if (c.blob !== undefined) return `[binary blob: ${c.mimeType ?? 'unknown'}]`;
        return JSON.stringify(c);
      });
      if (parts.length > 0) return parts.join('\n');
    } catch { /* this server doesn't have it */ }
  }
  return `Resource not found: ${uri}`;
}

// ── Kairos tool definition ─────────────────────────────────────────────────────

export const definition = {
  type: 'function',
  function: {
    name: 'read_resource',
    description: 'Read a resource from an MCP server (file, database row, API data, etc.) by URI.',
    parameters: {
      type: 'object',
      properties: {
        uri:    { type: 'string', description: 'Resource URI (e.g. "file:///path/to/file", "postgres://table/row/1")' },
        list:   { type: 'boolean', description: 'If true, list available resources instead of reading one', default: false },
      },
      required: ['uri'],
    },
  },
};

export async function handler({ uri, list = false }) {
  if (list) {
    const resources = await listAllResources();
    if (resources.length === 0) return 'No MCP resources available.';
    return resources.map(r => `${r.serverName}: ${r.uri}${r.description ? ` — ${r.description}` : ''}`).join('\n');
  }
  return readResource(uri);
}
