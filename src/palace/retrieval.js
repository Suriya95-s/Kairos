// src/palace/retrieval.js
// Hybrid retrieval: spatial (room walk) + CEI-temporal + semantic + procedural + TF-IDF.
// All five modes run; results are merged, deduped, and ranked.

import { walk, findRoom }   from './walker.js';
import { search as semSearch } from './semanticGraph.js';
import { findRecipes }         from './proceduralIndex.js';

// ── TF-IDF helpers (zero-dep, inline) ─────────────────────────────────────────

function tokenize(text) {
  return String(text || '').toLowerCase().match(/\b[a-z]{2,}\b/g) || [];
}

function termFreq(tokens) {
  const tf = {};
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  const total = tokens.length || 1;
  for (const t in tf) tf[t] /= total;
  return tf;
}

/**
 * Compute TF-IDF cosine similarity between a query and a corpus of documents.
 * Returns scores in [0, 1] indexed by corpus position.
 * @param {string} query
 * @param {string[]} docs
 * @returns {number[]}
 */
export function tfidfScores(query, docs) {
  if (!query || docs.length === 0) return docs.map(() => 0);

  const queryTokens = tokenize(query);
  const docTokens   = docs.map(tokenize);
  const allDocs     = [queryTokens, ...docTokens];
  const N           = allDocs.length;

  // IDF: log(N / df) per term
  const df = {};
  for (const tokens of allDocs) {
    for (const t of new Set(tokens)) df[t] = (df[t] || 0) + 1;
  }
  const idf = {};
  for (const t in df) idf[t] = Math.log(N / df[t]);

  // Build TF-IDF vectors
  function vec(tokens) {
    const tf = termFreq(tokens);
    const v  = {};
    for (const t in tf) v[t] = tf[t] * (idf[t] || 0);
    return v;
  }

  const qVec = vec(queryTokens);
  const scores = [];
  for (const tokens of docTokens) {
    const dVec = vec(tokens);
    // Cosine similarity
    let dot = 0, qNorm = 0, dNorm = 0;
    for (const t in qVec) { dot += (qVec[t] || 0) * (dVec[t] || 0); qNorm += qVec[t] ** 2; }
    for (const t in dVec) dNorm += dVec[t] ** 2;
    const denom = Math.sqrt(qNorm) * Math.sqrt(dNorm);
    scores.push(denom > 0 ? dot / denom : 0);
  }
  return scores;
}

/**
 * Run hybrid retrieval across all palace modes.
 *
 * @param {{
 *   episodicStore: import('./episodic-store.js').EpisodicStore,
 *   roomGraph: import('./rooms.js').RoomGraph,
 *   query: string,
 *   currentFile?: string,
 *   domain?: string,
 *   tStart?: number,
 *   tEnd?: number,
 *   topK?: number,
 * }} params
 * @returns {{ mode: string, id: string|number, score: number, content: string, source: object }[]}
 */
export function retrieve({
  episodicStore,
  roomGraph,
  query,
  currentFile  = null,
  domain       = null,
  tStart       = null,
  tEnd         = null,
  topK         = 10,
}) {
  const candidates = [];

  // ── Mode 1: Spatial (room walk from current file) ──────────────────────────
  if (roomGraph && currentFile) {
    const rooms = findRoom(roomGraph, currentFile, 3);
    for (const startRoom of rooms) {
      const neighbors = walk(roomGraph, startRoom, { maxHops: 2, maxNodes: 10 });
      for (const n of neighbors) {
        candidates.push({
          mode:    'spatial',
          id:      n.id,
          score:   Math.max(0.1, 1.0 - n.hop * 0.3),
          content: `Room: ${n.id} (${n.type})`,
          source:  n,
        });
      }
    }
  }

  // ── Mode 2: CEI-temporal ──────────────────────────────────────────────────
  if (episodicStore) {
    const now = Date.now() / 1000;
    const window = tStart && tEnd
      ? episodicStore.queryTemporal(tStart, tEnd, domain, topK)
      : episodicStore.queryRecent(topK, domain);

    for (const ev of window) {
      const age   = now - ev.timestamp;
      const score = Math.max(0.1, 1.0 - age / (86400 * 7)); // decay over 1 week
      candidates.push({
        mode:    'episodic',
        id:      ev.entry_id,
        score,
        content: ev.summary || ev.verbatim || '',
        source:  ev,
      });
    }

    // Also run queryBefore for the current moment (context of "what do I know up to now")
    if (query) {
      const beforeNow = episodicStore.queryBefore(now, domain, Math.ceil(topK / 2));
      for (const ev of beforeNow) {
        const age   = now - ev.timestamp;
        const score = Math.max(0.05, 0.8 - age / (86400 * 30)); // slower decay
        candidates.push({
          mode:    'episodic-before',
          id:      ev.entry_id,
          score,
          content: ev.summary || ev.verbatim || '',
          source:  ev,
        });
      }
    }
  }

  // ── Mode 3: Semantic triples ──────────────────────────────────────────────
  if (query) {
    const triples = semSearch(query, topK);
    for (const t of triples) {
      candidates.push({
        mode:    'semantic',
        id:      t.id,
        score:   t.confidence * 0.7,
        content: `${t.subject} ${t.predicate} ${t.object}`,
        source:  t,
      });
    }
  }

  // ── Mode 4: Procedural recipes ────────────────────────────────────────────
  if (query) {
    const recipes = findRecipes(query).slice(0, 3);
    for (const r of recipes) {
      candidates.push({
        mode:    'procedural',
        id:      r.id,
        score:   0.6,
        content: `Recipe: ${r.name} — ${r.steps.join(' → ')}`,
        source:  r,
      });
    }
  }

  // ── Mode 5: TF-IDF re-rank of episodic results ───────────────────────────
  if (query && episodicStore) {
    const pool = episodicStore.queryRecent(Math.max(topK * 4, 40), domain);
    if (pool.length > 0) {
      const texts  = pool.map(ev => ev.summary || ev.verbatim || '');
      const scores = tfidfScores(query, texts);
      for (let i = 0; i < pool.length; i++) {
        if (scores[i] > 0) {
          candidates.push({
            mode:    'tfidf',
            id:      pool[i].entry_id,
            score:   scores[i] * 0.9,
            content: pool[i].summary || pool[i].verbatim || '',
            source:  pool[i],
          });
        }
      }
    }
  }

  // ── Merge + dedup + rank ──────────────────────────────────────────────────
  const seen = new Set();
  const merged = [];

  for (const c of candidates.sort((a, b) => b.score - a.score)) {
    // Dedup by entry identity, NOT mode:id — otherwise the same memory surfaced
    // by recency AND tfidf AND semantic would occupy up to 3 of the topK slots.
    // Candidates are sorted by score, so the strongest mode for each entry wins.
    const key = String(c.id);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(c);
      if (merged.length >= topK * 2) break; // hard cap
    }
  }

  return merged.slice(0, topK);
}

/**
 * Format retrieval results for injection into the agent context.
 * @param {object[]} results
 * @returns {string}
 */
export function formatRetrievalResults(results) {
  if (results.length === 0) return '';
  const lines = results.map(r =>
    `[${r.mode}] ${r.content.slice(0, 200)} (score: ${r.score.toFixed(2)})`
  );
  return `## Palace Retrieval\n${lines.join('\n')}`;
}
