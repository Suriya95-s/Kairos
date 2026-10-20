# Parser Test Suite — File Recognition & Parse Recovery

Comprehensive tests for `parseAction` in `src/loop.js`, focusing on file-content recognition, backtick/fence handling inside JSON values, and all parser recovery paths.

---

## 1. Plain JSON Parsing

### 1.1 Minimal valid action
**Input:**
```json
{"thought": "ok", "tool": "think", "args": {}}
```
**Expected:** `tool = "think"`, `args = {}`

### 1.2 Action with args
**Input:**
```json
{"thought": "ok", "tool": "read_file", "args": {"path": "src/index.js"}}
```
**Expected:** `tool = "read_file"`, `args.path = "src/index.js"`

### 1.3 Preserves thought field
**Input:**
```json
{"thought": "all tasks complete", "tool": "finish", "args": {"summary": "done"}}
```
**Expected:** `thought = "all tasks complete"`, `tool = "finish"`

### 1.4 Whitespace around JSON is tolerated
**Input:**
```
   \n  {"thought": "ok", "tool": "think", "args": {}}  \n
```
**Expected:** `tool = "think"`

### 1.5 Missing args defaults to empty object
**Input:**
```json
{"thought": "x", "tool": "think"}
```
**Expected:** `args = {}`

### 1.6 Non-object args defaults to empty object
**Input:**
```json
{"thought": "x", "tool": "think", "args": "string"}
```
**Expected:** `args = {}`

### 1.7 Array args defaults to empty object
**Input:**
```json
{"thought": "x", "tool": "think", "args": [1, 2]}
```
**Expected:** `args = {}`

### 1.8 Missing tool field throws SCHEMA_INVALID
**Input:**
```json
{"thought": "x"}
```
**Expected:** Error containing `SCHEMA_INVALID`

---

## 2. File Content with Backticks (Regression)

