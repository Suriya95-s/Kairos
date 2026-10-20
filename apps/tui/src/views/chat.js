// src/views/chat.js — direct LLM chat view with tool use

import { boxTop, boxBot, boxRow, C, reducedMotion } from '../render.js';
import { state } from '../state.js';

const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

function wrapText(text, width) {
  if (width <= 0) return [String(text)];
  const out = [];
  for (const rawLine of String(text).split('\n')) {
    if (!rawLine) { out.push(''); continue; }
    let rem = rawLine;
    while (rem.length > width) {
      let cut = rem.lastIndexOf(' ', width);
      if (cut <= 0) cut = width;
      out.push(rem.slice(0, cut));
      rem = rem.slice(cut).trimStart();
    }
    if (rem) out.push(rem);
  }
  return out.length ? out : [''];
}

function fmtArgs(args, maxValLen = 60) {
  return Object.entries(args || {}).map(([k, v]) => {
    const valStr = typeof v === 'string'
      ? (v.length > maxValLen ? v.slice(0, maxValLen) + '…' : v)
      : JSON.stringify(v).slice(0, maxValLen);
    return [k, valStr];
  });
}

function buildLines(W) {
  // text width inside box: W - 2(borders) - 2(indent) - 2(│+space)
  const textW = Math.max(20, W - 6);
  const lines = [];

  if (!state.chatMessages.length && !state.chatPending) {
    lines.push('');
    lines.push(`  ${C.grey}No messages yet — type a message and press Enter.${C.reset}`);
    const model = state.model || '(not set)';
    const url   = state.serverUrl || '(not set)';
    lines.push(`  ${C.grey}Model: ${C.cyan}${model}${C.reset}${C.grey}   Server: ${C.cyan}${url}${C.reset}`);
    lines.push('');
    lines.push(`  ${C.grey}Tools available: read_file, write_file, delete_file, list_dir, run_command${C.reset}`);
    lines.push(`  ${C.grey}Use ${C.cyan}/settings${C.reset}${C.grey} to configure model/server, ${C.cyan}/clearchat${C.reset}${C.grey} to clear history.${C.reset}`);
    return lines;
  }

  for (const msg of state.chatMessages) {
    lines.push('');
    const ts = new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    if (msg.role === 'user') {
      lines.push(`  ${C.bold}${C.ink3}You${C.reset}  ${C.grey}${ts}${C.reset}`);
      for (const line of wrapText(msg.content, textW)) {
        lines.push(`  ${C.cyan}│${C.reset} ${line}`);
      }

    } else if (msg.role === 'assistant') {
      const latStr = msg.latencyMs ? `  ${C.grey}[${(msg.latencyMs / 1000).toFixed(1)}s]${C.reset}` : '';
      const col = msg.error ? C.red : C.green;
      const labelCol = msg.error ? C.coral : C.iris;
      const label = (state.model || 'assistant').slice(0, 24);
      lines.push(`  ${C.bold}${labelCol}${label}${C.reset}  ${C.grey}${ts}${C.reset}${latStr}`);
      const contentLines = wrapText(msg.content, textW);
      contentLines.forEach((line, i) => {
        if (msg.error) {
          const lead = i === 0 ? `${C.amber}⚠ ${C.reset}` : '   ';
          lines.push(`  ${col}│${C.reset} ${lead}${C.ink3}${line}${C.reset}`);
        } else {
          lines.push(`  ${col}│${C.reset} ${line}`);
        }
      });

    } else if (msg.role === 'tool_call') {
      const icon = msg.approved === null ? `${C.yellow}${SPIN[state._spinFrame % SPIN.length]}${C.reset}`
                 : msg.approved          ? `${C.green}✔${C.reset}`
                 :                         `${C.red}✗${C.reset}`;
      const statusStr = msg.approved === null ? `${C.yellow}awaiting approval${C.reset}`
                      : msg.approved          ? `${C.green}approved${C.reset}`
                      :                         `${C.red}denied${C.reset}`;
      lines.push(`  ${C.aqua}⚙ ${C.reset}${icon} ${C.bold}${C.yellow}${msg.name}${C.reset}  ${statusStr}`);
      for (const [k, v] of fmtArgs(msg.args)) {
        lines.push(`  ${C.grey}│ ${k}: ${C.reset}${v}`);
      }

    } else if (msg.role === 'tool') {
      const resultLines = wrapText(msg.content.slice(0, 800), textW);
      const truncated = msg.content.length > 800;
      lines.push(`  ${C.aqua}⚙ ${C.reset}${C.grey}${msg.name} result${C.reset}`);
      for (const line of resultLines.slice(0, 8)) {
        lines.push(`  ${C.grey}│${C.reset}${C.dim} ${line}${C.reset}`);
      }
      if (resultLines.length > 8 || truncated) {
        lines.push(`  ${C.grey}│ …(truncated)${C.reset}`);
      }
    }
  }

  if (state.chatPending) {
    lines.push('');
    const spinGlyph = reducedMotion() ? '▷' : SPIN[state._spinFrame % SPIN.length];
    lines.push(`  ${C.amber}${spinGlyph}${C.reset}  ${C.grey}Thinking...${C.reset}`);
  }

  lines.push('');
  return lines;
}

export function renderChat(W, H) {
  const lines = [];
  lines.push(boxTop(W, 'CHAT'));

  const contentH = H - 2;
  const all = buildLines(W);
  const total = all.length;
  const maxScroll = Math.max(0, total - contentH);
  const scroll = Math.min(state.chatScroll, maxScroll);
  // scroll=0 → bottom (latest); higher = scrolled up
  const startIdx = Math.max(0, total - contentH - scroll);
  const visible = all.slice(startIdx, startIdx + contentH);

  for (let i = 0; i < contentH; i++) {
    lines.push(boxRow(visible[i] || '', W));
  }

  lines.push(boxBot(W));
  return lines;
}
