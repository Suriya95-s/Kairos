// apps/tui/src/views/council.js — the LLM Council view (5th panel) + lineup overlay.
import {
  C, g, y, r, gr, cy, vi, dim, bold, clip, padEnd, visLen, paint,
  dboxTop, dboxBot, dboxRow, moveTo, hideCursor,
} from '../render.js';
import { state } from '../state.js';

const STAGE_LABEL = { stage1: 'Stage 1/3 · answering', stage2: 'Stage 2/3 · ranking', stage3: 'Stage 3/3 · chairman synthesizing', done: 'Done', error: 'Error' };
const GLYPH = { pending: paint(C.ink4, '·'), running: paint(C.amber, '▶'), done: paint(C.jade, '✓'), failed: paint(C.coral, '✗') };

function wrap(text, width) {
  const out = [];
  for (const para of String(text || '').split('\n')) {
    if (!para) { out.push(''); continue; }
    let line = '';
    for (const word of para.split(/\s+/)) {
      if ((line + ' ' + word).trim().length > width) { if (line) out.push(line); line = word; }
      else line = line ? `${line} ${word}` : word;
    }
    if (line) out.push(line);
  }
  return out;
}

export function renderCouncil(W, H) {
  const c = state.council;
  const onModels = state.councilModels.filter(m => m.on);
  const title = ` ${vi('⚖ AI ARENA')}  ${c ? gr(STAGE_LABEL[c.status] || c.status) : gr(`${onModels.length} members · chairman: ${chairmanLabel()}`)}`;
  const body = [];

  if (!c) {
    body.push('');
    body.push(`  ${gr('Members')} ${gr('([m] manage models — toggle · add · chairman · [,] set OpenRouter key)')}`);
    for (const m of state.councilModels) {
      const star = m.id === state.councilChairman ? cy(' ★chair') : '';
      body.push(`   ${m.on ? g('●') : gr('○')} ${m.on ? m.label : gr(m.label)}${star}`);
    }
    body.push('');
    if (!state.openrouterKey) body.push(`  ${r('⚠ No OpenRouter key set')} ${gr('— add one in Settings (,) or /arena key sk-or-…')}`);
    body.push(`  ${gr('Type a topic below and press Enter to convene the Arena.')}`);
  } else {
    // Members + status
    body.push(`  ${gr('MEMBERS')}`);
    for (const m of c.members) {
      const err = m.status === 'failed' && m.error ? gr(` — ${clip(m.error, W - 24)}`) : '';
      const chair = m.id === c.chairman ? cy(' ★') : '';
      body.push(`   ${GLYPH[m.status] || ' '} ${m.label}${chair}${err}`);
    }
    body.push('');

    // Final synthesis first (most important), then the per-member answers/rankings.
    if (c.final) {
      body.push(`  ${bold(g('── FINAL'))} ${paint(C.ink2, `(chairman: ${labelFor(c.chairman)})`)} ${bold(g('──'))}`);
      for (const l of wrap(c.final, W - 4)) body.push(`  ${l}`);
      body.push('');
    } else if (c.error) {
      body.push(`  ${r('✗ ' + c.error)}`);
      body.push('');
    }

    for (const m of c.members.filter(x => x.status === 'done')) {
      body.push(`  ${cy('▸ ' + m.label)}`);
      for (const l of wrap(m.answer, W - 4)) body.push(`  ${dim(l)}`);
      if (m.rankText) { body.push(`    ${gr('ranked:')} ${gr(clip(m.rankText.replace(/\n/g, ' '), W - 14))}`); }
      body.push('');
    }
  }

  // Window the body by councilScroll; reserve row 0 for the title.
  const viewH = Math.max(1, H - 1);
  const scroll = Math.max(0, Math.min(state.councilScroll, Math.max(0, body.length - viewH)));
  const lines = [padEnd(title, W), ...body.slice(scroll, scroll + viewH).map(l => padEnd(l, W))];
  return lines;
}

// Modal overlay to toggle members + pick the chairman.
export function renderCouncilConfig(W, H) {
  const models = state.councilModels;
  const OW = Math.min(70, W - 4);
  const rows = [
    '',
    `  ${gr('Space toggle · ')}${cy('*')}${gr(' chairman · ')}${cy('a')}${gr(' add model · ')}${cy('d')}${gr(' remove · ↑↓ move · Esc save')}`,
    '',
    ...models.map((m, i) => {
      const sel = i === state.councilCfgIdx;
      const prefix = sel ? `${C.bold}${C.cyan}>${C.reset}` : ' ';
      const box = m.on ? g('[x]') : gr('[ ]');
      const chair = m.id === state.councilChairman ? cy(' ★ chair') : '';
      const name = sel ? `${C.bold}${C.white}${m.label}${C.reset}` : (m.on ? m.label : gr(m.label));
      return ` ${prefix} ${box} ${name}${chair}  ${gr(m.id)}`;
    }),
    '',
  ];
  const OH = rows.length + 2;
  const sr = Math.max(1, Math.floor((H - OH) / 2));
  const sc = Math.floor((W - OW) / 2);
  let out = moveTo(sr, sc) + dboxTop(OW, ' AI ARENA LINEUP ');
  rows.forEach((line, i) => { out += moveTo(sr + 1 + i, sc) + dboxRow(line, OW); });
  out += moveTo(sr + rows.length + 1, sc) + dboxBot(OW);
  process.stdout.write(out + hideCursor);
}

function chairmanLabel() { return labelFor(state.councilChairman); }
function labelFor(id) { return (state.councilModels.find(m => m.id === id) || {}).label || id; }
