// apps/tui/src/chatConfig.js
// Wave E-2c — chat tool schemas + the prompt-injected fallback, split out of app.js
// as pure configuration data (no state, no I/O) to slim the controller module.

export const CHAT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file in the working directory.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Relative path from the working directory' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file (creates if absent, overwrites if present).',
      parameters: {
        type: 'object',
        properties: {
          path:    { type: 'string', description: 'Relative path from the working directory' },
          content: { type: 'string', description: 'Text content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file from the working directory.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Relative path to the file' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files and subdirectories at a path.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Relative path to list (defaults to ".")' } },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Execute a shell command in the working directory.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'Shell command to run' } },
        required: ['command'],
      },
    },
  },
];

// Prompt-injected tool schema for models that ignore the native tools API.
export function getChatSystemPrompt(workdir) {
  return `You are a helpful assistant with access to the file system.
Working directory: ${workdir}

## Tools (call one at a time by outputting ONLY this block)
<tool_call>
{"name": "TOOL_NAME", "args": {...}}
</tool_call>

Available tools:
- read_file    {"path": "relative/path"}
- write_file   {"path": "relative/path", "content": "..."}
- delete_file  {"path": "relative/path"}
- list_dir     {"path": "."}
- run_command  {"command": "..."}

When no tool is needed, respond normally. Do not mix tool calls with regular text.`;
}
