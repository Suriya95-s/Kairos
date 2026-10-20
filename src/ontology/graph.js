// src/ontology/graph.js
// The knowledge-graph view: a domain projection rendered as a single
// self-contained HTML file — force-directed canvas, pan/zoom, click-to-inspect
// with evidence refs. No CDN, no framework, no network: the file must open on
// any machine exactly as governed, because it may be the artifact a human uses
// to review candidates.

import fs from 'node:fs';
import path from 'node:path';
import { domainDir, loadProjection, loadProjectionAsOf } from './store.js';

const INSTANCE_NODE_CAP = 400; // beyond this, the instance layer is summarized per type

/** Build the plain graph data {nodes, edges, meta} for a domain projection. */
export function graphData(projection) {
  const nodes = [];
  const edges = [];
  const typeEntries = [...(projection.object_type?.entries() || [])];
  const types = typeEntries.map(([, t]) => t);
  const instances = [...(projection.instance?.values() || [])];
  // Graph node ids derive from the type NAME (edges are name-keyed), but
  // proposals target STORE ids — after a rename the two diverge, so overlay
  // marking translates through this map.
  const typeNodeByStoreId = new Map(typeEntries.map(([id, t]) => [id, `type:${t.name}`]));

  const instByType = new Map();
  for (const inst of instances) {
    if (!instByType.has(inst.type)) instByType.set(inst.type, []);
    instByType.get(inst.type).push(inst);
  }

  for (const t of types) {
    nodes.push({
      id: `type:${t.name}`, kind: 'type', label: t.name,
      state: t.state || 'candidate',
      count: (instByType.get(t.name) || []).length,
      detail: {
        properties: (t.properties || []).map((p) => `${p.name}: ${p.type}${p.enum ? ` {${p.enum.join('|')}}` : ''}`),
        keyProperty: t.keyProperty || null,
        evidence: t.evidence || [],
      },
    });
  }

  const includeInstances = instances.length > 0 && instances.length <= INSTANCE_NODE_CAP;
  if (includeInstances) {
    for (const inst of instances) {
      nodes.push({
        id: `inst:${inst.type}:${inst.key}`, kind: 'instance',
        label: String(inst.key).slice(0, 24), type: inst.type,
        state: inst.state || 'candidate',
        detail: { properties: inst.properties || {}, evidence: inst.evidence || [] },
      });
      edges.push({ from: `inst:${inst.type}:${inst.key}`, to: `type:${inst.type}`, kind: 'instance_of', label: '' });
    }
  }

  for (const [relId, rel] of projection.relationship?.entries() || []) {
    if (rel.kind === 'reference') {
      edges.push({ id: relId, from: `type:${rel.fromType}`, to: `type:${rel.toType}`, kind: 'reference', label: rel.viaProperty || rel.name, state: rel.state });
    } else if (includeInstances && rel.from && rel.to) {
      edges.push({ id: relId, from: rel.from, to: rel.to, kind: rel.kind || 'link', label: rel.name || '', state: rel.state });
    }
  }

  // ── Proposal overlay (G4): what the agents are ASKING to change ───────────
  // Pending proposals render as dashed ghosts over the approved/candidate
  // graph: a proposed relation is a dashed edge, a proposed merge a dashed
  // tie between its two nodes, a proposed retirement a strike-through. Every
  // marked node carries the proposals in its detail panel, with the exact CLI
  // command a human runs to apply or retire each — the graph shows, the
  // human disposes.
  const pendingByNode = new Map();
  const markNode = (nodeId, p) => {
    if (!pendingByNode.has(nodeId)) pendingByNode.set(nodeId, []);
    pendingByNode.get(nodeId).push(p);
  };
  const pendingRetireEdges = new Set();
  const proposals = [...(projection.proposal?.entries() || [])]
    .filter(([, p]) => p.state === 'candidate');
  for (const [pid, p] of proposals) {
    const op = p.change?.op;
    const brief = {
      id: pid, op, confidence: p.confidence || 0, by: p.proposedBy || '',
      rationale: (p.rationale || '').slice(0, 140),
    };
    const nid = (storeId) => typeNodeByStoreId.get(storeId) || storeId;
    if (op === 'add_relation' && p.change.relation) {
      const r = p.change.relation;
      edges.push({ id: pid, from: `type:${r.from}`, to: `type:${r.to}`, kind: 'proposal', label: `${r.name}?`, proposal: brief });
      markNode(`type:${r.from}`, brief);
    } else if ((op === 'merge_types' || op === 'merge_instances') && p.change.keep && p.change.retire) {
      edges.push({ id: pid, from: nid(p.change.keep), to: nid(p.change.retire), kind: 'proposal', label: 'merge?', proposal: brief });
      markNode(nid(p.change.keep), brief);
      markNode(nid(p.change.retire), brief);
    } else if (op === 'retire_relation' && p.target?.id) {
      pendingRetireEdges.add(p.target.id);
      markNode(p.target.id, brief); // edge ids double as marks for the panel lookup below
    } else if (p.target?.id) {
      // rename / describe / retype_property / annotate → badge on the target
      markNode(nid(p.target.id), brief);
    }
  }
  for (const n of nodes) {
    const pending = pendingByNode.get(n.id);
    if (pending) { n.pending = pending.length; n.detail.pendingProposals = pending; }
  }
  for (const e of edges) {
    if (e.id && pendingRetireEdges.has(e.id)) {
      e.pendingRetire = true;
      e.proposal = (pendingByNode.get(e.id) || [])[0] || null;
    }
  }

  // Edges pointing at nodes we did not include (instance layer summarized) are dropped.
  const known = new Set(nodes.map((n) => n.id));
  const keptEdges = edges.filter((e) => known.has(e.from) && known.has(e.to));

  return {
    nodes, edges: keptEdges,
    meta: {
      domain: projection.domain,
      counts: projection.counts || {},
      openProposals: proposals.length,
      instancesSummarized: !includeInstances && instances.length > 0,
      ...(projection.asOf ? { asOf: new Date(projection.asOf).toISOString() } : {}),
      generatedAt: new Date().toISOString(),
    },
  };
}

