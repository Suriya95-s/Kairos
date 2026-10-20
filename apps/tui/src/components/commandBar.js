// src/components/commandBar.js - command bar and contextual hints

import { C, padEnd, gr, visLen } from '../render.js';
import { state } from '../state.js';

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function renderCommandBar(W) {
  const lines = [];

  // Attachment chips (F-3): dropped files queued for the next steer.
  if (state.attachments && state.attachments.length) {
    const chips = state.attachments
      .map(a => `${C.green}📎 ${a.name}${C.reset} ${gr(`(${fmtBytes(a.bytes)})`)}`)
      .join(gr('  '));
    lines.push(padEnd(` ${chips}   ${gr('[Enter] send  [Esc] clear')}`, W));
  }

  if (state.cmdInputActive && state.cmdSuggestions.length > 0) {
    for (const [i, suggestion] of state.cmdSuggestions.slice(0, 6).entries()) {
      const selected = i === state.cmdSugIdx;
      const cmdCol = selected ? `${C.bold}${C.cyan}` : C.grey;
      const descCol = selected ? C.white : C.grey;
      lines.push(
        padEnd(
          ` ${cmdCol}${suggestion.cmd.padEnd(14)}${C.reset}  ${descCol}${suggestion.description}${C.reset}`,
          W
        )
      );
    }
  }

  lines.push(renderInputLine(W));
  lines.push(renderHintsLine(W));
  return lines;
}

function renderInputLine(W) {
  if (state.overlay === 'steer') {
    return padEnd(` ${C.blue}STEER>${C.reset} ${state.steerInput}${C.reset}`, W);
  }
  if (state.denyInputActive) {
    return padEnd(` ${C.yellow}DENY REASON>${C.reset} ${state.denyInput}${C.reset}`, W);
  }
  if (state.memSearchActive) {
    return padEnd(` ${C.blue}SEARCH>${C.reset} ${state.memSearch}${C.reset}`, W);
  }
  if (state.cmdInputActive) {
    const prefix = state.cmdInput.startsWith('/') ? C.cyan : state.view === 'chat' ? C.white : C.reset;
    return padEnd(` ${C.bold}>${C.reset} ${prefix}${state.cmdInput}${C.reset}█`, W);
  }
  if (state.overlay === 'help' || state.overlay === 'session_end') {
    return padEnd(` ${gr('[any key] dismiss')}`, W);
  }
  if (state.view === 'chat') {
    const pendingStr = state.chatPending ? `  ${C.yellow}⠿ thinking...${C.reset}` : '';
    return padEnd(` ${C.grey}> Type a message and press Enter (/ for commands)${C.reset}${pendingStr}`, W);
  }
  if (state.view === 'council') {
    const live = state.council && ['stage1', 'stage2', 'stage3'].includes(state.council.status);
    const busy = live ? `  ${C.yellow}⠿ deliberating...${C.reset}` : '';
    return padEnd(` ${C.grey}> Enter a topic for the AI Arena  ·  [m] manage models  ·  / for commands${C.reset}${busy}`, W);
  }
  if (state.view === 'ontology') {
    return padEnd(` ${C.bold}▌${C.reset} ${C.grey}drag a file or folder onto this window to build its ontology  ·  / for commands${C.reset}`, W);
  }
  const drop = state.attachments && state.attachments.length ? '' : `${C.grey} · drop a file to attach${C.reset}`;
  return padEnd(` ${C.bold}▌${C.reset} ${C.grey}message the agent — Enter to inject mid-loop${C.reset}${C.grey}  ·  / for commands${C.reset}${drop}`, W);
}

function renderHintsLine(W) {
  if (state.overlay === 'help' || state.overlay === 'session_end') {
    return padEnd(` ${gr('[any key] dismiss')}`, W);
  }

  if (state.cmdInputActive) {
    if (state.cmdInput.startsWith('/')) {
      return padEnd(` ${gr('Tab')} complete  ${gr('[Up/Down]')} history  ${gr('Enter')} run  ${gr('Esc')} cancel`, W);
    }
    if (state.view === 'chat') {
      return padEnd(` ${gr('Enter')} send  ${gr('[Up/Down]')} history  ${gr('Esc')} cancel`, W);
    }
    return padEnd(` ${gr('Enter')} steer agent  ${gr('[Up/Down]')} history  ${gr('Esc')} cancel  ${gr('Tip: type / for commands')}`, W);
  }

  if (state.view === 'chat') {
    return padEnd(` ${gr('[PgUp/PgDn]')} scroll  ${gr('[↑↓]')} scroll  ${gr('[/clearchat]')} clear  ${gr('[Q]')} Quit`, W);
  }

  const tabs = [
    ['live', hint('1', 'Live', state.view === 'live', state.pendingApprovals.length > 0 ? 'yellow' : null)],
    ['memory', hint('2', 'Memory', state.view === 'memory')],
    ['metrics', hint('3', 'Metrics', state.view === 'metrics')],
    ['chat', hint('4', 'Chat', state.view === 'chat')],
    ['council', hint('5', 'AI Arena', state.view === 'council')],
    ['voice', hint('6', 'Voice', state.view === 'voice', state.voice?.speaking ? 'yellow' : null)],
    ['ontology', hint('7', 'Graph', state.view === 'ontology', null)],
    ['settings', hint(',', 'Settings', state.settingsOpen)],
  ];
  const base = tabs.map(([, t]) => t);

  const actions = [];

  if (state.pendingApprovals.length > 0) {
    actions.push(`${C.bold}${C.green}[A]${C.reset} Approve`);
    actions.push(`${C.bold}${C.red}[D]${C.reset} Deny`);
  }

  // View-specific keys (Workstream B — discoverability without opening help).
  if (state.view === 'live') {
    actions.push(gr('[↑↓] steps'), gr('[Enter] pin'), gr('[L] layout'), gr('[M] model'));
  } else if (state.view === 'memory') {
    actions.push(gr('[T] Temporal'), gr('[R] Rooms'), gr('[/] Search'), gr('[Tab] panel'));
  } else if (state.view === 'metrics') {
    actions.push(gr('[E] Export'));
  } else if (state.view === 'council') {
    actions.push(gr('[M] lineup'));
  }

  actions.push(`${C.bold}${C.cyan}[/]${C.reset} Commands`);
  actions.push(gr('[?] Help'));
  actions.push(`${C.bold}${C.red}[Q]${C.reset} Quit`);

  // Responsive: nav tabs duplicate the top tab bar, so when the view-specific
  // action hints push us past the terminal width we shed tabs (not the keys).
  // Step down gracefully: full bar → active tab only → actions only.
  const activeTab = tabs.find(([v]) => v === state.view);
  const candidates = [
    base,
    activeTab ? [activeTab[1]] : [],
    [],
  ];
  let line = '';
  for (const navs of candidates) {
    line = navs.length
      ? ' ' + [...navs, '  ', ...actions].join('  ')
      : ' ' + actions.join('  ');
    if (visLen(line) <= W) break;
  }
  return padEnd(line, W);
}

function hint(key, label, active, colour) {
  const col = colour === 'yellow' ? C.yellow : active ? C.cyan : '';
  const rst = col ? C.reset : '';
  return `${C.bold}${col}[${key}]${rst} ${col}${label}${rst}`;
}
