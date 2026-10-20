// apps/tui/src/views/picker.js — reusable searchable dropdown overlay.
// Keyboard-only: type to filter, ↑↓ to move, Enter to select, Tab to fetch a live
// model list, Esc to cancel. Used for provider / API key / endpoint / model.
import { C, g, y, r, gr, cy, bold, clip, padEnd, visLen, dboxTop, dboxBot, dboxRow, moveTo, hideCursor } from '../render.js';
import { state } from '../state.js';
import { PROVIDER_PRESETS, PROVIDER_MODELS } from './settings.js';

export const API_PROVIDERS = ['openai', 'anthropic', 'openrouter', 'custom'];
export const LOCAL_ENDPOINT_PRESETS = [
  { value: 'http://localhost:11434/v1', label: 'Ollama' },
  { value: 'http://localhost:8000/v1',  label: 'vLLM / SGLang' },
  { value: 'http://localhost:1234/v1',  label: 'LM Studio' },
];

const last4 = (k) => { const s = String(k || ''); return s.length <= 4 ? s : '…' + s.slice(-4); };

// The "scope" a model list belongs to: the provider (API) or the endpoint (Local).
export function modelScope() {
  return state.modelSource === 'api' ? (state.provider || 'openai') : (state.serverUrl || 'local');
}

function dedup(items) {
  const seen = new Set();
  return items.filter(i => (seen.has(i.value) ? false : (seen.add(i.value), true)));
}

/**
 * Build the (unfiltered) item set for a picker kind. Pure — reads `state` only.
 * @returns {{ title, items:{value,label,sub?,tag?}[], allowCustom:boolean, customHint?:string, refreshable?:boolean }}
 */
export function buildPickerItems(kind) {
  switch (kind) {
    case 'provider':
      return {
        title: 'SELECT PROVIDER',
        items: API_PROVIDERS.map(p => ({ value: p, label: p, sub: PROVIDER_PRESETS[p] || '' })),
        allowCustom: false,
      };
    case 'apiKey': {
      const prov = state.provider || '';
      const items = (state.keyHistory || [])
        .filter(k => k.provider === prov)
        .map(k => ({ value: k.key, label: k.last4 || last4(k.key), sub: prov, tag: 'saved' }));
      return { title: `API KEY · ${prov}`, items, allowCustom: true, customHint: 'type a new key' };
    }
    case 'endpoint': {
      const recent = (state.recentEndpoints || []).map(e => ({ value: e, label: e, tag: 'recent' }));
      const presets = LOCAL_ENDPOINT_PRESETS.map(p => ({ value: p.value, label: p.label, sub: p.value }));
      return { title: 'LOCAL ENDPOINT', items: dedup([...recent, ...presets]), allowCustom: true, customHint: 'type a new endpoint URL' };
    }
    case 'arenaAdd': {
      // Add a model to the AI Arena lineup. OpenRouter-scoped (the Arena runs on
      // OpenRouter); excludes models already in the lineup. [Tab] fetches the live
      // catalog; any custom id can be typed.
      const scope = 'openrouter';
      const curated = PROVIDER_MODELS.openrouter || [];
      const recent = (state.recentModels && state.recentModels[scope]) || [];
      const fetched = (state.fetchedModels && state.fetchedModels[scope]) || [];
      const inLineup = new Set((state.councilModels || []).map(m => m.id));
      const ids = [...new Set([...recent, ...fetched, ...curated])].filter(id => !inLineup.has(id));
      return {
        title: 'ADD ARENA MODEL',
        items: ids.map(id => ({ value: id, label: id, tag: recent.includes(id) ? 'recent' : fetched.includes(id) ? 'live' : '' })),
        allowCustom: true, customHint: 'type a model id (OpenRouter)', refreshable: true,
      };
    }
    case 'model':
    default: {
      const scope = modelScope();
      const curated = state.modelSource === 'api' ? (PROVIDER_MODELS[scope] || []) : [];
      const recent = (state.recentModels && state.recentModels[scope]) || [];
      const fetched = (state.fetchedModels && state.fetchedModels[scope]) || [];
      const ids = [...new Set([...recent, ...fetched, ...curated])];
      return {
        title: `MODEL · ${clip(String(scope), 40)}`,
        items: ids.map(id => ({ value: id, label: id, tag: recent.includes(id) ? 'recent' : fetched.includes(id) ? 'live' : '' })),
        allowCustom: true, customHint: 'type a custom model id', refreshable: true,
      };
    }
  }
}

