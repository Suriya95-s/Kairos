// central tool entry-point
// built-in tool definitions/handlers come from routing/toolRegistry.js
// so there is a single source of truth for tool registration.

import { isSkillTool, executeSkill } from '../skills.js';
import { executeRegistryTool, TOOL_DEFINITIONS } from '../routing/toolRegistry.js';
import { withToolGuidance } from './utils/guidance.js';
import { truncateResult } from './utils/truncate.js';
import { traced } from '../tracer.js';

export { TOOL_DEFINITIONS };

/**
 * Execute any tool — built-in, skill, or MCP.
 * Always async so MCP tools (which need network/process I/O) can be awaited.
 * Synchronous built-in tools resolve immediately.
 *
 * Tools are a record/replay boundary: their output is nondeterministic (command
 * stdout, timestamps, filesystem), so recording it lets replay drive the loop
 * down the identical path. Keyed on (name, args).
 */
export async function executeTool(name, args) {
  return traced('tool', { name, args }, () => _executeToolLive(name, args));
}

async function _executeToolLive(name, args) {
  try {
    if (isSkillTool(name)) {
      // Truncate skill output like every other tool — a multi-MB skill return
      // must not flow into context uncapped.
      const out = executeSkill(name, args);
      const result = truncateResult(String(out?.result ?? ''));
      return { result: out?.error ? withToolGuidance(name, result) : result, error: !!out?.error };
    }

    // MCP tools: identified by __ prefix convention
    if (typeof name === 'string' && name.includes('__')) {
      const { executeMcpTool } = await import('../mcp/registry.js');
      const out = await executeMcpTool(name, args);
      const result = truncateResult(String(out?.result ?? ''));
      return { result: out?.error ? withToolGuidance(name, result) : result, error: !!out?.error };
    }

    // MCP meta-tools (Wave D-5): server-agnostic prompts/resources. Async, so they
    // route here rather than through the synchronous built-in registry.
    if (name === 'get_mcp_prompt' || name === 'read_resource') {
      const { executeMcpMetaTool } = await import('../mcp/registry.js');
      const out = await executeMcpMetaTool(name, args);
      const result = truncateResult(String(out?.result ?? ''));
      return { result: out?.error ? withToolGuidance(name, result) : result, error: !!out?.error };
    }

    const out = executeRegistryTool(name, args);
    const result = truncateResult(String(out?.result ?? ''));
    if (out?.error) {
      return { result: withToolGuidance(name, result), error: true };
    }
    return { result, error: false };
  } catch (err) {
    return { result: withToolGuidance(name, `Tool error (${name}): ${err.message}`), error: true };
  }
}

