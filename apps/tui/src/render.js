// src/render.js — zero-dep ANSI terminal primitives

// Wave E-3 — accessibility. Monochrome mode strips ALL SGR styling so the UI is
// legible under NO_COLOR, a color-blind-safe requirement, a braille terminal, or
// a pipe. Evaluated dynamically (per access) so tests can toggle it at runtime.
export function monoMode() {
  return process.env.NO_COLOR !== undefined || process.env.AGENT_TUI_MONO === '1';
}
export function reducedMotion() {
  return process.env.AGENT_TUI_NO_SPIN === '1';
}

// ── Color depth ───────────────────────────────────────────────────────────────
// mono → no color at all (NO_COLOR / AGENT_TUI_MONO — the accessibility floor);
// truecolor when the terminal advertises 24-bit ($COLORTERM); else the 256 index.
export function colorDepth() {
  if (monoMode()) return 'mono';
  const ct = process.env.COLORTERM;
  return (ct === 'truecolor' || ct === '24bit') ? 'truecolor' : 'ansi256';
}

// Build an SGR for a color from its 24-bit rgb + 256 index, honoring depth.
function sgr(rgb, c256, isBg = false) {
  const d = colorDepth();
  if (d === 'mono') return '';
  const lead = isBg ? 48 : 38;
  return d === 'truecolor'
    ? `\x1b[${lead};2;${rgb[0]};${rgb[1]};${rgb[2]}m`
    : `\x1b[${lead};5;${c256}m`;
}

// ── Kairos Aurora grade (spec §2.1) ───────────────────────────────────────────
// Cool near-black field · indigo/teal structure · a single warm amber NOW
// heartbeat. Each token: [r,g,b] truecolor + 256 fallback index.
const AURORA = {
  void:  { rgb: [9, 12, 18],     c256: 232 },  // app background — deepest surface
  panel: { rgb: [16, 20, 29],    c256: 234 },  // panel / column fill
  raise: { rgb: [22, 28, 40],    c256: 235 },  // selected row / raised surface
  rule:  { rgb: [34, 42, 58],    c256: 236 },  // dim dividers
  edge:  { rgb: [46, 58, 82],    c256: 238 },  // inactive panel borders
  ink:   { rgb: [234, 238, 247], c256: 255 },  // primary text / headings
  ink2:  { rgb: [191, 200, 218], c256: 252 },  // body text
  ink3:  { rgb: [132, 146, 172], c256: 103 },  // labels / secondary / meta
  ink4:  { rgb: [81, 93, 118],   c256: 60  },  // hints / disabled / pending
  iris:  { rgb: [123, 140, 255], c256: 105 },  // brand — borders, titles, accent bar
  aqua:  { rgb: [52, 211, 198],  c256: 80  },  // info — section markers, model
  amber: { rgb: [244, 180, 89],  c256: 215 },  // NOW / attention / current / warn
  jade:  { rgb: [84, 217, 150],  c256: 78  },  // success — done, positive, approve
  coral: { rgb: [255, 110, 122], c256: 210 },  // error / deny / blocked / danger
  sky:   { rgb: [79, 168, 255],  c256: 75  },  // input / search / local endpoint
};

/** Foreground SGR for an Aurora token (''→mono). Exported for role-based code. */
export function fg(token) {
  const t = AURORA[token];
  return t ? sgr(t.rgb, t.c256, false) : '';
}
/** Background SGR for an Aurora token (''→mono). */
export function bg(token) {
  const t = AURORA[token];
  return t ? sgr(t.rgb, t.c256, true) : '';
}

// Mode-independent structural SGR — still blanked in mono to keep the strict
// "zero escapes in mono" accessibility floor the suite encodes.
const STRUCT = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m' };

// Foreground role names (new) + legacy aliases → Aurora tokens. Mapping the
// legacy names is what re-grades every existing view through this one Proxy.
const FG_ROLE = {
  ink: 'ink', ink2: 'ink2', ink3: 'ink3', ink4: 'ink4',
  iris: 'iris', aqua: 'aqua', amber: 'amber', jade: 'jade', coral: 'coral', sky: 'sky',
  edge: 'edge', rule: 'rule',
  // legacy name → Aurora role
  green: 'jade', yellow: 'amber', red: 'coral', cyan: 'aqua', blue: 'sky',
  grey: 'ink3', white: 'ink', violet: 'iris',
};
const BG_ROLE = { bgSel: 'raise', raise: 'raise', panel: 'panel', void: 'void', bgModal: 'panel' };

// The C Proxy: every `C.<name>` resolves to the right escape for the active depth,
// and '' in mono. Backward compatible with all legacy color names.
export const C = new Proxy({}, {
  get(_t, prop) {
    if (typeof prop !== 'string') return undefined;
    if (prop in STRUCT) return monoMode() ? '' : STRUCT[prop];
    if (prop in FG_ROLE) return fg(FG_ROLE[prop]);
    if (prop in BG_ROLE) return bg(BG_ROLE[prop]);
    return '';
  },
});

