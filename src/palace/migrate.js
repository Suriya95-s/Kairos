// src/palace/migrate.js
// One-time migration: LMMA bank JSONL files → EpisodicStore.
// Runs from initAgentDir on first v3.0 boot when palace is enabled.
// Idempotent: checks for a sentinel file before running.
// Old banks archived to .agent/lmma/banks.archived/ (per N6).

import fs   from 'node:fs';
import path from 'node:path';
import { getWorkspace, readLmmaBank } from '../state.js';
import { getLmmaBanks } from '../lmma/defaults.js';
import { contentHash } from './episodic-store.js';
import config from '../config.js';

const SENTINEL = '.agent/palace/.migrated';
const ARCHIVE_DIR = '.agent/lmma/banks.archived';

/**
 * Build the verbatim text for an LMMA entry. Production writeback entries carry
 * `title`/`summary` (no `content`); seeded/legacy entries may carry `content`.
 * Accept whichever is present so the migration never silently drops real data.
 */
function entryVerbatim(entry) {
  if (entry?.content) return String(entry.content);
  const parts = [entry?.title, entry?.summary].filter(Boolean);
  if (parts.length) return parts.join(' — ');
  return '';
}

/**
 * Migrate LMMA banks to the episodic store.
 * No-op if already migrated or if `--no-migrate` is set.
 *
 * @param {import('./episodic-store.js').EpisodicStore} store
 * @param {{ noMigrate?: boolean }} opts
 * @returns {{ migrated: number, skipped: boolean, archived: string[] }}
 */
export function migrateLmmaBanks(store, opts = {}) {
  const workspace = getWorkspace();
  const sentinel  = path.join(workspace, SENTINEL);

  if (opts.noMigrate || process.env.KAIROS_NO_MIGRATE === '1') {
    return { migrated: 0, skipped: true, archived: [] };
  }

  if (fs.existsSync(sentinel)) {
    return { migrated: 0, skipped: true, archived: [] };
  }

  let migrated = 0;
  const archived = [];

  for (const bankName of getLmmaBanks()) {
    const entries = readLmmaBank(bankName);
    for (const entry of entries) {
      const verbatim = entryVerbatim(entry);
      if (!verbatim) continue;
      // Crash-safety / idempotency: if a prior partial run already inserted this
      // exact content, skip it instead of duplicating (the sentinel is only
      // written after a full pass, so re-running after a crash is expected).
      if (store.queryMostRecent(contentHash(verbatim))) continue;
      const ts = entry.created_at || entry.timestamp;
      store.insert({
        verbatim,
        domain:    bankName,
        timestamp: ts ? (new Date(ts).getTime() / 1000) : (Date.now() / 1000),
        summary:   (entry.summary || verbatim).slice(0, 200),
        note:      `Migrated from LMMA bank: ${bankName}`,
        who:       'kairos-migration',
      });
      migrated++;
    }

    // Archive the bank file (per N6: keep for one release cycle)
    const bankCfg = config.lmmaBanksDir;
    if (bankCfg) {
      const bankFile = path.join(workspace, bankCfg, `${bankName}.jsonl`);
      if (fs.existsSync(bankFile)) {
        const archiveDir = path.join(workspace, ARCHIVE_DIR);
        fs.mkdirSync(archiveDir, { recursive: true });
        const archivePath = path.join(archiveDir, `${bankName}.jsonl`);
        fs.copyFileSync(bankFile, archivePath);
        archived.push(archivePath);
      }
    }
  }

  // Write sentinel to prevent re-migration
  fs.mkdirSync(path.dirname(sentinel), { recursive: true });
  fs.writeFileSync(sentinel, JSON.stringify({
    migratedAt: new Date().toISOString(),
    count: migrated,
  }), 'utf-8');

  console.error(`[palace] Migrated ${migrated} entries from LMMA banks to episodic store. Archived: ${archived.length} bank file(s).`);

  return { migrated, skipped: false, archived };
}

/** Return true if migration has already run. */
export function isMigrated() {
  return fs.existsSync(path.join(getWorkspace(), SENTINEL));
}
