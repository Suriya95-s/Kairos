// src/mcp/connectionManager.js
// Lifecycle management for MCP server connections.
// Handles: spawn, health-check polling, crash detection, reconnect with backoff.

import fs   from 'node:fs';
import path from 'node:path';
import { createMcpClient } from './client.js';
import config from '../config.js';
import { getVault } from '../kernel/vault.js';
import { setMcpServerStates } from '../state.js';

/**
 * @typedef {{ name: string, transport: string, command?: string, args?: string[], url?: string, env?: object, headers?: object, autoApprove?: string[], requireApproval?: string[] }} ServerConfig
 * @typedef {{ config: ServerConfig, client: import('./client.js').McpStdioClient|import('./client.js').McpHttpClient|null, health: 'connecting'|'healthy'|'degraded'|'disconnected', reconnectAttempts: number, lastSeen: number|null, error: string|null }} ServerState
 */

/** @type {Map<string, ServerState>} */
const _servers = new Map();
let _healthTimer = null;
// Remembered at connectAll() so the reconnect path can refresh the tool registry
// (which needs the workspace root to read per-server autoApprove config).
let _workspaceRoot = process.cwd();

export function loadServerConfigsSync(workspaceRoot) {
  const userFile    = path.join(workspaceRoot, config.mcpConfigFile);
  const defaultFile = path.join(workspaceRoot, config.mcpDefaultConfigFile);

  const filePath = fs.existsSync(userFile) ? userFile
    : fs.existsSync(defaultFile) ? defaultFile : null;
  if (!filePath) return [];

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const servers = Array.isArray(raw.servers) ? raw.servers : [];
    // Resolve `vault:scope.key` references (S1). This is what lets
    // mcp-servers.json hold `"GITHUB_TOKEN": "vault:github.token"` and stay
    // committable — the alternative is a file full of live credentials that
    // everyone is one `git add -A` away from publishing.
    return resolveVaultRefs(servers, filePath);
  } catch (err) {
    console.error(`[mcp] Failed to parse ${filePath}: ${err.message}`);
    return [];
  }
}

/**
 * Replace `vault:` references with their secrets.
 *
 * A server whose reference cannot be resolved is DROPPED rather than started
 * with the literal string `vault:github.token` as its token — that would
 * produce a confusing 401 from a third-party service instead of an obvious
 * local error, and the failure would look like the service's fault.
 */
function resolveVaultRefs(servers, filePath) {
  const needsVault = JSON.stringify(servers).includes('"vault:');
  if (!needsVault) return servers;

  let vault;
  try {
    vault = getVaultSync();
  } catch (err) {
    console.error(`[mcp] ${filePath} uses vault: references but the vault is unavailable (${err.message}) — those servers are skipped.`);
    return servers.filter(srv => !JSON.stringify(srv).includes('"vault:'));
  }

  const out = [];
  for (const srv of servers) {
    try {
      out.push(vault.resolveConfig(srv));
    } catch (err) {
      console.error(`[mcp] server "${srv.name}": ${err.message} — skipping it rather than starting it unauthenticated.`);
    }
  }
  return out;
}

// A static import is safe here: importing the module does NOT open the vault.
// Creation is lazy (getVault) and the master key is only touched on first
// access, so nothing is decrypted — and no OS keystore is contacted — unless a
// config actually contains a `vault:` reference.
function getVaultSync() {
  const v = getVault();
  v.status();     // forces key setup; throws here if the vault is unavailable
  return v;
}

/**
 * Connect a single server and register it.
 * @param {ServerConfig} serverCfg
 */
export async function connectServer(serverCfg) {
  const { name } = serverCfg;
  const existing = _servers.get(name);
  if (existing) {
    if (existing.health === 'healthy') return; // already up
    if (existing.connecting) return;           // a connect is already in flight — don't double-spawn
  }
  // Carry the reconnect counter across attempts so max-attempts is actually
  // reachable (previously every call reset it to 0 → infinite reconnect loop).
  const carriedAttempts = existing?.reconnectAttempts ?? 0;
  // Tear down any stale client before replacing it so we never orphan a child.
  try { existing?.client?.disconnect?.(); } catch { /* best-effort */ }

  _servers.set(name, { config: serverCfg, client: null, health: 'connecting', reconnectAttempts: carriedAttempts, connecting: true, lastSeen: existing?.lastSeen ?? null, error: null });

  try {
    const client = await createMcpClient(name, serverCfg);

    client.on('exit', () => {
      const state = _servers.get(name);
      // Ignore exit events from a client we have already replaced — otherwise an
      // old client's late exit would null out the new, healthy connection.
      if (!state || state.client !== client) return;
      state.health = 'disconnected';
      state.client = null;
      scheduleReconnect(name);
    });
    client.on('error', (err) => {
      const state = _servers.get(name);
      if (!state || state.client !== client) return;
      state.health = 'degraded';
      state.error = err.message;
    });

    _servers.set(name, { config: serverCfg, client, health: 'healthy', reconnectAttempts: 0, connecting: false, lastSeen: Date.now(), error: null });
    console.error(`[mcp] Connected: ${name} (${serverCfg.transport ?? 'stdio'})`);
  } catch (err) {
    _servers.set(name, { config: serverCfg, client: null, health: 'disconnected', reconnectAttempts: carriedAttempts, connecting: false, lastSeen: existing?.lastSeen ?? null, error: err.message });
    console.error(`[mcp] Failed to connect ${name}: ${err.message}`);
  }
}