// ── Theme accent (extended in Phase 8 with density) ───────────────────────────
// Single-accent system; Aurora (iris) is the default. Each accent carries an
// rgb + 256 index so it honors color depth. Mono blanks it.
const THEMES = {
  aurora: { rgb: [123, 140, 255], c256: 105 },
  ocean:  { rgb: [70, 180, 255],  c256: 75  },
  ember:  { rgb: [244, 158, 90],  c256: 215 },
  lime:   { rgb: [155, 227, 107], c256: 149 },
};
let _theme = 'aurora';

/** Set the active accent theme; unknown names fall back to aurora. */
export function setActiveTheme(name) {
  _theme = THEMES[name] ? name : 'aurora';
  return _theme;
}
export function activeTheme() { return _theme; }

/** Current theme's accent SGR, or '' in mono mode. */
export function accent() {
  const t = THEMES[_theme] || THEMES.aurora;
  return sgr(t.rgb, t.c256, false);
}

/** Wrap `s` in an SGR code (blanked in mono). The one place styling is applied. */
export function paint(code, s) {
  return `${code}${s}${C.reset}`;
}

// Violet border helper — wraps a single char/string in violet then resets
function vb(s) { return accent() + s + C.reset; }

export const T = {
  tl: '┌', tr: '┐', bl: '└', br: '┘',
  h: '─', v: '│', mt: '┬', mb: '┴',
  dtl: '╔', dtr: '╗', dbl: '╚', dbr: '╝',
  dh: '═', dv: '║',
};

// ── Cursor / screen ──────────────────────────────────────────────────────────
export const hideCursor  = '\x1b[?25l';
export const showCursor  = '\x1b[?25h';
export const clearEOL    = '\x1b[K';
export const home        = '\x1b[H';
export const altOn       = '\x1b[?1049h';
export const altOff      = '\x1b[?1049l';
export const moveTo = (r, c) => `\x1b[${r};${c}H`;