/** Apply the type-to-filter and (when custom is allowed) a synthetic "use <typed>" item. */
export function filteredItems(kind) {
  const { items, allowCustom } = buildPickerItems(kind);
  const f = (state.pickerFilter || '').toLowerCase();
  let out = f ? items.filter(i => `${i.label} ${i.value} ${i.sub || ''}`.toLowerCase().includes(f)) : items.slice();
  if (allowCustom && f && !items.some(i => String(i.value).toLowerCase() === f)) {
    out = [{ value: state.pickerFilter, label: `use "${state.pickerFilter}"`, tag: 'custom', custom: true }, ...out];
  }
  return out;
}

export function renderPicker(W, H) {
  const meta = buildPickerItems(state.pickerKind);
  const items = filteredItems(state.pickerKind);
  const OW = Math.min(76, W - 4);
  const maxVisible = Math.min(Math.max(items.length, 1), Math.max(3, Math.floor(H * 0.5)));
  const idx = Math.max(0, Math.min(state.pickerIdx, Math.max(0, items.length - 1)));
  const start = Math.max(0, Math.min(idx - Math.floor(maxVisible / 2), Math.max(0, items.length - maxVisible)));
  const visible = items.slice(start, start + maxVisible);

  const rows = [];
  rows.push(` ${gr('search:')} ${state.pickerFilter || ''}${C.bold}█${C.reset}${state.pickerFetching ? `  ${y('⠿ fetching…')}` : ''}`);
  rows.push(gr('─'.repeat(Math.max(0, OW - 2))));
  if (!visible.length) rows.push(`  ${gr('(no matches' + (meta.refreshable ? ' — Tab to fetch from the server' : '') + ')')}`);
  visible.forEach((it, i) => {
    const sel = (start + i) === idx;
    const prefix = sel ? `${C.bold}${C.cyan}>${C.reset}` : ' ';
    const name = sel ? `${C.bold}${C.white}${it.label}${C.reset}` : (it.custom ? cy(it.label) : it.label);
    const tag = it.tag ? `  ${gr('[' + it.tag + ']')}` : '';
    const sub = it.sub && it.sub !== it.label ? `  ${gr(clip(it.sub, Math.max(0, OW - visLen(it.label) - 16)))}` : '';
    rows.push(` ${prefix} ${name}${tag}${sub}`);
  });
  rows.push('');
  const hint = meta.allowCustom ? `[type] filter/${meta.customHint}` : '[type] filter';
  rows.push(`  ${gr(`[↑↓] move  [Enter] select  ${hint}${meta.refreshable ? '  [Tab] fetch live' : ''}  [Esc] cancel`)}`);

  const OH = rows.length + 2;
  const sr = Math.max(1, Math.floor((H - OH) / 2));
  const sc = Math.floor((W - OW) / 2);
  let out = moveTo(sr, sc) + dboxTop(OW, ` ${meta.title} `);
  rows.forEach((line, i) => { out += moveTo(sr + 1 + i, sc) + dboxRow(line, OW); });
  out += moveTo(sr + rows.length + 1, sc) + dboxBot(OW);
  process.stdout.write(out + hideCursor);
}

/** GET {baseURL}/models (OpenAI-compatible) → list of model ids. */
export async function fetchModels(baseURL, key) {
  const url = `${String(baseURL || '').replace(/\/$/, '')}/models`;
  const res = await fetch(url, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  return list.map(m => m.id || m.name).filter(Boolean);
}
