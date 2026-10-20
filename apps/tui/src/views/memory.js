// src/views/memory.js — palace events + skills + reflections

import {
  twoColTop, twoColBot, twoColRow,
  C, g, y, r, gr, bold, cell, padEnd,
} from '../render.js';
import { state } from '../state.js';

const GRADE_COLOR = { A: C.jade, B: C.aqua, C: C.amber, D: C.coral };

export function renderMemory(W, H) {
  const lW = Math.floor(W * 0.52);
  const rW = W - lW;
  const contentH = H - 2;
  const lines = [];

  const modeHints = `[R]ooms  [T]empo  [/]Search`;
  lines.push(twoColTop(W, [`PALACE  ${gr(modeHints)}`, 'SKILLS & REFLECTIONS']));

  const leftRows  = buildPalaceRows(lW - 1, contentH);
  const rightRows = buildRightRows(rW - 1, contentH);

  for (let i = 0; i < contentH; i++) {
    lines.push(twoColRow(W, leftRows[i] || '', rightRows[i] || ''));
  }

  lines.push(twoColBot(W));
  return lines;
}

// ── Palace panel (left) ───────────────────────────────────────────────────────

function buildPalaceRows(w, h) {
  const rows = [];

  if (state.memMode === 'search') {
    rows.push(` ${C.sky}Search:${C.reset} ${state.memSearch}${state.memSearchActive ? '▏' : ''}`);
    rows.push('');
  }

  const events = filteredEvents();
  const start  = Math.max(0, state.memScroll);
  const slice  = events.slice(start, start + h - rows.length - 2);

  if (!slice.length && !events.length) {
    rows.push(gr(' No palace events yet.'));
  }

  for (const ev of slice) {
    const who   = ev.who === 'user' ? y('user') : gr('kairos');
    const step  = ev.step ? gr(`step ${ev.step}`) : '';
    rows.push(` ${C.aqua}▸${C.reset} ${C.bold}${ev.tool || ev.type || '?'}${C.reset}  ${step}  ${who}`);
    if (ev.summary) {
      rows.push(`   ${gr(ev.summary.slice(0, w - 4))}`);
    }
    rows.push('');
  }

  if (state.memScroll > 0) rows.push(gr(` ↑ ${state.memScroll} above`));

  rows.push(gr(' [↑↓] scroll  [Enter] expand'));
  return rows.slice(0, h);
}

function filteredEvents() {
  if (state.memMode === 'search' && state.memSearch) {
    const q = state.memSearch.toLowerCase();
    return state.palaceEvents.filter(e =>
      (e.summary || '').toLowerCase().includes(q) ||
      (e.tool || '').toLowerCase().includes(q)
    );
  }
  return state.palaceEvents;
}

// ── Right panel (skills + reflections) ───────────────────────────────────────

function buildRightRows(w, h) {
  const rows = [];

  // SKILLS
  rows.push(gr(' SKILLS'));
  rows.push(` ${'Name'.padEnd(Math.max(10, w - 18))} ${'Grade'.padEnd(6)} ${'Reuse'}`);
  rows.push(` ${gr('─'.repeat(w - 2))}`);

  if (!state.skills.length) {
    rows.push(gr(' No skills loaded.'));
  } else {
    for (const sk of state.skills.slice(0, 8)) {
      const col   = GRADE_COLOR[sk.grade] || C.grey;
      const grade = `${col}${sk.grade || '?'}${C.reset}`;
      const reuse = String(sk.reuse ?? 0);
      const name  = sk.name.slice(0, w - 14);
      rows.push(` ${name.padEnd(Math.max(10, w - 14))}  ${grade}      ${gr(reuse)}`);
    }
  }

  rows.push('');
  rows.push(gr(' [Tab] → reflections'));
  rows.push('');

  // REFLECTIONS
  rows.push(gr(' REFLECTIONS'));
  rows.push(` ${gr('─'.repeat(w - 2))}`);

  if (!state.reflections.length) {
    rows.push(gr(' No past reflections.'));
  } else {
    for (const ref of state.reflections.slice(0, 5)) {
      const scoreColor = (ref.score >= 4) ? C.green : (ref.score >= 2) ? C.yellow : C.red;
      rows.push(` ${gr(ref.episodeId?.slice(-9) || '?')}  ${ref.ago || ''}`);
      rows.push(`   Exit: ${ref.exit}   Score: ${scoreColor}${ref.score}/5${C.reset}`);
      rows.push(`   Steps: ${ref.steps}   Cost: $${(ref.costUsd || 0).toFixed(3)}`);
      rows.push('');
    }
  }

  return rows.slice(0, h);
}
