// src/trust/integrations.js
// Graduated capability (7.4): a new integration starts narrow and widens by an
// explicit human decision, never by accumulating confidence.
//
// The plan gives an ordering — calendar → email (draft-only first) → messaging
// → browser-use → home/devices — and says "one at a time, each behind its
// tier". Tiers alone do not express that. A tier says *how much confirmation*
// an action needs; it cannot say "this capability is not switched on yet". Those
// are different questions, and conflating them is how the first day of an email
// integration becomes the day it sends something.
//
// So each integration has **stages**, and a stage is a hard boundary rather
// than a prompt:
//
//   off        the capability is not enabled; calls are DENIED, not queued
//   read       queries only
//   draft      create and edit, but nothing that reaches another person
//   full       the whole surface, still behind its normal tier gate
//
// Two properties make this worth having rather than ceremonial:
//
//   1. **A blocked call is denied outright.** Not "ask the user" — asking is how
//      a half-configured integration gets approved at 2am by someone who
//      assumes the system knows what it is doing. There is no approval prompt
//      that can advance a stage.
//   2. **Stages advance only by an explicit command.** Not by success count, not
//      by the promotion pipeline in 9.3. A track record of drafting emails is
//      not evidence that sending them is wanted — that is a decision, and it
//      stays a decision.

import {
  SCHEMA_VERSION,
  file as kernelFile,
  readRegistry,
  writeRegistry,
  migrateRegistry,
} from '../kernel/paths.js';
import { classify as classifyTier } from './tiers.js';

/** Ordered from least to most capable. */
export const STAGES = Object.freeze(['off', 'read', 'draft', 'full']);

export function stageRank(stage) {
  const i = STAGES.indexOf(stage);
  // An unrecognised stage is the most restrictive, not the least: a typo in a
  // state file must not switch a capability on.
  return i === -1 ? 0 : i;
}

/**
 * The capability classes from the plan, in the plan's order.
 *
 * `verbs` maps a stage to the tool-name patterns it permits. A tool matching no
 * pattern at the current stage is denied — an allowlist, because this is the
 * layer where a denylist's "anything unanticipated is allowed" is least
 * survivable.
 */
export const INTEGRATIONS = Object.freeze({
  calendar: {
    order: 1,
    label: 'calendar',
    // Deliberately first: its mistakes are visible and reversible, which is
    // what you want from the first real-world thing an agent touches.
    servers: ['gcal', 'calendar', 'gcalendar', 'outlook-calendar', 'caldav'],
    verbs: {
      read: [/^(get|list|search|find|query|read)_/i],
      draft: [/^(create|add|update|edit|move|schedule|book)_/i],
      full: [/^(delete|remove|cancel|invite|respond)_/i],
    },
  },
  email: {
    order: 2,
    label: 'email',
    servers: ['gmail', 'mail', 'email', 'imap', 'outlook-mail'],
    verbs: {
      read: [/^(get|list|search|read|fetch)_/i],
      // The plan's "draft-only first", made mechanical. `create_draft` is
      // reachable at this stage; `send_*` is not reachable at all.
      draft: [/^(create|save|update|edit)_?draft/i, /^(create|update|edit)_/i],
      full: [/^(send|reply|forward)_/i, /^send$/i],
    },
  },
  messaging: {
    order: 3,
    label: 'messaging',
    servers: ['slack', 'discord', 'telegram', 'twilio', 'sms', 'teams'],
    verbs: {
      read: [/^(get|list|search|read|history)_/i],
      draft: [/^(create|update|edit)_/i],
      full: [/^(send|post|reply|message|dm)_/i, /^(send|post)$/i],
    },
  },
  browser: {
    order: 4,
    label: 'browser-use',
    servers: ['browser', 'playwright', 'puppeteer', 'chrome'],
    verbs: {
      read: [/^(navigate|screenshot|read|get|extract|snapshot)_?/i],
      draft: [/^(fill|type|select)_/i],
      // Clicking is where a browser stops being a reader: a click can buy
      // something, and no verb list can tell which one will.
      full: [/^(click|submit|download|upload|execute)_/i],
    },
  },
  devices: {
    order: 5,
    label: 'home/devices',
    servers: ['homeassistant', 'hue', 'homekit', 'mqtt', 'zwave'],
    verbs: {
      read: [/^(get|list|state|status|read)_/i],
      draft: [],
      // There is no meaningful "draft" for a physical device — a light is
      // either switched or it is not — so anything that acts requires `full`.
      full: [/^(set|turn|toggle|open|close|lock|unlock|run|activate)_/i],
    },
  },
});

