#!/usr/bin/env node
// src/kernel/daemonMain.js
// The resident process entry point. `<brand> start` execs this detached.
//
// Kept deliberately thin: wiring, signal handling, and a last-resort crash log.
// Everything interesting lives in daemon.js / server.js so it can be tested
// without spawning a process.

import fs from 'node:fs';
import path from 'node:path';

import { ensureHome, dir as kernelDir, BRAND } from './paths.js';
import { Bus, setBus } from './bus.js';
import { SessionRegistry } from './sessions.js';
import { MissionManager } from './missions.js';
import { Daemon } from './daemon.js';
import { DaemonServer } from './server.js';
import { getVault } from './vault.js';

function logLine(text) {
  const line = `[${new Date().toISOString()}] ${text}\n`;
  process.stdout.write(line);
  try {
    fs.appendFileSync(path.join(kernelDir('logs'), 'daemon.log'), line);
  } catch { /* logging must never be the thing that kills the daemon */ }
}

async function main() {
  ensureHome();

  // Open the vault before anything can log. Loading it registers every stored
  // secret with the redactor, so the bus is protected from the first event —
  // not from whenever a credential happens to be read.
  const vault = getVault();
  try {
    const imported = vault.migrateFromEnv();
    if (imported.length) logLine(`vault: imported ${imported.join(', ')} from the environment`);
    const vs = vault.status();
    if (!vs.protected) logLine(`vault: ${vs.warning}`);
  } catch (err) {
    // A vault that will not open is a hard problem, but it must be reported
    // rather than silently leaving credentials unredacted.
    logLine(`vault: UNAVAILABLE — ${err.message}`);
  }

  const bus = setBus(new Bus());
  const sessions = new SessionRegistry({ bus });
  const missions = new MissionManager({ bus, sessions });
  const daemon = new Daemon({ bus, sessions, missions });
  const server = new DaemonServer({ daemon });

  const info = await daemon.start({ adopt: true, autoResume: process.env.KAIROS_AUTO_RESUME === '1' });
  const { port } = await server.listen();

  logLine(`${BRAND} daemon up — pid ${info.pid}, port ${port}, health ${daemon.health}`);
  if (info.adoption.adopted.length) {
    logLine(`re-adopted ${info.adoption.adopted.length} interrupted mission(s): ${info.adoption.adopted.join(', ')}`);
  }

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) {
      logLine(`second ${signal} — forcing exit`);
      process.exit(1);
    }
    shuttingDown = true;
    logLine(`${signal} received — draining missions`);
    try {
      await server.close();
      await daemon.stop({ reason: `${signal} received` });
      logLine('clean shutdown');
      process.exit(0);
    } catch (err) {
      logLine(`shutdown error: ${err.message}`);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => { shutdown('SIGTERM'); });
  process.on('SIGINT', () => { shutdown('SIGINT'); });

  // An always-on process must not die silently. Log, then exit non-zero so the
  // OS supervisor (systemd/launchd/Task Scheduler) restarts it.
  process.on('uncaughtException', (err) => {
    logLine(`FATAL uncaughtException: ${err?.stack || err}`);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logLine(`FATAL unhandledRejection: ${reason?.stack || reason}`);
    process.exit(1);
  });
}

main().catch((err) => {
  logLine(`failed to start: ${err?.stack || err}`);
  process.exit(1);
});