/** Render the standalone HTML for a domain. Returns the HTML string. */
export function renderGraphHtml(projection) {
  const data = graphData(projection);
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kairos Ontology — ${escapeHtml(data.meta.domain)}</title>
<style>
  :root { --bg:#0e1116; --panel:#161b22; --ink:#e6edf3; --dim:#8b949e; --line:#30363d;
          --cand:#d29922; --appr:#3fb950; --ret:#f85149; --type:#58a6ff; }
  * { box-sizing: border-box; margin: 0; }
  body { background: var(--bg); color: var(--ink); font: 14px/1.5 ui-monospace, Consolas, monospace; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
  header { padding: 10px 16px; border-bottom: 1px solid var(--line); display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap; }
  header h1 { font-size: 16px; } header .dim { color: var(--dim); font-size: 12px; }
  .legend span { margin-right: 12px; font-size: 12px; }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 4px; }
  main { flex: 1; display: flex; min-height: 0; }
  canvas { flex: 1; display: block; cursor: grab; }
  aside { width: 320px; border-left: 1px solid var(--line); background: var(--panel); padding: 14px; overflow-y: auto; display: none; }
  aside.open { display: block; }
  aside h2 { font-size: 14px; margin-bottom: 4px; word-break: break-all; }
  aside .state { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
  aside dl { margin-top: 10px; font-size: 12px; }
  aside dt { color: var(--dim); margin-top: 8px; }
  aside dd { word-break: break-all; }
  aside .ev { color: var(--dim); font-size: 11px; margin-top: 2px; }
</style>
</head>
<body>
<header>
  <h1>◆ ${escapeHtml(data.meta.domain)}</h1>
  <span class="dim">${data.nodes.filter(n=>n.kind==='type').length} types · ${data.meta.counts.instance||0} instances · ${data.meta.counts.relationship||0} relations${data.meta.openProposals ? ` · ◇ ${data.meta.openProposals} pending proposal${data.meta.openProposals > 1 ? 's' : ''}` : ''}${data.meta.asOf ? ` · as of ${escapeHtml(data.meta.asOf)}` : ''}${data.meta.instancesSummarized ? ` · instance layer summarized (>${INSTANCE_NODE_CAP} nodes)` : ''}</span>
  <span class="legend">
    <span><span class="dot" style="background:var(--type)"></span>type</span>
    <span><span class="dot" style="background:var(--cand)"></span>candidate</span>
    <span><span class="dot" style="background:var(--appr)"></span>approved</span>
    <span><span class="dot" style="background:var(--ret)"></span>retired</span>
    <span style="color:var(--cand)">◇ proposal (dashed)</span>
  </span>
  <span class="dim">drag to pan · wheel to zoom · click a node</span>
</header>
<main>
  <canvas id="c"></canvas>
  <aside id="panel"></aside>
</main>
<script>
const DATA = ${json};
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const panel = document.getElementById('panel');
let W, H, dpr = window.devicePixelRatio || 1;
function resize() {
  W = canvas.clientWidth; H = canvas.clientHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', () => { resize(); });

// Deterministic starting layout (golden-angle spiral) so the same data always
// opens looking the same.
const nodes = DATA.nodes.map((n, i) => {
  const a = i * 2.39996, r = 40 + 14 * Math.sqrt(i);
  return { ...n, x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0 };
});
const byId = new Map(nodes.map((n) => [n.id, n]));
const edges = DATA.edges.filter((e) => byId.has(e.from) && byId.has(e.to));

let view = { x: 0, y: 0, k: 1 };
let dragging = null, panning = false, last = null, selected = null;
let alpha = 1;

function radius(n) { return n.kind === 'type' ? Math.min(30, 12 + Math.sqrt(n.count || 0) * 2) : 5; }
function color(n) {
  if (n.state === 'retired') return '#f85149';
  if (n.kind === 'type') return n.state === 'approved' ? '#3fb950' : '#58a6ff';
  return n.state === 'approved' ? '#3fb950' : '#d29922';
}

function tick() {
  if (alpha > 0.02) {
    // repulsion
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      let dx = a.x - b.x, dy = a.y - b.y;
      let d2 = dx * dx + dy * dy || 1;
      if (d2 > 90000) continue;
      const f = (a.kind === 'type' && b.kind === 'type' ? 2600 : 600) / d2;
      const d = Math.sqrt(d2);
      dx /= d; dy /= d;
      a.vx += dx * f * alpha; a.vy += dy * f * alpha;
      b.vx -= dx * f * alpha; b.vy -= dy * f * alpha;
    }
    // springs
    for (const e of edges) {
      const a = byId.get(e.from), b = byId.get(e.to);
      const rest = e.kind === 'instance_of' ? 60 : 160;
      let dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - rest) * 0.02;
      dx /= d; dy /= d;
      a.vx += dx * f * alpha; a.vy += dy * f * alpha;
      b.vx -= dx * f * alpha; b.vy -= dy * f * alpha;
    }
    // centering + integrate
    for (const n of nodes) {
      n.vx -= n.x * 0.001 * alpha; n.vy -= n.y * 0.001 * alpha;
      if (n !== dragging) { n.x += n.vx; n.y += n.vy; }
      n.vx *= 0.85; n.vy *= 0.85;
    }
    alpha *= 0.995;
  }
  draw();
  requestAnimationFrame(tick);
}

function draw() {
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.translate(W / 2 + view.x, H / 2 + view.y);
  ctx.scale(view.k, view.k);
  ctx.strokeStyle = '#30363d';
  for (const e of edges) {
    const a = byId.get(e.from), b = byId.get(e.to);
    const proposalEdge = e.kind === 'proposal';
    const retiredEdge = e.state === 'retired';
    // Dashed = not (or no longer) settled: a proposal asking to exist, or a
    // relation a critic is asking to retire.
    ctx.setLineDash(proposalEdge || e.pendingRetire ? [6, 5] : retiredEdge ? [2, 4] : []);
    ctx.globalAlpha = e.kind === 'instance_of' ? 0.25 : retiredEdge ? 0.35 : 0.7;
    ctx.lineWidth = proposalEdge ? 1.4 : e.kind === 'reference' ? 1.6 : 0.7;
    ctx.strokeStyle = proposalEdge ? '#d29922' : e.pendingRetire ? '#f85149' : retiredEdge ? '#f85149' : e.kind === 'reference' ? '#8b949e' : '#30363d';
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.setLineDash([]);
    if ((e.kind === 'reference' || proposalEdge) && view.k > 0.5) {
      ctx.globalAlpha = 0.9; ctx.fillStyle = proposalEdge ? '#d29922' : '#8b949e'; ctx.font = '10px ui-monospace';
      ctx.fillText(e.label || '', (a.x + b.x) / 2 + 4, (a.y + b.y) / 2 - 4);
    }
  }
  ctx.globalAlpha = 1;
  for (const n of nodes) {
    const r = radius(n);
    ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 7);
    ctx.fillStyle = color(n); ctx.globalAlpha = n.state === 'retired' ? 0.45 : n.kind === 'type' ? 0.92 : 0.8; ctx.fill();
    if (n === selected) { ctx.globalAlpha = 1; ctx.lineWidth = 2; ctx.strokeStyle = '#e6edf3'; ctx.stroke(); }
    if (n.pending) {
      // The amber diamond marks "agents are asking about this node".
      ctx.globalAlpha = 1; ctx.fillStyle = '#d29922'; ctx.font = 'bold 11px ui-monospace';
      ctx.textAlign = 'center';
      ctx.fillText('◇' + (n.pending > 1 ? n.pending : ''), n.x + r + 8, n.y - r - 2);
    }
    if (n.kind === 'type' || view.k > 1.4) {
      ctx.globalAlpha = 1; ctx.fillStyle = n.state === 'retired' ? '#8b949e' : '#e6edf3';
      ctx.font = (n.kind === 'type' ? 'bold 12px' : '10px') + ' ui-monospace';
      ctx.textAlign = 'center';
      ctx.fillText(n.label + (n.kind === 'type' ? ' (' + n.count + ')' : ''), n.x, n.y - r - 5);
    }
  }
  ctx.restore();
}

function pick(mx, my) {
  const x = (mx - W / 2 - view.x) / view.k, y = (my - H / 2 - view.y) / view.k;
  let best = null, bestD = 1e9;
  for (const n of nodes) {
    const r = radius(n) + 4;
    const d = (n.x - x) ** 2 + (n.y - y) ** 2;
    if (d < r * r && d < bestD) { best = n; bestD = d; }
  }
  return best;
}

canvas.addEventListener('mousedown', (ev) => {
  const n = pick(ev.offsetX, ev.offsetY);
  if (n) { dragging = n; alpha = Math.max(alpha, 0.3); }
  else panning = true;
  last = { x: ev.offsetX, y: ev.offsetY };
});
window.addEventListener('mousemove', (ev) => {
  if (!last) return;
  const dx = ev.offsetX - last.x, dy = ev.offsetY - last.y;
  if (dragging) { dragging.x += dx / view.k; dragging.y += dy / view.k; }
  else if (panning) { view.x += dx; view.y += dy; }
  last = { x: ev.offsetX, y: ev.offsetY };
});
window.addEventListener('mouseup', () => {
  dragging = null; panning = false; last = null;
});
canvas.addEventListener('click', (ev) => {
  const n = pick(ev.offsetX, ev.offsetY);
  select(n);
});
canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const k = Math.min(4, Math.max(0.15, view.k * (ev.deltaY < 0 ? 1.12 : 0.89)));
  view.k = k;
}, { passive: false });