const MIGRATIONS = { 1: (data) => ({ stages: data.stages || {}, ...data }) };

/** Every capability starts off. Enabling one is a decision, so it has no default. */
const DEFAULT_STAGE = 'off';

export class IntegrationRegistry {
  constructor({ filePath = null, now = Date.now, persist = true, onAudit = null } = {}) {
    this._filePath = filePath;
    this._now = now;
    this._persist = persist;
    this._onAudit = onAudit;
    this._stages = new Map();
    this._loaded = false;
  }

  get filePath() { return this._filePath || kernelFile('integrations.json'); }

  load() {
    if (this._loaded) return this;
    this._loaded = true;
    if (!this._persist) return this;
    const raw = readRegistry(this.filePath, null);
    if (raw) {
      const { data } = migrateRegistry(raw, MIGRATIONS, SCHEMA_VERSION);
      for (const [name, rec] of Object.entries(data.stages || {})) this._stages.set(name, rec);
    }
    return this;
  }

  save() {
    if (!this._persist) return this;
    const stages = {};
    for (const [k, v] of this._stages) stages[k] = v;
    writeRegistry(this.filePath, { schemaVersion: SCHEMA_VERSION, stages });
    return this;
  }

  /** Current stage of a capability class. */
  stageOf(capability) {
    this.load();
    return this._stages.get(capability)?.stage ?? DEFAULT_STAGE;
  }

  /**
   * Set a capability's stage.
   *
   * `by` is recorded because this is the audit trail for "who turned email
   * sending on". Advancing more than one step at a time is allowed but noted —
   * off → full skips the stage where you would have found out the server names
   * its tools something unexpected.
   */
  setStage(capability, stage, { by = 'user', reason = '' } = {}) {
    this.load();
    if (!INTEGRATIONS[capability]) {
      throw new Error(`unknown capability "${capability}" (known: ${Object.keys(INTEGRATIONS).join(', ')})`);
    }
    if (!STAGES.includes(stage)) {
      throw new Error(`unknown stage "${stage}" (expected: ${STAGES.join(', ')})`);
    }
    const from = this.stageOf(capability);
    const jumped = stageRank(stage) - stageRank(from) > 1;

    this._stages.set(capability, {
      stage,
      from,
      changedAt: this._now(),
      by,
      reason,
      jumped,
    });
    this.save();
    this._audit({ action: 'stage_changed', capability, from, to: stage, by, reason, jumped });
    return { capability, from, to: stage, jumped };
  }

  /** Which capability class does this tool belong to? null when none. */
  capabilityOf(tool) {
    const name = String(tool || '');
    if (!name.includes('__')) return null;
    const server = name.split('__')[0].toLowerCase();

    for (const [capability, spec] of Object.entries(INTEGRATIONS)) {
      if (spec.servers.some(s => server === s || server.includes(s))) return capability;
    }
    return null;
  }

