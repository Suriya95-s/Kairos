// src/logger.js
// Structured logger — JSON output (KAIROS_LOG_JSON=1) or human-readable.
// Levels: debug < info < warn < error. Default level: info.
// All output goes to stderr to keep stdout clean for machine consumers.
// Task 6.1

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const JSON_MODE = process.env.KAIROS_LOG_JSON === '1';
const MIN_LEVEL = LEVELS[process.env.KAIROS_LOG_LEVEL?.toLowerCase()] ?? LEVELS.info;

/**
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} msg
 * @param {object} [meta]
 */
function write(level, msg, meta) {
  if (LEVELS[level] < MIN_LEVEL) return;
  if (JSON_MODE) {
    const entry = { ts: new Date().toISOString(), level, msg };
    if (meta && Object.keys(meta).length > 0) entry.meta = meta;
    process.stderr.write(JSON.stringify(entry) + '\n');
  } else {
    const ts = new Date().toISOString().slice(11, 19);
    const prefix = level === 'error' ? '✖' : level === 'warn' ? '⚠' : level === 'debug' ? '·' : '·';
    const metaStr = meta && Object.keys(meta).length > 0 ? ' ' + JSON.stringify(meta) : '';
    process.stderr.write(`[${ts}] ${prefix} ${msg}${metaStr}\n`);
  }
}

export const logger = {
  debug: (msg, meta) => write('debug', msg, meta),
  info:  (msg, meta) => write('info',  msg, meta),
  warn:  (msg, meta) => write('warn',  msg, meta),
  error: (msg, meta) => write('error', msg, meta),
  /** Create a child logger with a fixed prefix on every message */
  child: (prefix) => ({
    debug: (msg, meta) => write('debug', `[${prefix}] ${msg}`, meta),
    info:  (msg, meta) => write('info',  `[${prefix}] ${msg}`, meta),
    warn:  (msg, meta) => write('warn',  `[${prefix}] ${msg}`, meta),
    error: (msg, meta) => write('error', `[${prefix}] ${msg}`, meta),
  }),
};

export default logger;
