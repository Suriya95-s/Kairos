// src/views/metrics.js — latency histogram + cost + quality

import {
  boxTop, boxBot, boxRow,
  C, g, y, r, gr, bold, cell, padEnd,
} from '../render.js';
import { state, avgLatency, latencyP } from '../state.js';

/**
 * Read the persistent spend ledger (kernel/usage.js) — the same numbers
 * `kairos usage` prints. File-backed, so it works DISCONNECTED too: the
 * session metrics above need a connected agent, the ledger only needs disk.
 * Never throws; the caller folds the result into state.spend.
 */
export async function probeSpend() {
  const out = { month: '', monthly: null, allTime: null };
  try {
    const usage = await import('../../../../src/kernel/usage.js');
    out.month = new Date().toISOString().slice(0, 7);
    out.monthly = usage.summarizeUsage({ month: out.month });
    out.allTime = usage.summarizeUsage({ all: true });
  } catch { /* view renders the empty state */ }
  return out;
}

export function renderMetrics(W, H) {
  const lines = [];
  lines.push(boxTop(W, 'SESSION METRICS'));

  const iW = W - 4;  // inner content width
  const row = (content = '') => lines.push(boxRow('  ' + content, W));

  row();
  row(`${gr('Episode:')}   ${state.episodeId || '—'}`);
  row(`${gr('Task:')}      ${(state.task || '—').slice(0, iW - 14)}`);
  row(`${gr('Status:')}    ${statusStr()}`);
  row();

  // LATENCY
  row(sectionRule('LATENCY', iW - 12));
  const avg = avgLatency();
  const p50 = latencyP(0.50);
  const p95 = latencyP(0.95);
  const p99 = latencyP(0.99);
  const max = state.stepLatenciesMs.length ? Math.max(...state.stepLatenciesMs) : 0;
  if (avg > 0) {
    row(`avg: ${fmt(avg)}   p50: ${fmt(p50)}   p95: ${fmt(p95)}   p99: ${fmt(p99)}   max: ${fmt(max)}`);
    row();
    row(bold('Step latency histogram (last 40 steps):'));
    const buckets = buildBuckets(state.stepLatenciesMs.slice(-40));
    for (const b of buckets) {
      const barW = Math.floor((b.count / (state.stepLatenciesMs.slice(-40).length || 1)) * Math.min(40, iW - 20));
      const bar  = '█'.repeat(barW);
      const barC = b.label.includes('5s') ? C.amber : b.label.includes('3') ? C.aqua : C.aqua;
      row(`${b.label.padEnd(8)}  ${barC}${bar}${C.reset}  ${gr(String(b.count))}`);
    }
  } else {
    row(gr('No latency data yet.'));
  }
  row();

  // COST
  row(sectionRule('COST', iW - 8));
  row(`total: ${C.green}$${state.costUsd.toFixed(3)}${C.reset}     ` +
      `input: ${state.totalTokens.toLocaleString()} tok     ` +
      `avg/step: $${state.step > 0 ? (state.costUsd / state.step).toFixed(4) : '0.0000'}`);
  row();

  // SPEND LEDGER — the persistent meter (kernel/usage.js), not this session.
  // Real API-returned token counts; works even with no agent connected.
  row(sectionRule('SPEND LEDGER', iW - 16));
  const sp = state.spend?.data;
  if (sp?.monthly?.records || sp?.allTime?.records) {
    const m = sp.monthly.totals;
    const a = sp.allTime.totals;
    row(`${gr(`this month (${sp.month}):`)} ${sp.monthly.records} call(s)  ` +
        `${m.promptTokens.toLocaleString()} in + ${m.completionTokens.toLocaleString()} out  ${C.green}${usdStr(m.cost)}${C.reset}` +
        (m.unpricedTokens > 0 ? `  ${y(`⚠ ${m.unpricedTokens.toLocaleString()} tok unpriced`)}` : ''));
    row(`${gr('all time:')}            ${sp.allTime.records} call(s)  ` +
        `${a.totalTokens.toLocaleString()} tok  ${C.green}${usdStr(a.cost)}${C.reset}  ${gr(`(${sp.allTime.months.length} month(s))`)}`);
    const purposes = Object.entries(sp.monthly.byPurpose || {})
      .sort(([, x], [, z]) => z.cost - x.cost || z.totalTokens - x.totalTokens)
      .slice(0, 4);
    for (const [name, b] of purposes) {
      row(`  ${C.cyan}${name.padEnd(18).slice(0, 18)}${C.reset} ${String(b.calls).padStart(4)} call(s)  ` +
          `${b.totalTokens.toLocaleString().padStart(10)} tok  ${usdStr(b.cost)}`);
    }
    row(gr('full breakdown: kairos usage [--all]'));
  } else {
    row(gr('no model calls in the ledger yet — it starts with the first completion'));
  }
  row();

  // PER-STAGE breakdown (cost + latency)
  const stages = state.stageMetrics || {};
  const stageNames = Object.keys(stages).filter(s => (stages[s].steps || 0) > 0);
  if (stageNames.length > 0) {
    row(sectionRule('PER-STAGE', iW - 13));
    row(`${gr('stage'.padEnd(14))}${gr('steps'.padEnd(8))}${gr('avg lat'.padEnd(10))}${gr('tokens'.padEnd(10))}${gr('$')}`);
    // Canonical stage order, then any extras
    const ORDER = ['intake', 'discovery', 'planning', 'execution', 'verification', 'finalization', 'unknown'];
    const sorted = stageNames.sort((a, b) => {
      const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
    for (const s of sorted) {
      const m = stages[s];
      row(`${C.cyan}${s.padEnd(14)}${C.reset}${String(m.steps).padEnd(8)}${fmt(m.avgLatencyMs).padEnd(10)}${String(m.tokens).padEnd(10)}$${(m.dollars || 0).toFixed(3)}`);
    }
    row();
  }

  // QUALITY
  row(sectionRule('QUALITY', iW - 11));
  const errRate = state.step > 0 ? ((state.errors / state.step) * 100).toFixed(1) : '0.0';
  row(`errors: ${state.errors > 0 ? r(String(state.errors)) : g('0')} (${errRate}%)    ` +
      `hallucinations: ${state.hallucinations > 0 ? r(String(state.hallucinations)) : g('0')}    ` +
      `compactions: ${state.compactions}`);
  row(`skills created: ${state.skillsCreated}    ` +
      `HITL gates: ${state.hitlTotal} (${g(String(state.hitlApproved))} approved, ${r(String(state.hitlDenied))} denied)`);
  row();

  // MODEL
  row(sectionRule('MODEL', iW - 9));
  row(`model: ${C.cyan}${state.model || '—'}${C.reset}`);
  if (state.controllerInfo) {
    const ci = state.controllerInfo;
    const modeC = ci.mode === 'rwkv' ? C.green : C.grey;
    const conf = ci.mode === 'rwkv' ? `  conf: ${(ci.confidence || 0).toFixed(2)}` : '';
    const fb = ci.fallbackReason ? `  ${gr('(' + ci.fallbackReason + ')')}` : '';
    row(`controller: ${modeC}${ci.mode || '—'}${C.reset}${conf}${fb}`);
  }
  row();
  row(gr('[E] export to .agent/tui-export.json'));
  row();

  lines.push(boxBot(W));

  while (lines.length < H) lines.push('');
  return lines.slice(0, H);
}

// Aurora section divider: dim structural dashes (C.edge) with a bold iris label.
// Keeps the exact `── LABEL ──…` token shape, color-only.
function sectionRule(label, dashCount) {
  const lead = `${C.edge}──${C.reset} `;
  const name = `${C.iris}${bold(label)}${C.reset}`;
  const tail = ` ${C.edge}${'─'.repeat(Math.max(0, dashCount))}${C.reset}`;
  return lead + name + tail;
}

function statusStr() {
  switch (state.status) {
    case 'running':    return `${C.green}RUNNING${C.reset} (step ${state.step})`;
    case 'paused':     return `${C.yellow}PAUSED${C.reset} (step ${state.step})`;
    case 'completed':  return `${C.cyan}COMPLETED${C.reset} — ${state.step} steps`;
    case 'error':      return `${C.red}ERROR${C.reset}`;
    default:           return `${C.grey}DISCONNECTED${C.reset}`;
  }
}

function fmt(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function usdStr(cost) {
  return cost > 0 && cost < 0.0001 ? '<$0.0001' : `$${cost.toFixed(4)}`;
}

function buildBuckets(latencies) {
  const buckets = [
    { label: '0–1s',  min: 0,    max: 1000,  count: 0 },
    { label: '1–2s',  min: 1000, max: 2000,  count: 0 },
    { label: '2–3s',  min: 2000, max: 3000,  count: 0 },
    { label: '3–5s',  min: 3000, max: 5000,  count: 0 },
    { label: '5s+',   min: 5000, max: Infinity, count: 0 },
  ];
  for (const v of latencies) {
    for (const b of buckets) {
      if (v >= b.min && v < b.max) { b.count++; break; }
    }
  }
  return buckets.filter(b => b.count > 0);
}
