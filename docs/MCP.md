# MCP (Model Context Protocol) Integration

Kairos supports the [Model Context Protocol](https://spec.modelcontextprotocol.io/) — a standard for connecting LLM agents to external tools, databases, and services. Any MCP server becomes a Kairos capability with zero code changes.

---

## Quickstart: Add a new MCP server in 3 steps

1. **Copy the default config** (if you haven't already):
   ```sh
   cp mcp-servers.default.json mcp-servers.json
   ```

2. **Add your server** to `mcp-servers.json`:
   ```json
   {
     "servers": [
       {
         "name": "my_service",
         "transport": "stdio",
         "command": "npx",
         "args": ["-y", "my-mcp-server-package"],
         "autoApprove": ["list_*", "get_*"],
         "requireApproval": ["delete_*", "create_*"]
       }
     ]
   }
   ```

3. **Enable MCP and restart Kairos**:
   ```sh
   AGENT_MCP_ENABLED=1 node src/cli.js "your task"
   ```

The agent can now use tools named `my_service__<tool_name>`.

---

## How it works

- On startup, Kairos reads `mcp-servers.json` (falls back to `mcp-servers.default.json`).
- Each server is spawned (stdio) or connected to (HTTP/SSE).
- Tools are fetched via `tools/list` and registered with the prefix `<serverName>__<toolName>`.
- The agent sees them in its tool list and can call them exactly like built-in tools.

---

## Curated bundle (mcp-servers.default.json)

Five servers are pre-configured (all disabled by default):

| Server | Purpose | Enable |
|--------|---------|--------|
| `filesystem` | Read/write files outside the workspace | Set `"disabled": false` |
| `github` | Search repos, read files, create PRs/issues | Set `"disabled": false` + `GITHUB_TOKEN` env |
| `postgres` | Query a PostgreSQL database | Set `"disabled": false` + `DATABASE_URL` env |
| `fetch` | Fetch arbitrary URLs | Set `"disabled": false` (requires `uvx`) |
| `brave_search` | Web search via Brave API | Set `"disabled": false` + `BRAVE_API_KEY` env |

Enable the filesystem server only (safe, no token needed):
```json
{ "name": "filesystem", "disabled": false, ... }
```

---

## Config reference

```json
{
  "servers": [
    {
      "name": "my_server",            // required — lowercase alphanumeric + _ -
      "transport": "stdio",           // required — "stdio", "http", or "sse"
      "command": "npx",               // required for stdio — executable to spawn
      "args": ["-y", "package-name"], // optional — CLI args
      "env": { "API_KEY": "..." },    // optional — extra env vars for the process
      "url": "http://host:port",      // required for http/sse transport
      "headers": { "Authorization": "Bearer ..." }, // optional — for http/sse
      "disabled": false,              // optional — skip without removing
      "autoApprove": ["read_file"],   // MCP tool names that skip HITL approval
      "requireApproval": ["delete_*"] // always require HITL (overrides autoApprove)
    }
  ]
}
```

---

## Approval model (HITL integration)

When Phase 4 (HITL Gateway) ships, MCP tool calls obey this approval chain:

1. Tool name in `requireApproval` → always prompt human.
2. Tool name in `autoApprove` → execute automatically.
3. Neither → default policy (configurable, deny by default for writes).

In Phase 1 (current), all tools execute without prompting. Set `requireApproval` now to document intent for when HITL lands.

---

## Using MCP resources

Some MCP servers expose **resources** (read-only data like files, DB rows, API data).  
The agent has a `read_resource` tool for these:

```json
{ "tool": "read_resource", "args": { "uri": "postgres://table/users/1" } }
```

List available resources:
```json
{ "tool": "read_resource", "args": { "uri": "", "list": true } }
```

---

## Using MCP prompts as skills

Servers can expose reusable prompt templates. Access them via `get_mcp_prompt`:
```json
{ "tool": "get_mcp_prompt", "args": { "name": "github/summarize_pr", "args": { "repo": "anthropics/sdk" } } }
```

List available prompts:
```json
{ "tool": "get_mcp_prompt", "args": { "name": "", "list": true } }
```

---

## Health monitoring

MCP server health is tracked in `.agent/checkpoint.json` under `mcp_servers[]`:

```json
{
  "mcp_servers": [
    { "name": "github", "health": "healthy", "lastSeen": "2026-05-20T...", "reconnectAttempts": 0 }
  ]
}
```

Health states: `connecting` → `healthy` → `degraded` → `disconnected`. Disconnected servers reconnect automatically (up to `AGENT_MCP_MAX_RECONNECT` attempts, default 3).

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_MCP_ENABLED` | `0` | Set to `1` to activate MCP |
| `AGENT_MCP_CONFIG` | `mcp-servers.json` | Path to config file |
| `AGENT_MCP_CONNECT_TIMEOUT` | `10000` | ms to wait for server connect |
| `AGENT_MCP_CALL_TIMEOUT` | `30000` | ms to wait for tool call |
| `AGENT_MCP_HEALTH_INTERVAL` | `30000` | ms between health checks |
| `AGENT_MCP_MAX_RECONNECT` | `3` | Max reconnect attempts before giving up |

---

## Writing your own MCP server

Any process that speaks [MCP JSON-RPC 2.0](https://spec.modelcontextprotocol.io/specification/) over stdio works. Minimal Node.js example:

```js
// my-mcp-server.js
process.stdin.setEncoding('utf-8');
let buf = '';
process.stdin.on('data', chunk => {
  buf += chunk;
  buf.split('\n').slice(0, -1).forEach(line => {
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      send({ jsonrpc:'2.0', id:msg.id, result:{ protocolVersion:'2024-11-05', serverInfo:{name:'my-server',version:'1.0'}, capabilities:{tools:{}} }});
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc:'2.0', id:msg.id, result:{ tools:[{ name:'greet', description:'Say hello', inputSchema:{type:'object',properties:{name:{type:'string'}},required:['name']} }] }});
    } else if (msg.method === 'tools/call' && msg.params.name === 'greet') {
      send({ jsonrpc:'2.0', id:msg.id, result:{ content:[{type:'text',text:`Hello, ${msg.params.arguments.name}!`}] }});
    }
  });
  buf = buf.split('\n').slice(-1)[0];
});
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
```

Add to `mcp-servers.json`:
```json
{ "name": "greeter", "transport": "stdio", "command": "node", "args": ["my-mcp-server.js"] }
```
