// src/kernel/webclient.js
// A small web surface on the daemon (8.4).
//
// The point of this page is one thing the CLI and TUI cannot do: be open on a
// phone. An approval that times out is denied, so "I was away from my laptop"
// is a security-relevant failure — and a phone browser pointed at the daemon
// over the LAN or a tunnel is the least-effort way to close it.
//
// One self-contained string. No build step, no framework, no CDN: this is
// served by a zero-dependency daemon and adding a bundler to render three
// buttons would be a poor trade. It is also small enough to audit, which
// matters for a page that can approve irreversible actions.
//
// The token is NOT baked into the page. It arrives as `?token=` and lives only
// in memory for the tab's lifetime — writing it into the HTML would leave it in
// the browser cache and in any screenshot of the page.

export const WEB_CLIENT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>kairos</title>
<style>
  :root{--bg:#0e1013;--fg:#e6e8ea;--dim:#8b9199;--line:#22262c;--ok:#3fb950;--warn:#d29922;--bad:#f85149;--accent:#58a6ff}
  @media(prefers-color-scheme:light){:root{--bg:#fff;--fg:#1f2328;--dim:#656d76;--line:#d8dee4;--accent:#0969da}}
  *{box-sizing:border-box}
  body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:var(--bg);color:var(--fg);
       padding:max(12px,env(safe-area-inset-top)) 12px max(12px,env(safe-area-inset-bottom))}
  header{display:flex;align-items:center;gap:8px;padding-bottom:10px;border-bottom:1px solid var(--line)}
  h1{font-size:16px;margin:0;font-weight:600}
  .dot{width:9px;height:9px;border-radius:50%;background:var(--dim);flex:none}
  .dot.ok{background:var(--ok)}.dot.warn{background:var(--warn)}.dot.bad{background:var(--bad)}
  #meta{color:var(--dim);font-size:13px;margin-left:auto;text-align:right}
  section{margin:16px 0}
  h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);margin:0 0 8px}
  .card{border:1px solid var(--line);border-radius:10px;padding:12px;margin-bottom:8px}
  .card.urgent{border-color:var(--warn)}
  .tool{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;word-break:break-all}
  .why{color:var(--dim);font-size:13px;margin-top:4px}
  .tier{display:inline-block;font-size:11px;padding:1px 6px;border-radius:20px;border:1px solid var(--line);color:var(--dim)}
  .tier.T3{color:var(--bad);border-color:var(--bad)}
  .row{display:flex;gap:8px;margin-top:10px}
  button{flex:1;padding:11px;font-size:15px;border-radius:8px;border:1px solid var(--line);
         background:transparent;color:var(--fg);cursor:pointer;min-height:44px}
  button.approve{border-color:var(--ok);color:var(--ok)}
  button.deny{border-color:var(--bad);color:var(--bad)}
  button:disabled{opacity:.4;cursor:default}
  ul{list-style:none;margin:0;padding:0}
  li{padding:7px 0;border-bottom:1px solid var(--line);font-size:13.5px;display:flex;gap:8px}
  li:last-child{border-bottom:0}
  .t{color:var(--dim);font-variant-numeric:tabular-nums;flex:none}
  .empty{color:var(--dim);font-size:13.5px;padding:4px 0}
  #err{color:var(--bad);font-size:13px;padding:8px 0}
</style>
</head>
<body>
<header>
  <span class="dot" id="dot"></span>
  <h1>kairos</h1>
  <span id="meta">connecting…</span>
</header>

<div id="err" hidden></div>

<section id="approvals-section" hidden>
  <h2>Waiting on you</h2>
  <div id="approvals"></div>
</section>

<section>
  <h2>Missions</h2>
  <ul id="missions"><li class="empty">…</li></ul>
</section>

<section>
  <h2>Recent</h2>
  <ul id="events"><li class="empty">…</li></ul>
</section>

<script>
// The token is held in memory only. Writing it into the document would leave it
// in the browser cache and in any screenshot of this page.
const TOKEN = new URLSearchParams(location.search).get('token') || '';
const auth = { Authorization: 'Bearer ' + TOKEN };
const pending = new Map();

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const clock = (ts) => new Date(ts).toTimeString().slice(0, 5);

