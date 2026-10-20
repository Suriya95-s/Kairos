// src/mcp/toolAdapter.js
// Converts MCP tool definitions into Kairos tool definition + handler pairs.
// The name is prefixed <serverName>__<toolName> to prevent collisions.

import { getClient } from './connectionManager.js';

/**
 * Build the Kairos tool name from server + MCP tool name.
 * e.g. "github" + "search_repositories" → "github__search_repositories"
 */
export function buildPrefixedName(serverName, mcpToolName) {
  return `${serverName}__${mcpToolName}`;
}

/**
 * Reverse: split a prefixed name into [serverName, toolName].
 * Returns null if not a valid prefixed name.
 */
export function parsePrefixedName(prefixedName) {
  const idx = prefixedName.indexOf('__');
  if (idx < 1) return null;
  return [prefixedName.slice(0, idx), prefixedName.slice(idx + 2)];
}

/**
 * Adapt an MCP tool definition to a Kairos-compatible tool entry.
 *
 * @param {string} serverName
 * @param {{ name: string, description?: string, inputSchema?: object }} mcpTool
 * @param {string[]} autoApprove  — tool names (MCP) that don't need HITL approval
 * @param {string[]} requireApproval — tool names (MCP) that always need HITL approval
 * @returns {{ name: string, definition: object, handler: Function, priority: number, serverName: string, mcpName: string, autoApprove: boolean }}
 */
export function adaptTool(serverName, mcpTool, autoApprove = [], requireApproval = []) {
  const prefixedName = buildPrefixedName(serverName, mcpTool.name);

  // Translate MCP inputSchema → OpenAI-style function parameters
  const parameters = mcpTool.inputSchema ?? {
    type: 'object',
    properties: {},
    required: [],
  };

  const definition = {
    type: 'function',
    function: {
      name: prefixedName,
      description: `[MCP:${serverName}] ${mcpTool.description || mcpTool.name}`,
      parameters,
    },
  };

  const isAutoApprove    = autoApprove.includes(mcpTool.name) || autoApprove.includes('*');
  const isRequireApproval = requireApproval.includes(mcpTool.name);

  async function handler(args) {
    const client = getClient(serverName);
    if (!client) {
      return `MCP server "${serverName}" is not connected. Check mcp-servers.json and restart Kairos.`;
    }
    try {
      const res = await client.callTool(mcpTool.name, args ?? {});
      // MCP callTool returns { content: [{type, text}...], isError? }
      if (res?.isError) {
        const errText = (res.content ?? []).map(c => c.text || '').join('\n');
        return `MCP tool error from ${serverName}/${mcpTool.name}: ${errText}`;
      }
      const parts = (res?.content ?? []).map(c => {
        if (c.type === 'text') return c.text;
        if (c.type === 'image') return `[image: ${c.mimeType}]`;
        if (c.type === 'resource') return `[resource: ${c.resource?.uri}]`;
        return JSON.stringify(c);
      });
      return parts.join('\n') || '(empty response)';
    } catch (err) {
      return `MCP call failed (${serverName}/${mcpTool.name}): ${err.message}`;
    }
  }

  return {
    name:        prefixedName,
    definition,
    handler,
    priority:    50, // MCP tools sort after built-ins (priority < 50)
    serverName,
    mcpName:     mcpTool.name,
    autoApprove: isAutoApprove && !isRequireApproval,
  };
}

/**
 * Adapt all tools from one MCP server.
 *
 * @param {string} serverName
 * @param {object[]} mcpTools
 * @param {string[]} autoApprove
 * @param {string[]} requireApproval
 * @returns {object[]}
 */
export function adaptServerTools(serverName, mcpTools, autoApprove = [], requireApproval = []) {
  return mcpTools.map(t => adaptTool(serverName, t, autoApprove, requireApproval));
}