// ── String helpers ────────────────────────────────────────────────────────────
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b[^[]/g;

export function visLen(s)      { return String(s).replace(ANSI_RE, '').length; }
export function stripAnsi(s)   { return String(s).replace(ANSI_RE, ''); }

export function padEnd(s, n) {
  const vl = visLen(s);
  return vl < n ? s + ' '.repeat(n - vl) : s;
}

export function clip(s, n) {
  const plain = stripAnsi(s);
  if (plain.length <= n) return s;
  return plain.slice(0, n - 1) + '…';
}

export function cell(content, width) {
  return padEnd(clip(String(content ?? ''), width), width);
}

export function hline(n, ch = T.h) { return ch.repeat(n); }

// ── Timing / trend formatting (Workstream A) ──────────────────────────────────

/** Human duration: <1s → "450ms", else "1.2s". Nullish/negative → "". */
export function fmtDuration(ms) {
  if (ms == null || !(ms >= 0)) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const SPARK_GLYPHS = '▁▂▃▄▅▆▇█';

/**
 * Unicode block sparkline scaled to the data's min..max over the last `width`
 * samples. Empty input → "". Flat data → a mid-tier bar (no divide-by-zero).
 * Color is left to the caller; the glyphs render fine in mono.
 * @param {number[]} nums @param {number} width
 */
export function sparkline(nums, width = 16) {
  if (!Array.isArray(nums) || nums.length === 0) return '';
  const data = nums.slice(-width);
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min;
  const mid = SPARK_GLYPHS[Math.floor((SPARK_GLYPHS.length - 1) / 2)];
  return data.map((n) => {
    if (span === 0) return mid;
    const t = (n - min) / span;
    const idx = Math.min(SPARK_GLYPHS.length - 1, Math.round(t * (SPARK_GLYPHS.length - 1)));
    return SPARK_GLYPHS[idx];
  }).join('');
}

/**
 * Wrap `text` to `width` columns on word boundaries; tokens longer than `width`
 * are hard-broken so no characters are ever dropped. Empty string → [''].
 * @param {string} text @param {number} width @returns {string[]}
 */
export function wrapLine(text, width) {
  const s = String(text ?? '');
  if (s === '') return [''];
  if (width <= 0) return [s];
  const out = [];
  let line = '';
  for (const word of s.split(' ')) {
    let w = word;
    // Hard-break a single token that cannot fit on its own line.
    while (w.length > width) {
      if (line) { out.push(line); line = ''; }
      out.push(w.slice(0, width));
      w = w.slice(width);
    }
    const candidate = line ? `${line} ${w}` : w;
    if (candidate.length > width) { out.push(line); line = w; }
    else line = candidate;
  }
  if (line || out.length === 0) out.push(line);
  return out;
}

// ── Colour helpers (all blanked in mono via paint → C proxy) ──────────────────
export const g   = s => paint(C.green,  s);
export const y   = s => paint(C.yellow, s);
export const r   = s => paint(C.red,    s);
export const b   = s => paint(C.blue,   s);
export const cy  = s => paint(C.cyan,   s);
export const vi  = s => paint(C.violet, s);
export const dim = s => paint(C.dim,    s);
export const bold= s => paint(C.bold,   s);
export const gr  = s => paint(C.grey,   s);

// ── Box drawing ───────────────────────────────────────────────────────────────

export function boxTop(width, title = '') {
  const inner = width - 2;
  if (!title) return accent() + T.tl + T.h.repeat(inner) + T.tr + C.reset;
  const t = ` ${title} `;
  const vis = visLen(t);
  const pad = inner - vis;
  const l = Math.max(0, Math.floor(pad / 2));
  const rr = Math.max(0, pad - l);
  return accent() + T.tl + T.h.repeat(l) + C.reset + t + accent() + T.h.repeat(rr) + T.tr + C.reset;
}

export function boxBot(width) {
  return accent() + T.bl + T.h.repeat(width - 2) + T.br + C.reset;
}

export function boxRow(content, width) {
  return vb(T.v) + cell(content, width - 2) + vb(T.v);
}

// Double-line box (for modals)
export function dboxTop(width, title = '') {
  const inner = width - 2;
  if (!title) return accent() + T.dtl + T.dh.repeat(inner) + T.dtr + C.reset;
  const t = ` ${title} `;
  const vis = visLen(t);
  const pad = inner - vis;
  const l = Math.max(0, Math.floor(pad / 2));
  const rr = Math.max(0, pad - l);
  return accent() + T.dtl + T.dh.repeat(l) + C.reset + t + accent() + T.dh.repeat(rr) + T.dtr + C.reset;
}

export function dboxBot(width)            { return accent() + T.dbl + T.dh.repeat(width - 2) + T.dbr + C.reset; }
export function dboxRow(content, width)   { return vb(T.dv) + cell(content, width - 2) + vb(T.dv); }

// ── Three-column layout builder ───────────────────────────────────────────────

export function threeColTop(W, titles) {
  const [lW, cW, rW] = colWidths(W);
  const fmt = t => t ? ` ${C.bold}${C.cyan}${t}${C.reset} ` : '';
  const lTit = fmt(titles[0]);
  const cTit = fmt(titles[1]);
  const rTit = fmt(titles[2]);
  return (
    vb(T.tl) + titledHlineVi(lW - 1, lTit) +
    vb(T.mt) + titledHlineVi(cW - 1, cTit) +
    vb(T.mt) + titledHlineVi(rW - 1, rTit) + vb(T.tr)
  );
}

export function threeColBot(W) {
  const [lW, cW, rW] = colWidths(W);
  return (
    vb(T.bl) + accent() + T.h.repeat(lW - 1) + C.reset +
    vb(T.mb) + accent() + T.h.repeat(cW - 1) + C.reset +
    vb(T.mb) + accent() + T.h.repeat(rW - 1) + C.reset + vb(T.br)
  );
}

export function threeColRow(W, l, c, ri) {
  const [lW, cW, rW] = colWidths(W);
  return (
    vb(T.v) + cell(l, lW - 1) +
    vb(T.v) + cell(c, cW - 1) +
    vb(T.v) + cell(ri, rW - 1) + vb(T.v)
  );
}

export function twoColTop(W, titles) {
  const lW = Math.floor(W * 0.52);
  const rW = W - lW;
  const fmt = t => t ? ` ${C.bold}${C.cyan}${t}${C.reset} ` : '';
  const lTit = fmt(titles[0]);
  const rTit = fmt(titles[1]);
  return vb(T.tl) + titledHlineVi(lW - 1, lTit) + vb(T.mt) + titledHlineVi(rW - 1, rTit) + vb(T.tr);
}

export function twoColBot(W) {
  const lW = Math.floor(W * 0.52);
  const rW = W - lW;
  return vb(T.bl) + accent() + T.h.repeat(lW - 1) + C.reset + vb(T.mb) + accent() + T.h.repeat(rW - 1) + C.reset + vb(T.br);
}

export function twoColRow(W, l, ri) {
  const lW = Math.floor(W * 0.52);
  const rW = W - lW;
  return vb(T.v) + cell(l, lW - 1) + vb(T.v) + cell(ri, rW - 1) + vb(T.v);
}

function colWidths(W) {
  // Rendered 3-col width = (lW-1)+(cW-1)+(rW-1) + 4 bars = lW+cW+rW + 1, so the
  // widths must sum to W-1 for the grid to total exactly W (no 2-cell overflow).
  const lW = Math.floor(W * 0.29) + 1;
  const rW = Math.floor(W * 0.24) + 1;
  const cW = W - lW - rW - 1;
  return [lW, cW, rW];
}

function titledHlineVi(n, title) {
  const vis = visLen(title);
  const pad = n - vis;
  if (pad <= 0) return accent() + T.h.repeat(n) + C.reset;
  const l = Math.floor(pad / 2);
  const rr = pad - l;
  return accent() + T.h.repeat(l) + C.reset + title + accent() + T.h.repeat(rr) + C.reset;
}

export { colWidths };

// ── Generic composition helpers (Phase 2 — redesign) ──────────────────────────
// One builder for any column count + border weight, so the layout presets
// (Refined 3-col · Bold rail+output · Wide single) all share the same frame code.
// Borders carry the active accent; mono blanks it like everything else.

const WEIGHTS = {
  single: { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│', mt: '┬', mb: '┴' },
  double: { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║', mt: '╦', mb: '╩' },
};

/** A colored (and optionally bold) span. With no color/bold returns the raw text. */
export function seg(text, color = '', bold = false) {
  const t = String(text ?? '');
  if (!color && !bold) return t;
  return (bold ? C.bold : '') + (color || '') + t + C.reset;
}

/** Top border across columns of the given inner widths. weight: 'single'|'double'. */
export function boxTopN(widths, weight = 'single', accentColor = accent()) {
  const w = WEIGHTS[weight] || WEIGHTS.single;
  return accentColor + w.tl + widths.map((n) => w.h.repeat(Math.max(0, n))).join(w.mt) + w.tr + C.reset;
}
/** Bottom border across columns. */
export function boxBotN(widths, weight = 'single', accentColor = accent()) {
  const w = WEIGHTS[weight] || WEIGHTS.single;
  return accentColor + w.bl + widths.map((n) => w.h.repeat(Math.max(0, n))).join(w.mb) + w.br + C.reset;
}
/** A content row: one cell string per column, each clipped+padded to its width. */
export function boxRowN(cells, widths, weight = 'single', accentColor = accent()) {
  const w = WEIGHTS[weight] || WEIGHTS.single;
  const bar = accentColor + w.v + C.reset;
  let out = bar;
  for (let i = 0; i < widths.length; i++) out += cell(cells[i] ?? '', widths[i]) + bar;
  return out;
}
/** Left + right text justified to `width`; clips the left side if they would collide. */
export function bandLR(left, right, width) {
  const rl = visLen(right);
  const ll = visLen(left);
  if (ll + rl >= width) return padEnd(clip(left, Math.max(0, width - rl)), Math.max(0, width - rl)) + right;
  return left + ' '.repeat(width - ll - rl) + right;
}

// ── Write frame (row-diffed, Wave E-2) ────────────────────────────────────────
// Keeps the previous frame's rendered rows and rewrites only the rows that
// changed (cursor-addressed), eliminating the full-screen repaint flicker over
// slow SSH. Falls back to a full repaint on the first frame or a resize.

let _prevRows = null;
let _prevW = 0;

/** Force the next writeFrame to do a full repaint (e.g. after leaving an overlay). */
export function resetFrameBuffer() { _prevRows = null; _prevW = 0; }

/**
 * Pure: indices of rows in `next` that differ from `prev`. Returns all indices
 * when there is no comparable previous frame (null or different row count).
 * @param {string[]|null} prev
 * @param {string[]} next
 * @returns {number[]}
 */
export function diffRows(prev, next) {
  if (!prev || prev.length !== next.length) return next.map((_, i) => i);
  const changed = [];
  for (let i = 0; i < next.length; i++) if (prev[i] !== next[i]) changed.push(i);
  return changed;
}

export function writeFrame(lines, W) {
  const rows = lines.map(line => padEnd(line, W).slice(0, W + 200) + clearEOL);

  let out;
  if (_prevRows === null) {
    // First frame — full paint, each row cursor-addressed. No trailing newline:
    // writing "\r\n" after the LAST row of a full-height frame scrolls the
    // terminal up by one, duplicating the bottom line.
    out = home;
    for (let i = 0; i < rows.length; i++) out += `\x1b[${i + 1};1H` + rows[i];
  } else if (_prevW !== W || _prevRows.length !== rows.length) {
    // Resize — clear and full paint so a shrink leaves no stale rows behind.
    out = home + '\x1b[2J';
    for (let i = 0; i < rows.length; i++) out += `\x1b[${i + 1};1H` + rows[i];
  } else {
    const changed = diffRows(_prevRows, rows);
    if (changed.length === 0) { _prevRows = rows; _prevW = W; return; }
    out = '';
    for (const i of changed) out += `\x1b[${i + 1};1H` + rows[i];
  }

  out += hideCursor;
  process.stdout.write(out);
  _prevRows = rows;
  _prevW = W;
}
