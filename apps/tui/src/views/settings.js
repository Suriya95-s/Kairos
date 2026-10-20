import { dboxTop, dboxBot, dboxRow, C, gr, g, y, vi, moveTo, visLen, padEnd, T } from '../render.js';
import { state } from '../state.js';

// ── The model registry (kairos llm) ──────────────────────────────────────────
// The endpoints registered with `kairos llm add` surface here so switching the
// active model is a settings action, not a terminal round trip. Read through a
// short cache: getSettingsItems runs per render, and per-render disk reads are
// how a settings panel becomes a space heater.

let _registry = { at: 0, data: null };

/**
 * The last primed registry, or null before the first prime. Render-safe:
 * getSettingsItems runs per frame, so this must never touch the disk itself —
 * primeRegistry() (called when the panel opens) is the only reader.
 */
export function registrySnapshot() {
  return _registry.data;
}

/** Called by app.js on settings-open (async import of the kernel module). */
export async function primeRegistry() {
  try {
    const { loadModels } = await import('../../../../src/kernel/models.js');
    _registry = { at: Date.now(), data: loadModels() };
  } catch {
    _registry = { at: Date.now(), data: null };
  }
  return _registry.data;
}

/** Activate a registry model by name. Returns the entry. Used by app.js. */
export async function activateRegistryModel(name) {
  const { setActive, loadModels } = await import('../../../../src/kernel/models.js');
  const entry = setActive(name);
  _registry = { at: Date.now(), data: loadModels() };
  return entry;
}

export function invalidateRegistryCache() { _registry = { at: 0, data: null }; }

export const PROVIDERS = ['ollama', 'vllm', 'openai', 'anthropic', 'custom'];

// Base-URL presets so entering e.g. a ChatGPT key is one step: pick the provider
// and the endpoint is prefilled. `null` = leave the current Server URL untouched.
export const PROVIDER_PRESETS = {
  openai:    'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  openrouter:'https://openrouter.ai/api/v1',
  ollama:    'http://localhost:11434/v1',
  vllm:      'http://localhost:8000/v1',
  custom:    null,
};

// Curated starting model lists per API provider. A starting point only — press
// [Tab] in the model picker to fetch the live list from /v1/models.
export const PROVIDER_MODELS = {
  openai:     ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o3-mini', 'o1'],
  anthropic:  ['claude-opus-4', 'claude-sonnet-4', 'claude-haiku-4', 'claude-3-5-sonnet'],
  // OpenRouter retires/relocates :free slugs constantly — this is only a starting
  // point. Press [Tab] in the model picker to fetch the live catalog. Stable picks
  // (incl. low-cost paid) lead; a couple of usually-present free models follow.
  openrouter: ['openai/gpt-4o-mini', 'anthropic/claude-3.5-haiku',
               'meta-llama/llama-3.3-70b-instruct:free', 'qwen/qwen-2.5-72b-instruct:free',
               'deepseek/deepseek-chat'],
  custom:     [],
};

// Navigable items only — used for settingsIdx navigation and key handling in app.js
// Display a numeric knob, showing "(default)" when unset (0).
const numOrDefault = (n) => (n && n > 0 ? String(n) : '(default)');
const onOff = (b) => (b ? 'on' : 'off');

function maskedOf(v) {
  return v ? (state.showApiKey ? v : '●'.repeat(Math.min(v.length, 20))) : '(none)';
}

export { maskedOf };

