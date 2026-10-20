// src/keys.js — raw keypress parser for Node stdin in raw mode

export const KEYS = {
  UP:      'UP',
  DOWN:    'DOWN',
  LEFT:    'LEFT',
  RIGHT:   'RIGHT',
  PGUP:    'PGUP',
  PGDN:    'PGDN',
  HOME:    'HOME',
  END:     'END',
  ENTER:   'ENTER',
  BACKSPACE: 'BACKSPACE',
  DELETE:  'DELETE',
  TAB:     'TAB',
  ESC:     'ESC',
  F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4',
  F5: 'F5', F6: 'F6', F7: 'F7', F8: 'F8',
  CTRL_C:  'CTRL_C',
  CTRL_L:  'CTRL_L',
};

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (typeof input === 'string') return Buffer.from(input, 'utf8');
  return Buffer.from(input || []);
}

/**
 * Extract candidate file paths from pasted/dropped text (F-3). Terminals deliver
 * a file drop as the path(s) inside a bracketed paste — newline- or space-separated,
 * sometimes quoted or backslash-escaped. Returns candidates; the caller checks which
 * actually exist on disk. Pure + exported for testing.
 * @param {string} text
 * @returns {string[]}
 */
export function extractPastePaths(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const quoted = t.match(/^(['"])(.*)\1$/);          // "whole line is a quoted path"
    if (quoted) { out.push(quoted[2]); continue; }
    if (t.includes('\\ ')) { out.push(t.replace(/\\ /g, ' ')); continue; } // escaped spaces → one path
    out.push(t);                                        // whole line (a path that may contain spaces)
    if (/\s/.test(t)) for (const part of t.split(/\s+/)) out.push(part); // …or several space-separated paths
  }
  return [...new Set(out.filter(Boolean))];
}

// Returns { key, char } where key is a KEYS constant or null, char is raw string
export function parseKey(input) {
  const buf = toBuffer(input);
  const s = buf.toString();
  const code = buf[0];

  if (code === 3)   return { key: KEYS.CTRL_C,    char: '' };
  if (code === 12)  return { key: KEYS.CTRL_L,    char: '' };
  if (code === 9)   return { key: KEYS.TAB,        char: '' };
  if (code === 13 || code === 10) return { key: KEYS.ENTER, char: '' };
  if (code === 127 || code === 8) return { key: KEYS.BACKSPACE, char: '' };

  if (s === '\x1b')                return { key: KEYS.ESC,   char: '' };
  if (s === '\x1b[A')              return { key: KEYS.UP,    char: '' };
  if (s === '\x1b[B')              return { key: KEYS.DOWN,  char: '' };
  if (s === '\x1b[C')              return { key: KEYS.RIGHT, char: '' };
  if (s === '\x1b[D')              return { key: KEYS.LEFT,  char: '' };
  if (s === '\x1b[H' || s === '\x1b[1~') return { key: KEYS.HOME, char: '' };
  if (s === '\x1b[F' || s === '\x1b[4~') return { key: KEYS.END,  char: '' };
  if (s === '\x1b[5~')             return { key: KEYS.PGUP,  char: '' };
  if (s === '\x1b[6~')             return { key: KEYS.PGDN,  char: '' };

  // Function keys (various terminal encodings)
  if (s === '\x1bOP'  || s === '\x1b[11~') return { key: KEYS.F1, char: '' };
  if (s === '\x1bOQ'  || s === '\x1b[12~') return { key: KEYS.F2, char: '' };
  if (s === '\x1bOR'  || s === '\x1b[13~') return { key: KEYS.F3, char: '' };
  if (s === '\x1bOS'  || s === '\x1b[14~') return { key: KEYS.F4, char: '' };
  if (s === '\x1b[15~')                    return { key: KEYS.F5, char: '' };
  if (s === '\x1b[17~')                    return { key: KEYS.F6, char: '' };
  if (s === '\x1b[18~')                    return { key: KEYS.F7, char: '' };
  if (s === '\x1b[19~')                    return { key: KEYS.F8, char: '' };
  if (s === '\x1b[1;2P')                   return { key: KEYS.F1, char: '' };
  if (s === '\x1b[1;2Q')                   return { key: KEYS.F2, char: '' };
  if (s === '\x1b[[A')                     return { key: KEYS.F1, char: '' };
  if (s === '\x1b[[B')                     return { key: KEYS.F2, char: '' };
  if (s === '\x1b[[C')                     return { key: KEYS.F3, char: '' };
  if (s === '\x1b[[D')                     return { key: KEYS.F4, char: '' };
  if (s === '\x1b[25~')                    return { key: KEYS.F5, char: '' };
  if (s === '\x1b[26~')                    return { key: KEYS.F6, char: '' };

  // Printable character
  if (code >= 32 && code < 127) return { key: null, char: s };
  // Multi-byte UTF-8 printable
  if (code >= 0xc0) return { key: null, char: s };

  return { key: null, char: '' };
}

function isCompleteEscapeSequence(s) {
  if (!s.startsWith('\x1b')) return true;
  if (s === '\x1b') return false;
  if (s.startsWith('\x1bO')) return s.length >= 3;
  if (s.startsWith('\x1b[')) return /^\x1b\[[0-9;]*[~A-Za-z]$/.test(s);
  return s.length > 1;
}

export function startKeyListener(handler) {
  const { stdin } = process;
  if (!stdin.isTTY) return () => {};
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding(null);

  let escBuf = '';
  let escTimer = null;

  // The handler is async (handleKey → executeCmd → network). A throw or rejection
  // here would otherwise reach process-level `unhandledRejection`, whose handler
  // restores the terminal and exits — i.e. one bad keystroke/command would KILL the
  // TUI. Contain it: a single keystroke must never crash the session.
  function safeHandle(parsed) {
    try {
      const out = handler(parsed);
      if (out && typeof out.then === 'function') out.then(undefined, () => {});
    } catch { /* swallow — a bad keystroke must not take down the UI */ }
  }

  function flush() {
    if (escTimer) clearTimeout(escTimer);
    escTimer = null;
    if (!escBuf) return;
    safeHandle(parseKey(Buffer.from(escBuf, 'binary')));
    escBuf = '';
  }

  const PASTE_START = '\x1b[200~';
  const PASTE_END   = '\x1b[201~';
  let pasteBuf = null; // a string while inside a bracketed paste, else null

  // Original per-chunk handling (escape-sequence assembly + key parse).
  function handleChunk(s) {
    if (!s) return;
    if (escBuf || s.startsWith('\x1b')) {
      escBuf += s;
      if (escTimer) clearTimeout(escTimer);
      if (isCompleteEscapeSequence(escBuf)) flush();
      else escTimer = setTimeout(flush, 30);
      return;
    }
    safeHandle(parseKey(Buffer.from(s, 'binary')));
  }

  function onData(buf) {
    let s = toBuffer(buf).toString('binary');
    // Bracketed paste (F-3): deliver everything between \x1b[200~ and \x1b[201~ as
    // ONE `{ key:'PASTE', char }` event — file drops and multi-line pastes arrive
    // whole instead of char-by-char.
    while (s.length) {
      if (pasteBuf !== null) {
        const end = s.indexOf(PASTE_END);
        if (end === -1) { pasteBuf += s; return; }     // paste spans chunks — keep buffering
        pasteBuf += s.slice(0, end);
        const text = Buffer.from(pasteBuf, 'binary').toString('utf8');
        pasteBuf = null;
        safeHandle({ key: 'PASTE', char: text, paste: true });
        s = s.slice(end + PASTE_END.length);
        continue;
      }
      const start = s.indexOf(PASTE_START);
      if (start === -1) break;
      handleChunk(s.slice(0, start));                  // any keystrokes before the paste
      pasteBuf = '';
      s = s.slice(start + PASTE_START.length);
    }
    handleChunk(s);
  }

  stdin.on('data', onData);
  return () => {
    if (escTimer) clearTimeout(escTimer);
    stdin.off('data', onData);
    stdin.setRawMode(false);
    stdin.pause();
  };
}