/**
 * Connect all servers from the config file.
 * @param {string} workspaceRoot
 */
export async function connectAll(workspaceRoot) {
  _workspaceRoot = workspaceRoot;
  const configs = loadServerConfigsSync(workspaceRoot).filter(s => !s.disabled);
  if (configs.length === 0) return;
  console.error(`[mcp] Starting ${configs.length} MCP server(s)...`);
  await Promise.allSettled(configs.map(connectServer));
  setMcpServerStates(getAllServerStates());
  startHealthPolling();
}

/**
 * Disconnect all servers and stop health polling.
 */
export function disconnectAll() {
  stopHealthPolling();
  for (const [name, state] of _servers) {
    state.client?.disconnect?.();
    _servers.delete(name);
  }
}

/** Return the live client for a server, or null if not connected. */
export function getClient(name) {
  return _servers.get(name)?.client ?? null;
}

/** Return snapshot of all server states (for checkpoint). */
export function getAllServerStates() {
  return [..._servers.entries()].map(([name, state]) => ({
    name,
    transport: state.config.transport ?? 'stdio',
    health:    state.health,
    lastSeen:  state.lastSeen,
    error:     state.error,
    reconnectAttempts: state.reconnectAttempts,
  }));
}

/** Return all healthy clients as [name, client] pairs. */
export function getHealthyClients() {
  return [..._servers.entries()]
    .filter(([, s]) => s.health === 'healthy' && s.client)
    .map(([name, s]) => [name, s.client]);
}

/** Health check a single server (ping + update state). */
export async function healthCheck(name) {
  const state = _servers.get(name);
  if (!state?.client) return false;
  const alive = await state.client.ping();
  if (alive) {
    state.health   = 'healthy';
    state.lastSeen = Date.now();
    state.error    = null;
  } else {
    state.health = 'degraded';
  }
  return alive;
}

/** Reconnect a disconnected server with exponential backoff. */
async function scheduleReconnect(name) {
  const state = _servers.get(name);
  if (!state) return;
  // Guard against overlapping reconnects (exit event + health poll can both fire).
  if (state.connecting || state.reconnecting) return;
  if (state.reconnectAttempts >= config.mcpMaxReconnectAttempts) {
    console.error(`[mcp] ${name}: max reconnect attempts reached — giving up`);
    return;
  }
  state.reconnecting = true;
  const delay = Math.min(2000 * Math.pow(2, state.reconnectAttempts), 30000);
  state.reconnectAttempts++;
  console.error(`[mcp] ${name}: reconnecting in ${delay}ms (attempt ${state.reconnectAttempts})...`);
  await new Promise(r => setTimeout(r, delay));
  const cur = _servers.get(name);
  if (cur) cur.reconnecting = false;
  await connectServer(state.config);

  // Wave D-5: a recovered server's tools must reappear without a process restart.
  // The startup path refreshes the registry after connectAll(); the reconnect path
  // previously did not, so late-recovering servers stayed invisible to the router.
  const after = _servers.get(name);
  if (after?.health === 'healthy') {
    try {
      const { refreshRegistry } = await import('./registry.js');
      await refreshRegistry(_workspaceRoot);
      console.error(`[mcp] ${name}: reconnected — tool registry refreshed`);
    } catch (err) {
      console.error(`[mcp] ${name}: registry refresh after reconnect failed: ${err.message}`);
    }
  }
}

function startHealthPolling() {
  if (_healthTimer) return;
  _healthTimer = setInterval(async () => {
    for (const [name, state] of _servers) {
      if (state.health === 'connecting') continue;
      if (!state.client) { scheduleReconnect(name); continue; }
      await healthCheck(name);
    }
    // Push updated snapshot to state.js so saveCheckpoint can include it synchronously
    setMcpServerStates(getAllServerStates());
  }, config.mcpHealthIntervalMs);
  _healthTimer.unref?.(); // don't keep process alive
}

function stopHealthPolling() {
  clearInterval(_healthTimer);
  _healthTimer = null;
}