> **Context:** The old parser ran the markdown code-block regex BEFORE `JSON.parse`. When write_file content contained triple backticks (e.g. README.md with ```bash fences), the regex matched backticks inside JSON string values and extracted garbage. The fix: JSON.parse first, code-block extraction only as fallback.

### 2.1 write_file with markdown code fences in content
**Input:**
```json
{"thought": "writing file", "tool": "write_file", "args": {"path": "README.md", "content": "# README\n\nInstall:\n```bash\nnpm install\n```\n\nUsage:\n```js\nconst x = 1;\n```\n"}}
```
**Expected:** `tool = "write_file"`, `args.path = "README.md"`, content preserved exactly with fences intact.

### 2.2 write_file with nested triple backticks
**Input:**
```json
{"thought": "writing file", "tool": "write_file", "args": {"path": "docs/example.md", "content": "Example:\n````markdown\n```json\n{\"key\": \"value\"}\n```\n````\n"}}
```
**Expected:** `tool = "write_file"`, content preserved with nested fences intact.

### 2.3 write_file with Python docstring + code fences
**Input:**
```json
{"thought": "writing file", "tool": "write_file", "args": {"path": "app.py", "content": "def foo():\n    \"\"\"This function does stuff.\n    \n    Example:\n    ```python\n    foo()\n    ```\n    \"\"\"\n    pass\n"}}
```
**Expected:** `tool = "write_file"`, content preserved.

### 2.4 write_file with shell heredoc
**Input:**
```json
{"thought": "writing file", "tool": "write_file", "args": {"path": "run.sh", "content": "#!/bin/bash\ncat <<EOF\nHello world\nEOF\n"}}
```
**Expected:** `tool = "write_file"`, content preserved.

### 2.5 write_file with Dockerfile
**Input:**
```json
{"thought": "writing file", "tool": "write_file", "args": {"path": "Dockerfile", "content": "FROM node:18\nRUN apt-get update && \\\n    apt-get install -y curl && \\\n    rm -rf /var/lib/apt/lists/*\nCOPY . /app\nCMD [\"node\", \"index.js\"]\n"}}
```
**Expected:** `tool = "write_file"`, `args.path = "Dockerfile"`

### 2.6 write_file with JSON content (nested JSON in JSON)
**Input:**
```json
{"thought": "writing file", "tool": "write_file", "args": {"path": "package.json", "content": "{\n  \"name\": \"my-app\",\n  \"version\": \"1.0.0\",\n  \"scripts\": {\n    \"test\": \"node --test\"\n  }\n}\n"}}
```
**Expected:** `tool = "write_file"`, nested JSON content preserved exactly.

### 2.7 write_file with YAML content
**Input:**
```json
{"thought": "writing file", "tool": "write_file", "args": {"path": ".github/workflows/ci.yml", "content": "name: CI\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v3\n      - run: npm test\n"}}
```
**Expected:** `tool = "write_file"`, `args.path = ".github/workflows/ci.yml"`

### 2.8 write_file with HTML containing script tags
**Input:**
```json
{"thought": "writing file", "tool": "write_file", "args": {"path": "index.html", "content": "<!DOCTYPE html>\n<html>\n<head><title>App</title></head>\n<body>\n<script>\n  const data = {\"key\": \"value\"};\n  console.log(data);\n</script>\n</body>\n</html>\n"}}
```
**Expected:** `tool = "write_file"`, content with embedded JSON in `<script>` preserved.

### 2.9 write_file with CSS
**Input:**
```json
{"thought": "writing file", "tool": "write_file", "args": {"path": "style.css", "content": "body { margin: 0; }\n.container { max-width: 1200px; }\n@media (max-width: 768px) {\n  .container { padding: 0 16px; }\n}\n"}}
```
**Expected:** `tool = "write_file"`, CSS content preserved.

### 2.10 write_file with SQL
**Input:**
```json
{"thought": "writing file", "tool": "write_file", "args": {"path": "schema.sql", "content": "CREATE TABLE users (\n  id INTEGER PRIMARY KEY,\n  name TEXT NOT NULL,\n  email TEXT UNIQUE\n);\nINSERT INTO users (name, email) VALUES ('Alice', 'alice@example.com');\n"}}
```
**Expected:** `tool = "write_file"`, `args.path = "schema.sql"`

### 2.11 write_file with TypeScript generics
**Input:**
```json
{"thought": "writing file", "tool": "write_file", "args": {"path": "types.ts", "content": "interface Response<T> {\n  data: T;\n  error?: string;\n}\n\nfunction fetch<T>(url: string): Promise<Response<T>> {\n  return {} as any;\n}\n"}}
```
**Expected:** `tool = "write_file"`, angle brackets in generics preserved.

### 2.12 write_file with .env content
**Input:**
```json
{"thought": "writing file", "tool": "write_file", "args": {"path": ".env", "content": "DATABASE_URL=postgres://localhost:5432/mydb\nAPI_KEY=sk-test-12345\nNODE_ENV=production\n"}}
```
**Expected:** `tool = "write_file"`, `.env` content preserved.

---

## 3. Fenced JSON Blocks

### 3.1 ` ```json ` fence around action
**Input:**
````
```json
{"thought": "ok", "tool": "finish", "args": {"summary": "ok"}}
```
````
**Expected:** `tool = "finish"`, `args.summary = "ok"`

### 3.2 ` ```javascript ` fence around action
**Input:**
````
```javascript
{"thought": "ok", "tool": "think", "args": {"thought": "hmm"}}
```
````
**Expected:** `tool = "think"`

### 3.3 Prose before fenced action
**Input:**
````
Here is my action:
```json
{"thought": "ok", "tool": "read_file", "args": {"path": "x.js"}}
```
````
**Expected:** `tool = "read_file"`, `args.path = "x.js"`

### 3.4 Prose before AND after fenced action
**Input:**
````
I will list the directory.
```json
{"thought": "ok", "tool": "list_dir", "args": {"path": "."}}
```
That should work.
````
**Expected:** `tool = "list_dir"`

---

## 4. JSON Embedded in Prose (extractJsonObjects path)

### 4.1 Action JSON after prose text
**Input:**
```
Let me think about this.
{"thought": "reasoning", "tool": "think", "args": {"thought": "reasoning"}}
```
**Expected:** `tool = "think"`

### 4.2 Action JSON between prose paragraphs
**Input:**
```
Analysis complete.
{"thought": "ok", "tool": "finish", "args": {"summary": "done"}}
End of response.
```
**Expected:** `tool = "finish"`

### 4.3 Multiple JSON objects — picks first with tool field
**Input:**
```
Some text {"irrelevant": true} more text {"thought": "ok", "tool": "read_file", "args": {"path": "a.js"}} end
```
**Expected:** `tool = "read_file"` (skips the object without a `tool` field)

---

## 5. Thinking Blocks

### 5.1 `<think>` block stripped, action after it parsed
**Input:**
```
<think>Let me consider...</think>
{"thought": "ok", "tool": "read_file", "args": {"path": "x.js"}}
```
**Expected:** `tool = "read_file"`

### 5.2 `<thinking>` block stripped, action after it parsed
**Input:**
```
<thinking>Deep thought here</thinking>
{"thought": "ok", "tool": "finish", "args": {"summary": "done"}}
```
**Expected:** `tool = "finish"`

### 5.3 Only thinking block with JSON inside → extracts action
**Input:**
```
<think>I should write the file. {"thought": "ok", "tool": "write_file", "args": {"path": "x.js", "content": "hello"}}</think>
```
**Expected:** `tool = "write_file"`, `args.path = "x.js"`

### 5.4 Only thinking block with no JSON → synthesizes think action
**Input:**
```
<think>Just reasoning with no action at all</think>
```
**Expected:** `tool = "think"`, `args.thought` contains "Just reasoning"

---

## 6. Truncated/Incomplete JSON (closeJsonContainersOnly path)

### 6.1 Missing closing brace is repaired
**Input:**
```
{"thought": "ok", "tool": "think", "args": {}
```
**Expected:** `tool = "think"` (auto-closes the `}`)

### 6.2 Missing nested closing braces are repaired
**Input:**
```
{"thought": "ok", "tool": "write_file", "args": {"path": "x.js", "content": "hi"
```
**Expected:** `tool = "write_file"` (auto-closes `}}`)

### 6.3 Missing closing bracket and brace
**Input:**
```
{"thought": "ok", "tool": "run_command", "args": {"cmd": "ls", "flags": ["-la"
```
**Expected:** `tool = "run_command"` (auto-closes `]}}`)

### 6.4 Truncated inside string value is NOT repaired
**Input:**
```
{"thought": "ok", "tool": "write_file", "args": {"path": "x.js", "content": "hello wor
```
**Expected:** Error thrown — `closeJsonContainersOnly` returns empty when truncated inside a string literal, preventing content invention.

---

## 7. MiniMax XML Tool Calls

### 7.1 Basic XML tool call
**Input:**
```xml
<minimax:tool_call>
<tool name="list_dir" path="."/>
</tool>
```
**Expected:** `tool = "list_dir"`, `args.path = "."`

### 7.2 XML tool call with thought text before it
**Input:**
```
I need to read the file.
<minimax:tool_call>
<tool name="read_file" path="src/index.js"/>
```
**Expected:** `tool = "read_file"`, `args.path = "src/index.js"`, `thought` contains "read the file"

---

## 8. Error Classifications

### 8.1 Pure prose throws PROSE_ONLY_RESPONSE
**Input:**
```
I think we should implement the feature next.
```
**Expected:** Error containing `PROSE_ONLY_RESPONSE`

### 8.2 Invalid JSON with braces throws error
**Input:**
```
{not valid json at all}
```
**Expected:** Error containing `No valid JSON action found`

### 8.3 JSON without tool field throws SCHEMA_INVALID
**Input:**
```json
{"thought": "x", "action": "read"}
```
**Expected:** Error containing `SCHEMA_INVALID`

### 8.4 Empty string throws
**Input:** `""` (empty)
**Expected:** Error thrown

### 8.5 Only whitespace throws
**Input:** `"   \n\t  "` (whitespace only)
**Expected:** Error thrown

---

## 9. File Type Recognition — Diverse Formats in write_file

For each file type below, the test wraps the content in a valid `write_file` JSON action and verifies that `parseAction` returns `tool = "write_file"` with `args.path` and `args.content` preserved exactly.

| # | File Type | Path | Key Content Feature |
|---|-----------|------|---------------------|
| 9.1 | .gitignore | `.gitignore` | Glob patterns: `node_modules/`, `*.log` |
| 9.2 | Makefile | `Makefile` | `.PHONY`, tab-indented recipes |
| 9.3 | Markdown with fences | `GUIDE.md` | ```` ```bash ```` and ```` ```python ```` fences |
| 9.4 | TOML | `pyproject.toml` | `[tool.pytest.ini_options]`, quoted values |
| 9.5 | INI / EditorConfig | `.editorconfig` | `root = true`, `[*]` sections |
| 9.6 | XML | `pom.xml` | `<?xml ...?>` declaration, nested elements |
| 9.7 | Rust | `main.rs` | `Vec<&str>`, angle brackets in generics |
| 9.8 | Go | `main.go` | `package main`, `import "fmt"` |
| 9.9 | Ruby | `app.rb` | `class App`, `#{@name}` interpolation |
| 9.10 | C header | `utils.h` | `#ifndef` guards, `#include` |
| 9.11 | CSV | `data.csv` | Quoted fields with commas inside |
| 9.12 | SVG | `icon.svg` | `<svg>`, `<circle>` elements |
| 9.13 | Terraform | `main.tf` | `resource "aws_instance"`, HCL syntax |
| 9.14 | Nginx config | `nginx.conf` | `server { listen 80; }` blocks |
| 9.15 | ESM JavaScript | `utils.mjs` | `import`, `export async function` |

### Verification per file type

For each row, construct:
```json
{"thought": "writing file", "tool": "write_file", "args": {"path": "<path>", "content": "<content>"}}
```

Then call `parseAction(raw)` and assert:
- `result.tool === "write_file"`
- `result.args.path === "<path>"`
- `result.args.content === "<content>"` (byte-exact match)

---

## 10. Special Characters in File Content

### 10.1 Backslashes (Windows paths, regex)
**Content:** `const re = /\\d+\\.\\d+/;\nconst path = "C:\\\\Users\\\\dev\\\\project";\n`
**Expected:** Content preserved with all backslash sequences intact.

### 10.2 Unicode characters
**Content:** `// 你好世界\nconst greeting = "こんにちは";\nconsole.log("Ñoño: café résumé");\n`
**Expected:** Unicode characters preserved.

### 10.3 Escaped quotes
**Content:** `const msg = "She said \\"hello\\".";\nconst obj = '{"key": "val"}';\n`
**Expected:** Escaped quotes preserved.

### 10.4 Mixed line endings
**Content:** `line1\n\tindented\r\nwindows-line\n\n\nempty-lines-above\n`
**Expected:** Newlines, tabs, carriage returns all preserved.

### 10.5 Template literals with ${} interpolation
**Content:** ``const msg = `Hello, ${name}!`;``
**Expected:** Template literal syntax preserved, `${}` not interpreted.

### 10.6 Large file content (10KB+)
**Content:** `const x = "abcdefghijklmnopqrstuvwxyz0123456789";\n` repeated 200 times (~10KB)
**Expected:** `tool = "write_file"`, content length matches exactly.

---

## 11. Double-Fence Scenario

> Model wraps its response in ` ```json `, and the `write_file` content itself contains ` ``` `.

### 11.1 Direct JSON wins over fence extraction
**Input:** Raw valid JSON for `write_file` where content is:
```
# Hello\n\n```bash\necho hi\n```\n
```
**Expected:** `JSON.parse` succeeds on the first attempt. The fences inside the string value are never matched by the code-block regex. `tool = "write_file"`, content preserved.

---

## Running These Tests

To execute these test cases programmatically against `parseAction`:

```js
import { parseAction } from '../src/loop.js';

// For each test case above:
// 1. Construct the Input string
// 2. Call parseAction(input)
// 3. Assert the Expected result or error
```

Example runner:
```bash
node --test tests/parser.test.js
```