function showError(msg) { const e = $('err'); e.hidden = !msg; e.textContent = msg || ''; }

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { ...auth, ...(opts.headers || {}) } });
  if (res.status === 401) { showError('Unauthorized — open this page using the link kairos printed.'); throw new Error('401'); }
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function refresh() {
  try {
    const s = await api('/api/status');
    showError('');
    const healthy = s.health === 'healthy';
    $('dot').className = 'dot ' + (healthy ? 'ok' : s.health === 'stopped' ? 'bad' : 'warn');
    $('meta').textContent = s.health + ' · ' + s.missions.active + ' active';

    const m = await api('/api/missions');
    const live = m.missions.slice(0, 12);
    $('missions').innerHTML = live.length
      ? live.map(x => '<li><span class="t">' + esc(x.state) + '</span><span>' + esc(x.title) + '</span></li>').join('')
      : '<li class="empty">nothing running</li>';
  } catch (e) { if (e.message !== '401') showError(e.message); }
}

function renderApprovals() {
  const list = [...pending.values()];
  $('approvals-section').hidden = list.length === 0;
  $('approvals').innerHTML = list.map(a => \`
    <div class="card urgent" data-id="\${esc(a.id)}">
      <span class="tier \${esc(a.tier)}">\${esc(a.tier)}</span>
      <div class="tool">\${esc(a.tool)}</div>
      <div class="why">\${esc(a.reason)}</div>
      <div class="row">
        <button class="approve" data-act="approve" data-id="\${esc(a.id)}">Approve</button>
        <button class="deny" data-act="deny" data-id="\${esc(a.id)}">Deny</button>
      </div>
    </div>\`).join('');
}

// Delegated so buttons rendered later still work.
document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const { act, id } = btn.dataset;
  // Disable BOTH buttons immediately: a double-tap on a phone must not send
  // approve and deny for the same request.
  btn.closest('.card').querySelectorAll('button').forEach(b => { b.disabled = true; });
  try {
    await api('/api/' + act + '/' + encodeURIComponent(id), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: act + 'd from the web client' }),
    });
    pending.delete(id);
    renderApprovals();
  } catch (e) {
    showError('Could not ' + act + ': ' + e.message);
    btn.closest('.card').querySelectorAll('button').forEach(b => { b.disabled = false; });
  }
});

const seen = [];
function addEvent(evt) {
  let text = evt.kind;
  const p = evt.payload || {};
  if (evt.kind === 'mission_update') text = p.action + ' · ' + (p.missionId || '');
  else if (evt.kind === 'utterance') text = '“' + (p.text || '').slice(0, 60) + '”';
  else if (evt.kind === 'health') text = 'health: ' + p.state;
  else if (evt.kind === 'trigger') text = p.text || p.description || p.action || 'trigger';
  else if (evt.kind === 'approval') text = p.action + ' · ' + (p.tool || '');
  seen.unshift({ t: clock(evt.ts), text });
  seen.length = Math.min(seen.length, 25);
  $('events').innerHTML = seen.map(e =>
    '<li><span class="t">' + esc(e.t) + '</span><span>' + esc(e.text) + '</span></li>').join('');
}

function stream() {
  const es = new EventSource('/events?token=' + encodeURIComponent(TOKEN));
  es.onmessage = (m) => {
    let evt; try { evt = JSON.parse(m.data); } catch { return; }
    addEvent(evt);
    const p = evt.payload || {};
    if (evt.kind === 'approval' && p.action === 'approval_requested') {
      pending.set(p.id, { id: p.id, tool: p.tool, tier: p.tier, reason: p.reason });
      renderApprovals();
    }
    if (evt.kind === 'mission_update' && p.action === 'ended') refresh();
  };
  // EventSource reconnects on its own, but a dead daemon should look dead
  // rather than look idle — an empty page is indistinguishable from "nothing
  // is happening", which is the wrong impression when the daemon is down.
  es.onerror = () => { $('dot').className = 'dot bad'; $('meta').textContent = 'disconnected'; };
  es.onopen = () => refresh();
}

if (!TOKEN) showError('No token in the URL. Use the link kairos printed at startup.');
else { refresh(); stream(); setInterval(refresh, 15000); }
</script>
</body>
</html>`;

/** The URL to hand a phone. */
export function webClientUrl({ host = '127.0.0.1', port, token }) {
  return `http://${host}:${port}/?token=${encodeURIComponent(token)}`;
}
