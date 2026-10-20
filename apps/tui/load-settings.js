#!/usr/bin/env node
// Reads .agent/tui-settings.json and prints shell-safe export statements.
// Usage: eval "$(node apps/tui/load-settings.js)"
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const settingsPath = join(process.cwd(), '.agent', 'tui-settings.json');
if (!existsSync(settingsPath)) process.exit(0);

try {
  const d = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const safe = v => String(v ?? '').replace(/'/g, '').replace(/\n/g, '');
  if (d.serverUrl) process.stdout.write(`SAVED_SETTINGS_URL='${safe(d.serverUrl)}'\n`);
  if (d.model)     process.stdout.write(`SAVED_SETTINGS_MODEL='${safe(d.model)}'\n`);
  if (d.apiKey)    process.stdout.write(`SAVED_SETTINGS_KEY='${safe(d.apiKey)}'\n`);
  // Advanced knobs from the TUI config editor (only emitted when set/non-default).
  const num = (k, env) => { if (typeof d[k] === 'number' && d[k] > 0) process.stdout.write(`${env}='${d[k]}'\n`); };
  num('contextWindow', 'SAVED_SETTINGS_CONTEXT_WINDOW');
  num('maxOutput', 'SAVED_SETTINGS_MAX_OUTPUT');
  num('memoryWindow', 'SAVED_SETTINGS_MEMORY_WINDOW');
  num('compactThreshold', 'SAVED_SETTINGS_COMPACT_THRESHOLD');
  num('compactInterval', 'SAVED_SETTINGS_COMPACT_INTERVAL');
  if (typeof d.usePalace === 'boolean')  process.stdout.write(`SAVED_SETTINGS_USE_PALACE='${d.usePalace ? 1 : 0}'\n`);
  if (typeof d.noThinking === 'boolean') process.stdout.write(`SAVED_SETTINGS_NO_THINKING='${d.noThinking ? 1 : 0}'\n`);
} catch {}
