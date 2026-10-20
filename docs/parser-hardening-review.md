# Multi-Format Action Parser Hardening Review
## Detailed Analysis, Risks, and Recommended Improvements

## 1. Purpose

This document reviews the current action-parser hardening direction and proposes additional improvements needed to make the parser reliable under long autonomous runs.

The immediate goal is to reduce failures like:

- `Parse error: No valid JSON action found in response`
- malformed or truncated tool-call payloads
- partial JSON objects from model output
- mixed prose + JSON responses
- markdown-fenced command/task files causing incorrect required-command extraction

This document assumes the recent fixes already attempted include:

- better fenced-block command extraction
- ignoring bare markdown fences
- generic handling of shell continuations (`\`)
- conservative repair of responses missing only trailing `}` / `]`

Those are good steps, but they are not sufficient on their own for production-grade long-run reliability.

---

# 2. Current Failure Pattern

## 2.1 What is happening

The loop frequently expects exactly one valid JSON action object from the model, but the model instead returns one of these forms:

1. **Truncated JSON**
   - starts like valid JSON
   - ends before closing braces
   - often happens on large `write_file` payloads

2. **Prose followed by JSON**
   - explanatory text first
   - JSON later
   - parser rejects because response is not pure JSON

3. **JSON followed by prose**
   - valid action object appears
   - model appends extra explanation
   - strict parser rejects full response

4. **Near-JSON with tiny formatting defects**
   - missing final `}`
   - missing final `]`
   - trailing comma
   - escaped quotes broken inside large strings

5. **Markdown-wrapped JSON**
   - fenced with ```json
   - parser fails if it expects raw JSON only

6. **Tool-call drift**
   - model describes intended action but never emits valid JSON object
   - common after code/test failure or after compaction

---

## 2.2 Why this happens

This is usually caused by a combination of:

- long responses with very large file content payloads
- model output truncation near token boundary
- weak protocol discipline under failure pressure
- prompt context containing too much narrative text
- parser being too strict at the wrong layer and too naive at the repair layer
- no multi-pass extraction strategy before declaring parse failure

---

# 3. What the Current Fixes Solve

## 3.1 Fenced command extraction fix

Parsing fenced shell/code blocks in markdown task files is the correct move.

This solves issues where required commands were being misread as:

- stray backticks
- empty commands
- malformed command arrays
- broken required-command evidence checks

### Good outcome
The runtime becomes less dependent on brittle markdown formatting.

### Remaining gap
You still need:
- strict filtering of fence language labels
- normalization of multiline commands
- correct handling of `&&`, `\`, heredocs, and indentation
- protection against treating prose blocks as commands

---

## 3.2 Conservative trailing-brace repair

Allowing parser recovery when only closing `}` or `]` is missing is also a good move.

### Good outcome
This catches safe and common truncation cases.

### Remaining gap
This only helps if:
- the JSON body is otherwise complete
- strings are not truncated
- quotes are balanced
- nested structures are not half-written

In real long `write_file` actions, the more common failure is not just a missing final brace.
It is often a **cut string literal**, especially inside `"content": "..."`.

So this fix is useful, but limited.

---

# 4. Main Remaining Weaknesses

## 4.1 The parser is still too single-shape

If the runtime only accepts one exact full-response shape, it will remain fragile.

You need a parser that can handle:

- raw JSON object
- markdown-fenced JSON object
- prose + JSON object
- JSON object + prose
- small truncation cases
- structured rejection when ambiguity remains

A robust autonomous loop should not immediately fail just because the model included one sentence before the tool call.

---

## 4.2 No layered extraction strategy

Right now the runtime likely does something close to:

1. try parse full response as JSON
2. maybe do a tiny repair
3. fail

That is not enough.

You need a staged parser pipeline.

### Recommended order
1. Try strict full-response JSON parse
2. Strip markdown fences and retry
3. Extract the largest likely JSON object substring and retry
4. Attempt conservative structural repair
5. Validate against action schema
6. If still invalid, emit structured parse-failure diagnostics

Without this, the runtime will keep failing on recoverable cases.

---

## 4.3 No distinction between recoverable and unrecoverable parse errors

Not all parse errors are equal.

### Recoverable parse error examples
- missing final brace
- fenced JSON
- leading prose before a valid object
- trailing prose after a valid object

### Unrecoverable parse error examples
- two competing tool objects
- truncated string content
- malformed nested quotes inside `"content"`
- object missing required action/tool fields
- prose-only answer with no tool call

The runtime should treat these differently.

Right now repeated hard failures are likely triggered because all parse errors are classified the same way.

---

## 4.4 Large `write_file` payloads are still dangerous

Most parser failures are concentrated around file-writing steps because those outputs are large.

### Why
Large JSON strings increase risk of:
- truncation
- quote breakage
- newline escaping issues
- content/body confusion
- model drifting into explanation after emitting file content

### Needed improvement
For large file writes, the runtime should encourage or require safer patterns:
- compact content generation
- staged writes when appropriate
- stronger parser recovery for `"content"` payloads
- optional content block extraction before full action parse

---

## 4.5 Parse failure feedback is still too weak

If the loop only logs:

> Parse error: No valid JSON action found in response

that is not enough guidance for the next step.

The model needs structured feedback like:

- response looked like fenced JSON but parse failed
- detected partial object with missing closing brace
- detected prose before JSON object
- detected truncated string in `"content"`
- detected multiple candidate JSON objects
- expected fields: `tool`, `args`

That improves the chance of self-correction on the next turn.

---

# 5. Recommended Parser Architecture

## 5.1 Introduce a multi-pass parser pipeline

Recommended parser stages:

### Pass 1 -- Strict parse
Try parsing the entire response as one JSON object.

### Pass 2 -- Fence stripping
Remove:
- ```json
- ```javascript
- ```
wrappers, then retry strict parse.

### Pass 3 -- Candidate object extraction
Scan the response for the largest balanced JSON object candidate.

Important:
- must ignore braces inside quoted strings
- must support nested arrays/objects
- must reject if multiple competing top-level candidates exist without a clear winner

### Pass 4 -- Conservative repair
Allow only safe repairs such as:
- append missing final `}`
- append missing final `]`
- close balanced nested structures if the only missing tokens are trailing closers

Do **not** invent:
- missing keys
- missing string content
- missing quotes in the middle of strings

### Pass 5 -- Schema validation
Validate parsed object against the expected action schema.

For example:
- must include `tool`
- must include `args`
- `tool` must be string
- `args` must be object

### Pass 6 -- Structured failure classification
If parse still fails, classify reason:
- `NO_JSON_FOUND`
- `FENCED_JSON_INVALID`
- `MULTIPLE_JSON_OBJECTS`
- `TRUNCATED_STRING`
- `SCHEMA_INVALID`
- `PROSE_ONLY_RESPONSE`

This classification should go into logs and recovery context.

---

## 5.2 Add schema-aware parsing, not just JSON parsing

Valid JSON is not enough.

This should fail schema validation:

```json
{"message":"I will now write the file"}
```