  /**
   * May this tool be called at the capability's current stage?
   *
   * @returns {{allowed: boolean, capability: string|null, stage: string,
   *            needsStage?: string, reason: string}}
   */
  check(tool) {
    const capability = this.capabilityOf(tool);
    // Not part of a managed integration — this layer has no opinion, and the
    // tier gate is what governs it.
    if (!capability) return { allowed: true, capability: null, stage: 'n/a', reason: 'not a managed integration' };

    const spec = INTEGRATIONS[capability];
    const stage = this.stageOf(capability);
    const toolPart = String(tool).split('__').slice(1).join('__');

    if (stage === 'off') {
      return {
        allowed: false, capability, stage,
        needsStage: 'read',
        reason: `the ${spec.label} integration is not enabled`,
      };
    }

    // Find the lowest stage that permits this verb.
    const needed = ['read', 'draft', 'full'].find(s =>
      (spec.verbs[s] || []).some(re => re.test(toolPart)));

    if (!needed) {
      // A verb no stage recognises. Requiring `full` is the safe reading: an
      // unanticipated verb on an email server is more likely to be `send_now`
      // than `list_folders`.
      return stageRank(stage) >= stageRank('full')
        ? { allowed: true, capability, stage, reason: `unrecognised verb, permitted at ${stage}` }
        : {
          allowed: false, capability, stage, needsStage: 'full',
          reason: `"${toolPart}" is not a verb the ${spec.label} integration recognises, so it needs the full stage`,
        };
    }

    if (stageRank(stage) >= stageRank(needed)) {
      return { allowed: true, capability, stage, reason: `permitted at ${stage}` };
    }

    return {
      allowed: false, capability, stage,
      needsStage: needed,
      reason: needed === 'full' && capability === 'email'
        ? `${spec.label} is at "${stage}" — drafting is allowed, sending is not. Advance to "full" to enable it.`
        : `${spec.label} is at "${stage}"; this needs "${needed}"`,
    };
  }

  /** Everything, for the CLI to show. */
  list() {
    this.load();
    return Object.entries(INTEGRATIONS)
      .sort((a, b) => a[1].order - b[1].order)
      .map(([capability, spec]) => {
        const rec = this._stages.get(capability);
        return {
          capability,
          label: spec.label,
          order: spec.order,
          stage: rec?.stage ?? DEFAULT_STAGE,
          changedAt: rec?.changedAt ?? null,
          by: rec?.by ?? null,
          jumped: rec?.jumped ?? false,
          servers: spec.servers,
        };
      });
  }

  _audit(entry) {
    if (typeof this._onAudit !== 'function') return;
    try { this._onAudit({ ...entry, ts: this._now(), kind: 'integration' }); } catch { /* never block a decision */ }
  }
}

/**
 * Check a configured MCP server's real tool names against tiers and stages,
 * BEFORE connecting it.
 *
 * The verb heuristics in `tiers.js` are guesses about naming conventions. A
 * server that calls its delete `purge_forever` is covered; one that calls it
 * `cleanup` is not. Finding that out by reading a list is much better than
 * finding out because something got cleaned up.
 *
 * @param {string[]} toolNames  prefixed names, e.g. 'gcal__create_event'
 * @param {object} registry     IntegrationRegistry
 * @returns {{tools: object[], warnings: string[]}}
 */
export function auditServerTools(toolNames, registry, { classify = classifyTier } = {}) {
  const classifyFn = classify;
  const tools = [];
  const warnings = [];

  for (const name of toolNames) {
    const tier = classifyFn(name, {});
    const stage = registry.check(name);
    tools.push({
      tool: name,
      tier: tier.tier,
      tierSource: tier.source,
      allowed: stage.allowed,
      stage: stage.stage,
      needsStage: stage.needsStage ?? null,
    });

    // The case worth flagging by hand: a tool the tier heuristics could not
    // place from its name. That is where a wrong guess is most likely.
    if (tier.source === 'mcp-default') {
      warnings.push(`"${name}" has an unrecognised verb — it defaulted to ${tier.tier}. Confirm what it does before enabling this capability.`);
    }
    if (tier.tier === 'T3' && stage.allowed) {
      warnings.push(`"${name}" is irreversible (T3) and reachable at the current stage. It will still be confirmed every time.`);
    }
  }

  return { tools, warnings };
}

let _registry = null;
export function getIntegrationRegistry(opts) {
  if (!_registry) _registry = new IntegrationRegistry(opts);
  return _registry;
}
export function resetIntegrationRegistry() { _registry = null; }