// Mode-aware, data-driven settings. Each item carries its `section` and `kind`
// (pick|cycle|toggle|numeric|text|secret) so renderSettings + beginSettingsEdit
// can be generic — no hard-coded row indices.
export function getSettingsItems() {
  const items = [];
  // ── CONNECTION (guided API | Local) ──
  items.push({ key: 'modelSource', label: 'Source', section: 'CONNECTION', kind: 'cycle',
    value: state.modelSource === 'api' ? 'API (cloud provider)' : 'Local (your own server)' });
  if (state.modelSource === 'api') {
    items.push({ key: 'provider', label: 'Provider', section: 'CONNECTION', kind: 'pick', value: state.provider || 'openai' });
    items.push({ key: 'apiKey',   label: 'API Key',  section: 'CONNECTION', kind: 'pick', secret: true, value: maskedOf(state.apiKey) });
    items.push({ key: 'model',    label: 'Model',    section: 'CONNECTION', kind: 'pick', value: state.model || '(none)' });
  } else {
    items.push({ key: 'serverUrl', label: 'Endpoint', section: 'CONNECTION', kind: 'pick', value: state.serverUrl || '(none)' });
    items.push({ key: 'model',     label: 'Model',    section: 'CONNECTION', kind: 'pick', value: state.model || '(none)' });
    items.push({ key: 'apiKey',    label: 'API Key',  section: 'CONNECTION', kind: 'pick', secret: true, value: maskedOf(state.apiKey) });
  }
  items.push({ key: 'openrouterKey', label: 'OpenRouter Key', section: 'CONNECTION', kind: 'secret', value: maskedOf(state.openrouterKey) });
  // ── MODEL REGISTRY (kairos llm) — Enter activates ──
  const reg = registrySnapshot();
  if (reg && Object.keys(reg.models || {}).length) {
    for (const name of Object.keys(reg.models).sort()) {
      const m = reg.models[name];
      const active = reg.active === name;
      const check = m.lastCheck
        ? (m.lastCheck.ok ? `ok ${m.lastCheck.latencyMs}ms` : 'FAILED')
        : 'unchecked';
      items.push({
        key: `registry:${name}`,
        label: `${active ? '●' : '○'} ${name}`.slice(0, 14),
        section: 'MODEL REGISTRY',
        kind: 'action',
        registryName: name,
        registryActive: active,
        value: `${(m.model || '').slice(0, 30)}  ${check}${active ? '  — active' : ''}`,
      });
    }
  }
  // ── LOOP ──
  items.push({ key: 'temperature', label: 'Temperature', section: 'LOOP', kind: 'text',    value: String(state.temperature ?? 0.1) });
  items.push({ key: 'maxSteps',    label: 'Max Steps',   section: 'LOOP', kind: 'numeric', value: String(state.maxSteps || 0) });
  // ── MEMORY & COMPACTION (0 = agent default) ──
  for (const [key, label] of [['contextWindow', 'Context Win'], ['maxOutput', 'Max Output'], ['memoryWindow', 'Memory Win'], ['compactThreshold', 'Compact Thr'], ['compactInterval', 'Compact Int']]) {
    items.push({ key, label, section: 'MEMORY & COMPACTION', kind: 'numeric', value: numOrDefault(state[key]) });
  }
  // ── ADVANCED ──
  items.push({ key: 'usePalace',  label: 'Mem Palace', section: 'ADVANCED', kind: 'toggle', value: onOff(state.usePalace) });
  items.push({ key: 'noThinking', label: 'Thinking',   section: 'ADVANCED', kind: 'toggle', value: onOff(!state.noThinking) });
  // ── TUI ──
  items.push({ key: 'port', label: 'Port', section: 'TUI', kind: 'numeric', value: String(state.port) });
  items.push({ key: 'theme', label: 'Theme', section: 'TUI', kind: 'cycle', value: state.theme || 'aurora' });
  items.push({ key: 'density', label: 'Density', section: 'TUI', kind: 'cycle', value: state.density || 'comfortable' });
  return items;
}

function sectionRow(label, OW) {
  const inner = OW - 2;
  const visPrefix = `  ── ${label} `;
  const dashes = Math.max(0, inner - visPrefix.length);
  const content = `  ${C.bold}${C.grey}──${C.reset} ${C.bold}${label}${C.reset} ${C.grey}${'─'.repeat(dashes)}${C.reset}`;
  return vi(T.dv) + padEnd(content, inner) + vi(T.dv);
}

