// src/trust/channel.js
// Approval delivery (7.5): getting the question to wherever the person is.
//
// The gate built in 7.1–7.3 is only as good as its reachability. An approval
// request that appears solely in a terminal the user closed an hour ago will
// sit there until it times out — and timeout means deny, so the practical
// result of an unreachable channel is that nothing ever gets approved and the
// user turns the gate off. Reachability is a security property, not a
// convenience.
//
// So: channels are pluggable, several can be live at once, and each carries
// **actions** rather than just text. The approve/deny links resolve back into
// the same approval queue the TUI and CLI already write to — one queue, several
// front doors, and no second code path that could diverge from the first.
//
// What is deliberately NOT here: any third-party service. No push provider, no
// SMS gateway, nothing that phones home. The adapters are `desktop` (an OS
// notification on the machine that is already running the daemon) and `webhook`
// (a URL the user supplies). Anything else is theirs to add, and the webhook
// adapter is the seam to add it through.

import { spawn } from 'node:child_process';

/** Delivery adapters, by name. */
export const CHANNELS = Object.freeze(['desktop', 'webhook', 'bus']);

/**
 * One pending approval, in the shape a channel renders.
 * @typedef {{id: string, tool: string, tier: string, reason: string,
 *            args: object, approveUrl?: string, denyUrl?: string,
 *            expiresAt: number}} ApprovalRequest
 */

export class ApprovalChannel {
  /**
   * @param {object} [opts]
   * @param {string[]} [opts.enabled]  which adapters to use
   * @param {string} [opts.webhookUrl]
   * @param {object} [opts.bus]
   * @param {string} [opts.baseUrl]    the daemon's loopback URL, for action links
   * @param {string} [opts.token]      daemon token, so the links actually work
   * @param {function} [opts.now]
   */
  constructor({ enabled = ['bus'], webhookUrl = null, bus = null, baseUrl = null, token = null, now = Date.now } = {}) {
    this.enabled = enabled.filter(c => CHANNELS.includes(c));
    this._webhookUrl = webhookUrl;
    this._bus = bus;
    this._baseUrl = baseUrl;
    this._token = token;
    this._now = now;
    this.delivered = 0;
    this.failures = [];
  }

  /**
   * Deliver an approval request everywhere that is enabled.
   *
   * Every adapter is attempted even if an earlier one fails: a broken webhook
   * must not stop the desktop notification, because the cost of a missed
   * approval is silent denial-by-timeout.
   *
   * @returns {Promise<{delivered: string[], failed: string[]}>}
   */
  async deliver(request) {
    const enriched = this._withActions(request);
    const delivered = [];
    const failed = [];

    await Promise.all(this.enabled.map(async (name) => {
      try {
        await this._send(name, enriched);
        delivered.push(name);
      } catch (err) {
        failed.push(name);
        this.failures.push({ channel: name, error: err.message, ts: this._now() });
      }
    }));

    this.delivered += delivered.length;
    return { delivered, failed, request: enriched };
  }

  /**
   * Attach approve/deny links.
   *
   * They point at the daemon's own loopback API and carry its token, so acting
   * on them writes into the same approval queue as the TUI. Without the token
   * the links are decorative, and a channel that shows a button that does not
   * work is worse than one that shows no button.
   */
  _withActions(request) {
    if (!this._baseUrl || !this._token) return { ...request, actionable: false };
    const q = `?token=${encodeURIComponent(this._token)}`;
    return {
      ...request,
      actionable: true,
      approveUrl: `${this._baseUrl}/api/approve/${encodeURIComponent(request.id)}${q}`,
      denyUrl: `${this._baseUrl}/api/deny/${encodeURIComponent(request.id)}${q}`,
    };
  }

  async _send(name, req) {
    if (name === 'bus') return this._sendBus(req);
    if (name === 'desktop') return this._sendDesktop(req);
    if (name === 'webhook') return this._sendWebhook(req);
    throw new Error(`unknown approval channel "${name}"`);
  }