function select(n) {
  selected = n;
  if (!n) { panel.classList.remove('open'); return; }
  panel.classList.add('open');
  const stateColor = n.state === 'approved' ? 'var(--appr)' : 'var(--cand)';
  let html = '<h2>' + esc(n.label) + '</h2>' +
    '<div class="state" style="color:' + stateColor + '">' + esc(n.kind) + ' · ' + esc(n.state) + '</div><dl>';
  const d = n.detail || {};
  if (Array.isArray(d.properties)) {
    html += '<dt>properties</dt>' + d.properties.map((p) => '<dd>' + esc(p) + '</dd>').join('');
    if (d.keyProperty) html += '<dt>key</dt><dd>' + esc(d.keyProperty) + '</dd>';
  } else if (d.properties) {
    for (const [k, v] of Object.entries(d.properties)) html += '<dt>' + esc(k) + '</dt><dd>' + esc(String(v)) + '</dd>';
  }
  const ev = d.evidence || [];
  if (ev.length) {
    html += '<dt>evidence</dt>' + ev.map((e) => '<dd class="ev">' + esc(e.snapshot) + ' @ ' + esc(e.locator) + '</dd>').join('');
  }
  // Pending proposals (G4): the graph shows what the agents are asking; the
  // command below is how a HUMAN answers. Deliberately a command, not a
  // button — approval stays an authenticated act in the CLI/TUI, never a
  // click in a rendered file.
  const pending = d.pendingProposals || [];
  if (pending.length) {
    html += '<dt style="color:var(--cand)">◇ pending proposals</dt>';
    for (const p of pending) {
      html += '<dd style="margin-top:6px"><b>' + esc(p.op) + '</b> (' + Math.round((p.confidence || 0) * 100) + '% · ' + esc(p.by) + ')' +
        (p.rationale ? '<div class="ev">' + esc(p.rationale) + '</div>' : '') +
        '<div class="ev">apply: kairos ontology approve ' + esc(DATA.meta.domain) + ' proposal ' + esc(p.id) + '</div>' +
        '<div class="ev">reject: kairos ontology retire ' + esc(DATA.meta.domain) + ' proposal ' + esc(p.id) + '</div></dd>';
    }
  }
  html += '</dl>';
  panel.innerHTML = html;
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

resize();
tick();
</script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * Render + write graph.html into the domain dir. Returns the absolute path.
 * With `asOf` (epoch ms), renders the domain as it stood at that instant into
 * a separate graph-asof.html — the live view is never clobbered by history.
 */
export function writeGraphHtml(domain, { asOf = null } = {}) {
  const projection = asOf ? loadProjectionAsOf(domain, asOf) : loadProjection(domain);
  const html = renderGraphHtml(projection);
  const out = path.join(domainDir(domain), asOf ? 'graph-asof.html' : 'graph.html');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html, 'utf-8');
  return out;
}

export default { graphData, renderGraphHtml, writeGraphHtml, INSTANCE_NODE_CAP };
