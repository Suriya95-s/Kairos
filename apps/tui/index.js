#!/usr/bin/env node
// Kairos TUI — entry point
// Usage: kairos-tui [--port 5180] [--compact]

import { startApp, stopApp, restoreTerminal } from './src/app.js';

const args = process.argv.slice(2);
let port     = 5180;
let compact  = false;
let launcher = false;
let root     = '';
// 'auto' attaches to the daemon when one is running and falls back to a single
// run otherwise, so the pre-daemon workflow keeps working untouched.
let backend  = 'auto';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) {
    port = parseInt(args[++i], 10);
  } else if (args[i] === '--compact') {
    compact = true;
  } else if (args[i] === '--launcher') {
    launcher = true;
  } else if (args[i] === '--root' && args[i + 1]) {
    root = args[++i];
  } else if (args[i] === '--daemon') {
    backend = 'daemon';
  } else if (args[i] === '--no-daemon') {
    backend = 'legacy';
  } else if (args[i] === '--help' || args[i] === '-h') {
    process.stdout.write(
      'kairos-tui — terminal UI for the Kairos agent loop\n\n' +
      'Usage: kairos-tui [--port <n>] [--compact] [--launcher] [--root <dir>]\n' +
      '                  [--daemon | --no-daemon]\n\n' +
      '  --port <n>     SSE server port for a single run (default: 5180)\n' +
      '  --compact      Single-line header mode\n' +
      '  --launcher     Open in launcher mode (type task in splash to start agent)\n' +
      '  --root <dir>   Kairos project root (used by launcher mode)\n' +
      '  --daemon       Attach to the presence daemon (fail if it is not running)\n' +
      '  --no-daemon    Watch a single agent run, even if a daemon is up\n\n' +
      'By default the TUI attaches to the daemon when one is running; closing\n' +
      'the TUI then leaves its missions running.\n'
    );
    process.exit(0);
  }
}

process.on('SIGINT',  () => stopApp(0));
process.on('SIGTERM', () => stopApp(0));

// Final synchronous safety net: whatever caused the exit, leave the terminal
// usable. 'exit' handlers must be synchronous — restoreTerminal() is.
process.on('exit', () => restoreTerminal());

process.on('uncaughtException', (err) => {
  restoreTerminal();
  process.stderr.write(`kairos-tui: uncaught error: ${err?.stack || err?.message || err}\n`);
  process.exit(1);
});

// Previously unhandled: an async failure (a rejected promise in the SSE client,
// a render tick, etc.) would terminate the process with the terminal still in
// alt-screen + raw mode. Restore first, then exit with a failure code.
process.on('unhandledRejection', (reason) => {
  restoreTerminal();
  process.stderr.write(`kairos-tui: unhandled rejection: ${reason?.stack || reason?.message || reason}\n`);
  process.exit(1);
});

startApp(port, compact, launcher, root, backend);
