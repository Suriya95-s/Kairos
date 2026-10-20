// tests/tui-spend-view.test.js
// The SPEND LEDGER section of the Metrics view.
//
// The claim: the TUI shows the SAME persistent ledger `kairos usage` prints —
// file-backed via probeSpend(), so it answers even with no agent connected
// (the owner's first question about it was asked at a DISCONNECTED screen).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { recordUsage } from '../src/kernel/usage.js';
import { probeSpend, renderMetrics } from '../apps/tui/src/views/metrics.js';
import { state } from '../apps/tui/src/state.js';
import { stripAnsi } from '../apps/tui/src/render.js';

let tmpHome;
const savedHome = process.env.KAIROS_HOME;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-tuispend-'));
  process.env.KAIROS_HOME = tmpHome;
  state.spend = { probedAt: 0, data: null };
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.KAIROS_HOME;
  else process.env.KAIROS_HOME = savedHome;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* Windows locks */ }
});

function renderedText() {
  return renderMetrics(100, 60).map((l) => stripAnsi(l)).join('\n');
}

describe('TUI spend ledger', () => {
  test('probeSpend reads the same ledger the CLI sums', async () => {
    const month = new Date().toISOString().slice(0, 7);
    recordUsage({ model: 'gpt-4o-mini', purpose: 'ontology.verify', usage: { prompt_tokens: 1000, completion_tokens: 100 } });
    recordUsage({ model: 'gpt-4o-mini', purpose: 'ontology.ask', usage: { prompt_tokens: 200, completion_tokens: 20 } });
    const p = await probeSpend();
    assert.equal(p.month, month);
    assert.equal(p.monthly.records, 2);
    assert.equal(p.monthly.totals.promptTokens, 1200);
    assert.equal(p.allTime.records, 2);
  });

  test('the Metrics view renders the ledger — no agent connection involved', async () => {
    recordUsage({ model: 'gpt-4o-mini', purpose: 'ontology.verify', usage: { prompt_tokens: 6100, completion_tokens: 1672 } });
    state.spend.data = await probeSpend();
    const text = renderedText();
    assert.ok(text.includes('SPEND LEDGER'), 'section header must render');
    assert.ok(text.includes('6,100'), 'the real prompt-token count must appear');
    assert.ok(text.includes('ontology.verify'), 'the purpose breakdown must appear');
  });

  test('an empty ledger renders the empty state, not a crash', () => {
    state.spend.data = null;
    const text = renderedText();
    assert.ok(text.includes('no model calls in the ledger yet'), 'must state the empty ledger plainly');
  });
});
