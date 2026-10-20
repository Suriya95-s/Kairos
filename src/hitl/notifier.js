// src/hitl/notifier.js
// Multi-channel notifier: Slack (4.7), Discord (4.8), email/SMTP (4.9).
// All channels are optional — configured via env vars.
// notify() fires all configured channels concurrently; individual failures are caught.

import net from 'node:net';
import config from '../config.js';

/**
 * Fire all configured notification channels for a HITL event.
 * @param {object} event — { type, id, tool, args, reason, thought, timeoutMs, ... }
 */
export async function notify(event) {
  const channels = [];
  if (process.env.KAIROS_SLACK_WEBHOOK_URL) channels.push(_notifySlack(event));
  if (process.env.KAIROS_DISCORD_WEBHOOK_URL) channels.push(_notifyDiscord(event));
  if (process.env.KAIROS_SMTP_HOST) channels.push(_notifyEmail(event));
  if (channels.length === 0) return;
  const results = await Promise.allSettled(channels);
  for (const r of results) {
    if (r.status === 'rejected') {
      // Log to stderr — non-critical; don't throw
      process.stderr.write(`[hitl/notifier] channel failed: ${r.reason?.message || r.reason}\n`);
    }
  }
}

// ── Slack (Task 4.7) ──────────────────────────────────────────────────────────

async function _notifySlack(event) {
  const url = process.env.KAIROS_SLACK_WEBHOOK_URL;
  const text = _formatSlack(event);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Slack webhook returned ${res.status}`);
}

function _formatSlack(event) {
  if (event.type === 'approval_requested') {
    const approveCmd = `agent approve ${event.id}`;
    const denyCmd = `agent deny ${event.id}`;
    return [
      `🔔 *Kairos needs approval* (id: \`${event.id}\`)`,
      `*Tool:* \`${event.tool}\``,
      `*Reason:* ${event.reason}`,
      event.thought ? `*Agent thought:* ${event.thought}` : '',
      `*Timeout:* ${Math.round(event.timeoutMs / 1000)}s`,
      `Approve: \`${approveCmd}\` | Deny: \`${denyCmd}\``,
    ].filter(Boolean).join('\n');
  }
  return `Kairos HITL event: ${event.type} — ${JSON.stringify(event).slice(0, 200)}`;
}

// ── Discord (Task 4.8) ────────────────────────────────────────────────────────

async function _notifyDiscord(event) {
  const url = process.env.KAIROS_DISCORD_WEBHOOK_URL;
  const content = _formatDiscord(event);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Discord webhook returned ${res.status}`);
}

function _formatDiscord(event) {
  if (event.type === 'approval_requested') {
    return [
      `🔔 **Kairos needs approval** (id: \`${event.id}\`)`,
      `**Tool:** \`${event.tool}\`  **Reason:** ${event.reason}`,
      event.thought ? `**Thought:** ${event.thought}` : '',
      `Timeout: ${Math.round(event.timeoutMs / 1000)}s`,
      `Run: \`agent approve ${event.id}\` or \`agent deny ${event.id}\``,
    ].filter(Boolean).join('\n');
  }
  return `Kairos HITL: ${event.type} — ${JSON.stringify(event).slice(0, 300)}`;
}

// ── Email / SMTP (Task 4.9) ───────────────────────────────────────────────────
// Minimal raw SMTP (no external deps). Uses Node's net module.
// Requires: KAIROS_SMTP_HOST, KAIROS_SMTP_PORT, KAIROS_SMTP_FROM, KAIROS_SMTP_TO
// Optional: KAIROS_SMTP_USER, KAIROS_SMTP_PASS (AUTH PLAIN)

async function _notifyEmail(event) {
  const host = process.env.KAIROS_SMTP_HOST;
  const port = parseInt(process.env.KAIROS_SMTP_PORT || '25', 10);
  const from = process.env.KAIROS_SMTP_FROM || 'kairos@localhost';
  const to = process.env.KAIROS_SMTP_TO;
  if (!to) throw new Error('KAIROS_SMTP_TO not set');

  const subject = event.type === 'approval_requested'
    ? `[Kairos] Approval needed: ${event.tool} (id ${event.id})`
    : `[Kairos] HITL event: ${event.type}`;
  const body = _formatEmail(event);

  await _sendSmtp({ host, port, from, to, subject, body,
    user: process.env.KAIROS_SMTP_USER,
    pass: process.env.KAIROS_SMTP_PASS,
  });
}

function _formatEmail(event) {
  if (event.type === 'approval_requested') {
    return [
      `Kairos agent is waiting for approval.`,
      ``,
      `Request ID: ${event.id}`,
      `Tool:       ${event.tool}`,
      `Reason:     ${event.reason}`,
      event.thought ? `Thought:    ${event.thought}` : '',
      `Timeout:    ${Math.round(event.timeoutMs / 1000)} seconds`,
      ``,
      `To approve: agent approve ${event.id}`,
      `To deny:    agent deny ${event.id}`,
    ].filter(l => l !== undefined).join('\r\n');
  }
  return `Kairos HITL event: ${event.type}\r\n${JSON.stringify(event, null, 2)}`;
}

function _sendSmtp({ host, port, from, to, subject, body, user, pass }) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(port, host);
    const lines = [];
    let step = 0;
    const timeout = setTimeout(() => { sock.destroy(); reject(new Error('SMTP timeout')); }, 15000);

    const send = (line) => sock.write(line + '\r\n');

    sock.setEncoding('utf-8');
    sock.on('error', err => { clearTimeout(timeout); reject(err); });
    sock.on('data', data => {
      const code = parseInt(data.slice(0, 3), 10);
      lines.push(data.trim());

      if (step === 0 && code === 220) { send(`EHLO localhost`); step = 1; }
      else if (step === 1 && code === 250) {
        if (user && pass) {
          send('AUTH PLAIN');
          step = 2;
        } else {
          send(`MAIL FROM:<${from}>`); step = 3;
        }
      }
      else if (step === 2 && code === 334) {
        const creds = Buffer.from(`\0${user}\0${pass}`).toString('base64');
        send(creds); step = 2.5;
      }
      else if (step === 2.5 && code === 235) { send(`MAIL FROM:<${from}>`); step = 3; }
      else if (step === 3 && code === 250) { send(`RCPT TO:<${to}>`); step = 4; }
      else if (step === 4 && code === 250) { send('DATA'); step = 5; }
      else if (step === 5 && code === 354) {
        send(`From: ${from}`);
        send(`To: ${to}`);
        send(`Subject: ${subject}`);
        send(`MIME-Version: 1.0`);
        send(`Content-Type: text/plain; charset=utf-8`);
        send(``);
        for (const line of body.split('\r\n')) send(line);
        send('.');
        step = 6;
      }
      else if (step === 6 && code === 250) { send('QUIT'); step = 7; }
      else if (step === 7 && code === 221) {
        clearTimeout(timeout);
        sock.destroy();
        resolve();
      }
      else if (code >= 400) {
        clearTimeout(timeout);
        sock.destroy();
        reject(new Error(`SMTP error: ${data.trim()}`));
      }
    });
  });
}