  _sendBus(req) {
    if (!this._bus) throw new Error('no bus');
    this._bus.publish({
      source: 'system',
      kind: 'approval',
      sessionId: req.sessionId ?? null,
      // Always `now`: someone is blocked waiting for this answer, and it will
      // be DENIED if nobody comes. This is the one notification that must not
      // be queued behind etiquette.
      urgency: 'now',
      payload: {
        action: 'approval_requested',
        id: req.id, tool: req.tool, tier: req.tier, reason: req.reason,
        expiresAt: req.expiresAt, actionable: req.actionable,
      },
    });
  }

  /**
   * An OS notification on the machine running the daemon.
   *
   * Fire-and-forget and best-effort: notification daemons are absent in SSH
   * sessions, containers and headless machines, and none of that should look
   * like an error.
   */
  _sendDesktop(req) {
    const title = `${req.tier} approval needed`;
    const body = `${req.tool} — ${req.reason}`.slice(0, 200);

    let cmd, args;
    if (process.platform === 'darwin') {
      cmd = 'osascript';
      args = ['-e', `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`];
    } else if (process.platform === 'win32') {
      cmd = 'powershell';
      args = ['-NoProfile', '-Command',
        `[reflection.assembly]::loadwithpartialname('System.Windows.Forms')>$null;` +
        `$n=New-Object System.Windows.Forms.NotifyIcon;` +
        `$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;` +
        `$n.ShowBalloonTip(10000,${psQuote(title)},${psQuote(body)},'Info')`];
    } else {
      cmd = 'notify-send';
      args = ['-u', 'critical', title, body];
    }

    return new Promise((resolve) => {
      try {
        const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true, detached: false });
        child.on('error', () => resolve());   // no notification daemon — not an error
        child.on('exit', () => resolve());
        // Never let a wedged notifier hold up the approval flow.
        const t = setTimeout(() => { try { child.kill(); } catch {} resolve(); }, 5000);
        if (typeof t.unref === 'function') t.unref();
      } catch {
        resolve();
      }
    });
  }

  /**
   * POST the request to a user-supplied URL.
   *
   * This is the seam for a phone. The payload carries the approve/deny links,
   * so whatever receives it can render real buttons rather than "go and look at
   * your laptop".
   */
  async _sendWebhook(req) {
    if (!this._webhookUrl) throw new Error('no webhook url configured');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(this._webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          type: 'approval_request',
          id: req.id,
          tool: req.tool,
          tier: req.tier,
          reason: req.reason,
          // Arguments are already redacted by the ledger/gateway before they
          // reach here, but this leaves the machine — so send the summary only.
          summary: `${req.tool} (${req.tier}): ${req.reason}`.slice(0, 300),
          approveUrl: req.approveUrl ?? null,
          denyUrl: req.denyUrl ?? null,
          expiresAt: req.expiresAt,
        }),
      });
      if (!res.ok) throw new Error(`webhook returned ${res.status}`);
    } finally {
      clearTimeout(timer);
    }
  }

  status() {
    return {
      enabled: this.enabled,
      delivered: this.delivered,
      recentFailures: this.failures.slice(-5),
      actionable: !!(this._baseUrl && this._token),
    };
  }
}

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * Build a channel from daemon configuration.
 *
 * Defaults to `bus` only. Turning on a channel that leaves the machine is an
 * explicit choice, because it is also a choice about what gets sent where.
 */
export function channelFromConfig({ bus = null, baseUrl = null, token = null, env = process.env } = {}) {
  const enabled = ['bus'];
  if (env.KAIROS_APPROVAL_DESKTOP === '1') enabled.push('desktop');
  const webhookUrl = env.KAIROS_APPROVAL_WEBHOOK || null;
  if (webhookUrl) enabled.push('webhook');

  return new ApprovalChannel({ enabled, webhookUrl, bus, baseUrl, token });
}
