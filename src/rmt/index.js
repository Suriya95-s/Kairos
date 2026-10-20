import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import { getWorkspace, readText, writeText } from '../state.js';

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / config.charsPerToken);
}

export function shouldInvokeRmt({ text = '', fileCount = 0, traceChars = 0 }) {
  return estimateTokens(text) > config.rmtLargeFileTokenThreshold ||
    estimateTokens(traceChars ? 'x'.repeat(traceChars) : '') > config.rmtLargeTraceTokenThreshold ||
    fileCount > config.rmtLargeFileCountThreshold;
}

export function segmentText(text = '', segmentTokens = config.rmtSegmentTokens, overlapTokens = config.rmtOverlapTokens) {
  const approxChars = Math.max(1, segmentTokens * 4);
  const overlapChars = Math.max(0, overlapTokens * 4);
  // Stride MUST be positive. If overlap >= segment size (both env-configurable
  // and unvalidated), `end - overlapChars` would not advance the cursor and this
  // loops forever, OOMing inside compaction. Clamp to ≥1 char of progress.
  const stride = Math.max(1, approxChars - overlapChars);
  const input = String(text || '');
  const segments = [];
  let cursor = 0;
  while (cursor < input.length) {
    const end = Math.min(input.length, cursor + approxChars);
    segments.push(input.slice(cursor, end));
    if (end >= input.length) break;
    cursor += stride;
  }
  return segments;
}

export function saveRmtSlots(jobId, slots) {
  const relPath = `${config.rmtDir}/slots-${jobId}.json`;
  writeText(relPath, JSON.stringify({ jobId, slots, updatedAt: new Date().toISOString() }, null, 2));
}

export function writeRmtSummary(jobId, markdown) {
  const relPath = `${config.rmtSummariesDir}/${jobId}.md`;
  writeText(relPath, markdown);
  return relPath;
}

export function listRmtSummaries() {
  const abs = path.join(getWorkspace(), config.rmtSummariesDir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs).filter((name) => name.endsWith('.md'));
}

export function readRmtSummary(jobId) {
  return readText(`${config.rmtSummariesDir}/${jobId}.md`);
}
