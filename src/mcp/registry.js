// src/mcp/registry.js
// Aggregates tools from all connected MCP servers.
// Names are prefixed <server>__<tool> to prevent collisions with built-in tools.
// Refreshed on connect/reconnect; read-only from the router's perspective.

import { getHealthyClients, loadServerConfigsSync } from './connectionManager.js';
import { adaptServerTools, parsePrefixedName } from './toolAdapter.js';
import { definition as promptDef, handler as promptHandler } from './promptLibrary.js';
import { definition as resourceDef, handler as resourceHandler } from './resourceFetcher.js';

/** @type {Map<string, object>} prefixedName → adapted tool entry */
import { buildRegistry as buildTierRegistry } from '../trust/tiers.js';

let _mcpTools = new Map();

// Wave D-5: server-agnostic MCP meta-tools. Unlike `<server>__<tool>` entries,
// these work across all healthy servers (list/get prompts, read resources).
// Previously implemented but never registered — now wired here.
const _metaTools = {
  [promptDef.function.name]:   { definition: promptDef,   handler: promptHandler },
  [resourceDef.function.name]: { definition: resourceDef, handler: resourceHandler },
};

/** Return the OpenAI-style definitions for the MCP meta-tools. */
export function getMcpMetaToolDefinitions() {
  return Object.values(_metaTools).map(t => t.definition);
}

/** True if `name` is one of the MCP meta-tools (get_mcp_prompt / read_resource). */
export function isMcpMetaToolName(name) {
  return Object.prototype.hasOwnProperty.call(_metaTools, name);
}

/** Execute an MCP meta-tool. Returns { result, error }. */
export async function executeMcpMetaTool(name, args) {
  const tool = _metaTools[name];
  if (!tool) return { result: `Unknown MCP meta-tool: ${name}`, error: true };
  try {
    const result = await tool.handler(args || {});
    const s = typeof result === 'string' ? result : String(result);
    const isErr = /^(Failed|Invalid|Resource not found|MCP server)/.test(s);
    return { result: s, error: isErr };
  } catch (err) {
    return { result: `MCP meta-tool "${name}" failed: ${err.message}`, error: true };
  }
}

/**
 * Rebuild the MCP tool map from all currently-healthy clients.
 * Called after every connect/reconnect event.
 * @param {string} workspaceRoot — used to read per-server autoApprove lists
 */
export async function refreshRegistry(workspaceRoot) {
  const next = new Map();
  const clients = getHealthyClients(); // [[name, client], ...]
  const configs = loadServerConfigsSync(workspaceRoot);
  const cfgByName = Object.fromEntries(configs.map(c => [c.name, c]));

  await Promise.allSettled(
    clients.map(async ([serverName, client]) => {
      try {
        const mcpTools = await client.listTools();
        const cfg = cfgByName[serverName] ?? {};
        const adapted = adaptServerTools(
          serverName, mcpTools,
          cfg.autoApprove ?? [],
          cfg.requireApproval ?? [],
        );
        for (const entry of adapted) {
          // Classify at registration (7.1). A server's own autoApprove list is
          // a request, not a decision: buildRegistry raises a declared tier to
          // the inferred one but never lowers it, so a server cannot mark its
          // own `delete_everything` tool safe.
          const declared = (cfg.autoApprove ?? []).includes(entry.rawName ?? entry.name) ? 'T1' : null;
          const tiers = buildTierRegistry({ [entry.name]: declared });
          entry.tier = tiers[entry.name];
          next.set(entry.name, entry);
        }
      } catch (err) {
        console.error(`[mcp-registry] Failed to list tools from ${serverName}: ${err.message}`);
      }
    })
  );

  _mcpTools = next;
  return next.size;
}

/** Return all adapted MCP tool entries as a flat array. */
export function getAllMcpTools() {
  return [..._mcpTools.values()];
}

/** Return all MCP tool definitions (OpenAI-style) for context injection. */
export function getAllMcpDefinitions() {
  return [..._mcpTools.values()].map(e => e.definition);
}

/** Return a single MCP tool entry by prefixed name, or null. */
export function getMcpToolEntry(prefixedName) {
  return _mcpTools.get(prefixedName) ?? null;
}

/** Return true if the name looks like an MCP tool (contains __). */
export function isMcpToolName(name) {
  return typeof name === 'string' && name.includes('__') && parsePrefixedName(name) !== null;
}

/** Execute an MCP tool by its prefixed name. Returns { result, error }. */
export async function executeMcpTool(prefixedName, args) {
  const entry = _mcpTools.get(prefixedName);
  if (!entry) return { result: `Unknown MCP tool: ${prefixedName}`, error: true };
  try {
    const result = await entry.handler(args);
    const isErr = typeof result === 'string' && result.startsWith('MCP');
    return { result, error: isErr };
  } catch (err) {
    return { result: `MCP tool execution failed: ${err.message}`, error: true };
  }
}

/** Return count of registered MCP tools. */
export function getMcpToolCount() {
  return _mcpTools.size;
}

/** For checkpoint: return server→toolCount map. */
export function getMcpToolSummary() {
  const summary = {};
  for (const entry of _mcpTools.values()) {
    summary[entry.serverName] = (summary[entry.serverName] || 0) + 1;
  }
  return summary;
}
