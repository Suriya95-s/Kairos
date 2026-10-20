// src/routing/toolRegistry.js
//
// Builds a category-keyed registry from the existing tool modules.
// Each category maps to { definitions: [...], handlers: {...} }.
//
// Architecture decision:
//   Static imports are used (not dynamic import()) because all tools are
//   known at build time, and static imports give us synchronous access
//   without async waterfalls inside the router hot-path.
//   The registry is built once at module load and frozen to prevent
//   accidental mutation across steps.

import * as readFile     from '../tools/filesystem/read-file.js';
import * as writeFile    from '../tools/filesystem/write-file.js';
import * as editFile     from '../tools/filesystem/edit-file.js';
import * as listDir      from '../tools/filesystem/list-dir.js';
import * as searchFiles  from '../tools/filesystem/search-files.js';
import * as glob         from '../tools/filesystem/glob.js';
import * as patch        from '../tools/filesystem/patch.js';
import * as createDir    from '../tools/filesystem/create-dir.js';
import * as movePath     from '../tools/filesystem/move-path.js';
import * as copyPath     from '../tools/filesystem/copy-path.js';
import * as deletePath   from '../tools/filesystem/delete-path.js';

import * as runCommand   from '../tools/execution/run-command.js';
import * as webfetch     from '../tools/execution/webfetch.js';
import * as websearch    from '../tools/execution/websearch.js';
import * as lsp          from '../tools/execution/lsp.js';

import * as think        from '../tools/planning/think.js';
import * as finish       from '../tools/planning/finish.js';
import * as updatePlan   from '../tools/planning/update-plan.js';
import * as addLearning  from '../tools/planning/add-learning.js';
import * as todoread     from '../tools/planning/todoread.js';
import * as todowrite    from '../tools/planning/todowrite.js';

import * as saveMemory         from '../tools/memory/save-memory.js';
import * as searchMemory       from '../tools/memory/search-memory.js';
import * as updateMemory       from '../tools/memory/update-memory.js';
import * as recallRoom         from '../tools/memory/recall_room.js';
import * as recallTemporal     from '../tools/memory/recall_temporal.js';
import * as recallChatSession  from '../tools/memory/recall_chat_session.js';
import * as recallByEntity     from '../tools/memory/recall_by_entity.js';
import * as recallByDomain     from '../tools/memory/recall_by_domain.js';

import * as graphQuery     from '../tools/graph/graph_query.js';
import * as graphAggregate from '../tools/graph/graph_aggregate.js';

import * as updateIdentity from '../tools/identity/update-identity.js';
import * as createSkill    from '../tools/skills/create-skill.js';
import { normalizeToolArgs, validateToolArgs } from '../tools/utils/contract.js';
import { ok, isToolResult, renderForModel } from '../tools/utils/toolResult.js';
import config from '../config.js';

// ── Category definitions ──────────────────────────────────────────────────────
//
// Priority field (lower = served first by toolManager).
// Controls which tools surface in the top-4 window when a category has more
// than 4 members.  Read-before-write ordering is intentional everywhere.

const RAW_CATEGORIES = {
  filesystem: [
    { mod: readFile,    priority: 1 },
    { mod: listDir,     priority: 2 },
    { mod: searchFiles, priority: 3 },
    { mod: glob,        priority: 4 },
    { mod: editFile,    priority: 5 },
    { mod: writeFile,   priority: 6 },
    { mod: patch,       priority: 7 },
    { mod: createDir,   priority: 8 },
    { mod: movePath,    priority: 9 },
    { mod: copyPath,    priority: 10 },
    { mod: deletePath,  priority: 11 },
  ],

  execution: [
    { mod: runCommand,  priority: 1 },
    { mod: lsp,         priority: 2 },
    { mod: webfetch,    priority: 3 },
    { mod: websearch,   priority: 4 },
  ],

  planning: [
    { mod: think,       priority: 1 },
    { mod: finish,      priority: 2 },
    { mod: todoread,    priority: 3 },
    { mod: updatePlan,  priority: 4 },
    { mod: todowrite,   priority: 5 },
    { mod: addLearning, priority: 6 },
  ],

  memory: [
    { mod: searchMemory,        priority: 1 },
    { mod: updateMemory,        priority: 2 },
    { mod: saveMemory,          priority: 3 },
    { mod: recallByEntity,      priority: 4 },
    { mod: recallByDomain,      priority: 5 },
    { mod: recallRoom,          priority: 6 },
    { mod: recallTemporal,      priority: 7 },
    { mod: recallChatSession,   priority: 8 },
    // G3: the ontology graph is structured loop memory — typed, evidence-backed,
    // and traversable, which is why these live in the memory category.
    { mod: graphQuery,          priority: 9 },
    { mod: graphAggregate,      priority: 10 },
  ],

  identity: [
    { mod: updateIdentity, priority: 1 },
  ],

  skills: [
    { mod: createSkill, priority: 1 },
  ],
};

// ── Build the registry ────────────────────────────────────────────────────────

