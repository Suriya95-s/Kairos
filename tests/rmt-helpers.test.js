import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { segmentText, shouldInvokeRmt } from '../src/rmt/index.js';

describe('RMT helpers', () => {
  test('segments long text into overlapping chunks', () => {
    const text = 'a'.repeat(20000);
    const segments = segmentText(text, 512, 32);

    assert.ok(segments.length > 1);
    assert.ok(segments[0].length <= 512 * 4);
  });

  test('detects when RMT should be invoked', () => {
    assert.equal(shouldInvokeRmt({ text: 'a'.repeat(40000) }), true);
    assert.equal(shouldInvokeRmt({ text: 'short text', fileCount: 2 }), false);
  });
});