export function renderSettings(W, H) {
  const items = getSettingsItems();
  const OW = Math.min(78, W - 4);

  // Derive the row layout from the items' `section` (no hard-coded indices).
  const rows = [{ type: 'info' }, { type: 'blank' }];
  let lastSection = null;
  items.forEach((item, idx) => {
    if (item.section !== lastSection) {
      if (lastSection !== null) rows.push({ type: 'blank' });
      rows.push({ type: 'section', label: item.section });
      lastSection = item.section;
    }
    rows.push({ type: 'item', itemIdx: idx, item });
  });
  rows.push({ type: 'blank' }, { type: 'footer' });

  const OH = rows.length + 2;
  const sr = Math.max(1, Math.floor((H - OH) / 2));
  const sc = Math.floor((W - OW) / 2);

  let out = moveTo(sr, sc) + dboxTop(OW, ' SETTINGS ');
  rows.forEach((row, rowIdx) => {
    const line = sr + 1 + rowIdx;
    if (row.type === 'blank') {
      out += moveTo(line, sc) + dboxRow('', OW);
    } else if (row.type === 'info') {
      out += moveTo(line, sc) + dboxRow(`  ${gr('Live config. Saved to .agent/tui-settings.json (0600).')}  ${gr('[H]')} ${gr(state.showApiKey ? 'hide keys' : 'show keys')}`, OW);
    } else if (row.type === 'section') {
      out += moveTo(line, sc) + sectionRow(row.label, OW);
    } else if (row.type === 'footer') {
      const hint = state.settingsEditing
        ? `  ${g('[Enter]')} Save   ${gr('[Esc]')} Cancel   ${gr('[Backspace]')} Delete`
        : `  ${g('[Enter]')} Edit/Pick   ${gr('[↑↓]')} Navigate   ${gr('[H]')} Toggle keys   ${gr('[Esc]')} Close`;
      out += moveTo(line, sc) + dboxRow(hint, OW);
    } else if (row.type === 'item') {
      const item = row.item;
      const selected = row.itemIdx === state.settingsIdx;
      const editing = state.settingsEditing === item.key;
      const prefix = selected ? `${C.bold}${C.cyan}>${C.reset}` : ' ';
      const label = `${selected ? C.bold + C.white : C.grey}${item.label.padEnd(14)}${C.reset}`;

      let valueStr;
      if (editing) {
        valueStr = `${C.yellow}${state.settingsDraft}${C.reset}${C.bold}█${C.reset}`;
      } else if (item.kind === 'pick') {
        const col = item.key === 'provider' ? providerColor(item.value) : item.secret ? C.grey : C.cyan;
        valueStr = `${col}${item.value}${C.reset}  ${gr('→ choose')}`;
      } else if (item.kind === 'cycle') {
        valueStr = `${C.cyan}${item.value}${C.reset}  ${gr('[Enter] switch')}`;
      } else if (item.kind === 'toggle') {
        const on = item.value === 'on';
        valueStr = `${on ? C.green : C.grey}${item.value}${C.reset}  ${gr('[Enter] toggle')}`;
      } else if (item.kind === 'action') {
        const col = item.registryActive ? C.green : C.cyan;
        valueStr = `${col}${item.value}${C.reset}${item.registryActive ? '' : `  ${gr('[Enter] use')}`}`;
      } else if (item.secret) {
        valueStr = `${state[item.key] ? (state.showApiKey ? C.yellow : C.grey) : C.grey}${item.value}${C.reset}`;
      } else {
        valueStr = item.value;
      }
      out += moveTo(line, sc) + dboxRow(` ${prefix} ${label} ${valueStr}`, OW);
    }
  });
  out += moveTo(sr + rows.length + 1, sc) + dboxBot(OW);
  process.stdout.write(out);
}

function providerColor(p) {
  switch (p) {
    case 'ollama':    return C.green;
    case 'vllm':      return C.blue;
    case 'openai':    return C.cyan;
    case 'anthropic': return C.cyan;
    case 'openrouter':return C.violet;
    default:          return C.grey;
  }
}