/**
 * @typedef {{ name: string, definition: object, handler: Function, priority: number }} ToolEntry
 * @typedef {{ [category: string]: ToolEntry[] }} Registry
 */

/** Full category → sorted tool entries map.  Sorted ascending by priority. */
export const REGISTRY = Object.fromEntries(
  Object.entries(RAW_CATEGORIES).map(([cat, entries]) => [
    cat,
    entries
      .sort((a, b) => a.priority - b.priority)
      .map(({ mod, priority }) => ({
        name:       mod.definition.function.name,
        definition: mod.definition,
        handler:    mod.handler,
        priority,
      })),
  ])
);

// Freeze to prevent external mutation
Object.freeze(REGISTRY);

/** Flat built-in tool definitions derived from the single registry source. */
export const TOOL_DEFINITIONS = Object.values(REGISTRY).flat().map(e => e.definition);

/** Flat built-in tool handlers derived from the single registry source. */
export const TOOL_HANDLERS = Object.fromEntries(
  Object.values(REGISTRY).flat().map(e => [e.name, e.handler])
);

// ── Flat lookup maps ──────────────────────────────────────────────────────────

/** name → ToolEntry (all categories merged) */
const FLAT = new Map(
  Object.values(REGISTRY).flat().map(e => [e.name, e])
);

/** name → category string */
const NAME_TO_CATEGORY = new Map(
  Object.entries(REGISTRY).flatMap(([cat, entries]) =>
    entries.map(e => [e.name, cat])
  )
);

// ── Public API ────────────────────────────────────────────────────────────────

/** Return the category a tool belongs to, or null if unknown. */
export function getToolCategory(name) {
  return NAME_TO_CATEGORY.get(name) ?? null;
}

/** Return a single ToolEntry by name, or null. */
export function getToolEntry(name) {
  return FLAT.get(name) ?? null;
}

/** Return all tool entries in a category, sorted by priority. */
export function getCategoryTools(category) {
  return REGISTRY[category] ?? [];
}

/** Return all known category names. */
export function getCategories() {
  return Object.keys(REGISTRY);
}

// Common aliases from LLM training data → canonical registry names.
const TOOL_ALIASES = new Map([
  ['bash',       'run_command'],
  ['shell',      'run_command'],
  ['execute',    'run_command'],
  ['list_files', 'list_dir'],
  ['ls',         'list_dir'],
]);

/** Execute a tool by name with args.  Returns { result, error }. */
export function executeRegistryTool(name, args) {
  const resolvedName = TOOL_ALIASES.get(name) ?? name;
  const entry = FLAT.get(resolvedName);
  if (!entry) {
    return { result: `Unknown tool: ${name}`, error: true };
  }
  const normalizedArgs = normalizeToolArgs(resolvedName, args);
  const validation = validateToolArgs(entry.definition, normalizedArgs, resolvedName);
  if (!validation.ok) {
    return {
      result: `ARG_VALIDATION_ERROR: ${resolvedName} missing required args: ${validation.missing.join(', ')}`,
      error: true,
    };
  }
  try {
    const raw = entry.handler(normalizedArgs);
    // Structured contract (Wave B): `error` is derived from `ok` — no string
    // sniffing. Every built-in tool returns a ToolResult; a bare string from a
    // future/edge handler is treated as a successful result (tools that can fail
    // MUST signal it with fail(), not by embedding a marker in the string).
    const structured = isToolResult(raw) ? raw : ok(String(raw ?? ''));
    return { result: renderForModel(structured), error: !structured.ok, structured };
  } catch (err) {
    return { result: `Tool error (${name}): ${err.message}`, error: true };
  }
}

/**
 * Execute a tool — built-in or MCP.
 * MCP tools are identified by the __ prefix convention and routed to the MCP registry.
 * Returns Promise<{ result, error }> always (even for sync built-in tools).
 */
export async function executeTool(name, args) {
  // Lazy-import to avoid circular deps and keep MCP optional
  const { isMcpToolName, executeMcpTool } = await import('../mcp/registry.js');
  if (isMcpToolName(name)) {
    return executeMcpTool(name, args);
  }
  // Built-in: executeRegistryTool is synchronous — wrap in resolved promise
  return executeRegistryTool(name, args);
}

/**
 * Return combined tool definitions: built-ins + MCP tools (if MCP enabled).
 * Used by context builder to inject tool descriptions into the system prompt.
 */
export async function getAllToolDefinitions() {
  const { getAllMcpDefinitions, getMcpToolCount, getMcpMetaToolDefinitions } = await import('../mcp/registry.js');
  const mcpDefs = getMcpToolCount() > 0 ? getAllMcpDefinitions() : [];
  // Wave D-5: expose the server-agnostic meta-tools (get_mcp_prompt / read_resource)
  // whenever MCP is enabled, even if no server published a `__`-prefixed tool.
  const metaDefs = config.mcpEnabled ? getMcpMetaToolDefinitions() : [];
  return [...TOOL_DEFINITIONS, ...mcpDefs, ...metaDefs];
}
