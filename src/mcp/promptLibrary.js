// src/mcp/promptLibrary.js
// Surfaces MCP prompts as Kairos skills (compatible with src/skills.js format).
// MCP prompts are reusable templates with named arguments — analogous to SKILL.md files.

import { getHealthyClients } from './connectionManager.js';

/**
 * Fetch all MCP prompts from connected servers and return them as skill objects
 * compatible with the loadSkills() format in src/skills.js.
 *
 * @returns {Promise<Array<{ name: string, description: string, source: string, content: string }>>}
 */
export async function getMcpPromptSkills() {
  const skills = [];
  for (const [serverName, client] of getHealthyClients()) {
    try {
      const prompts = await client.listPrompts();
      for (const prompt of prompts) {
        skills.push({
          name:        `${serverName}/${prompt.name}`,
          description: prompt.description ?? prompt.name,
          source:      `mcp:${serverName}`,
          content:     buildSkillContent(serverName, prompt),
        });
      }
    } catch { /* server may not support prompts */ }
  }
  return skills;
}

function buildSkillContent(serverName, prompt) {
  const args = (prompt.arguments ?? [])
    .map(a => `  - ${a.name}${a.required ? ' (required)' : ''}: ${a.description ?? ''}`)
    .join('\n');

  return [
    `# MCP Prompt: ${prompt.name}`,
    `Server: ${serverName}`,
    prompt.description ? `\n${prompt.description}` : '',
    args ? `\nArguments:\n${args}` : '',
    '\nTo use: call get_mcp_prompt tool with name and arguments.',
  ].filter(Boolean).join('\n');
}

// ── Kairos tool definition for get_mcp_prompt ──────────────────────────────────

export const definition = {
  type: 'function',
  function: {
    name: 'get_mcp_prompt',
    description: 'Retrieve and render an MCP prompt template by name (e.g. "github/summarize_pr").',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Prompt name in "server/promptName" format' },
        args: { type: 'object', description: 'Arguments to pass to the prompt template', default: {} },
        list: { type: 'boolean', description: 'If true, list available prompts', default: false },
      },
      required: ['name'],
    },
  },
};

export async function handler({ name, args = {}, list = false }) {
  const skills = await getMcpPromptSkills();

  if (list) {
    if (skills.length === 0) return 'No MCP prompts available.';
    return skills.map(s => `${s.name}: ${s.description}`).join('\n');
  }

  // Resolve server and prompt name
  const slashIdx = name.indexOf('/');
  if (slashIdx < 1) return `Invalid prompt name format. Use "serverName/promptName".`;

  const serverName = name.slice(0, slashIdx);
  const promptName = name.slice(slashIdx + 1);

  for (const [sName, client] of getHealthyClients()) {
    if (sName !== serverName) continue;
    try {
      const res = await client.getPrompt(promptName, args);
      const parts = (res?.messages ?? []).map(m => {
        const content = m.content;
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) return content.map(c => c.text || '').join('');
        return content?.text ?? JSON.stringify(content);
      });
      return parts.join('\n') || '(empty prompt)';
    } catch (err) {
      return `Failed to get prompt "${name}": ${err.message}`;
    }
  }
  return `MCP server "${serverName}" not connected or prompt "${promptName}" not found.`;
}
