// src/ontology/bridge.js
// G3 — the loop memory bridge: what Kairos DID becomes what Kairos KNOWS.
//
// Every ended mission is PROPOSED into the 'kairos' meta-domain as governed
// graph facts: a MissionOutcome instance (plus a Learning instance and edge
// per recorded lesson), all born candidates by 'kairos-loop', all
// evidence-backed by a content-addressed snapshot of the outcome record
// itself. Humans dispose, exactly like every other candidate — the loop can
// no more write approved facts about itself than the verifier can.
//
// Idempotent end to end: the snapshot is content-addressed and appendDocument
// deep-equal-replays, so the bus delivering an 'ended' event twice cannot
// double the graph.

import { registerSnapshot, appendDocument } from './store.js';

export const LOOP_DOMAIN = 'kairos';

const TYPE_DEFS = [
  {
    id: 'type:MissionOutcome',
    payload: {
      name: 'MissionOutcome',
      properties: [
        { name: 'task', type: 'string' }, { name: 'state', type: 'string' },
        { name: 'workspace', type: 'string' }, { name: 'profile', type: 'string' },
        { name: 'exitReason', type: 'string' }, { name: 'endedAt', type: 'date' },
      ],
      keyProperty: null,
    },
  },
  {
    id: 'type:Learning',
    payload: {
      name: 'Learning',
      properties: [{ name: 'lesson', type: 'string' }, { name: 'missionId', type: 'string' }],
      keyProperty: null,
    },
  },
];

/**
 * Propose one ended mission into the kairos meta-domain. Never throws — graph
 * memory is strictly additive and must not fail a mission's own lifecycle.
 * Returns { appended, instanceId } or { appended: 0, error } on trouble.
 */
export function proposeMissionOutcome(mission, { domain = LOOP_DOMAIN } = {}) {
  try {
    if (!mission?.id) return { appended: 0, error: 'no mission id' };
    const record = {
      missionId: mission.id,
      task: String(mission.task || '').slice(0, 500),
      state: mission.state || 'unknown',
      workspace: mission.workspace || '',
      profile: mission.profile || '',
      exitReason: mission.exitReason || '',
      error: mission.error ? String(mission.error).slice(0, 300) : '',
      endedAt: mission.endedAt || null,
      learnings: (mission.learnings || []).map((l) => String(l).slice(0, 300)),
    };
    const snapshot = registerSnapshot(domain, {
      sourceName: `mission-${mission.id}.json`,
      content: JSON.stringify(record, null, 2),
      mediaType: 'application/json',
    });
    const evidence = [{ snapshot: snapshot.id, locator: 'document' }];

    let appended = 0;
    const put = (kind, id, payload) => {
      const res = appendDocument(domain, { kind, id, payload });
      if (res.appended) appended++;
      return res;
    };

    for (const t of TYPE_DEFS) {
      put('object_type', t.id, {
        ...t.payload, state: 'candidate', proposedBy: 'kairos-loop', evidence,
      });
    }

    const instanceId = `inst:MissionOutcome:${mission.id}`;
    put('instance', instanceId, {
      type: 'MissionOutcome', key: mission.id,
      properties: {
        task: record.task, state: record.state, workspace: record.workspace,
        profile: record.profile, exitReason: record.exitReason,
        endedAt: record.endedAt ? new Date(record.endedAt).toISOString() : '',
        ...(record.error ? { error: record.error } : {}),
      },
      state: 'candidate', proposedBy: 'kairos-loop', evidence,
    });

    record.learnings.forEach((lesson, i) => {
      const lid = `inst:Learning:${mission.id}-${i + 1}`;
      put('instance', lid, {
        type: 'Learning', key: `${mission.id}-${i + 1}`,
        properties: { lesson, missionId: mission.id },
        state: 'candidate', proposedBy: 'kairos-loop', evidence,
      });
      put('relationship', `rel:taught:${mission.id}:${i + 1}`, {
        name: 'taught', kind: 'reference_instance',
        from: instanceId, to: lid,
        fromType: 'MissionOutcome', toType: 'Learning',
        state: 'candidate', proposedBy: 'kairos-loop', evidence,
      });
    });

    return { appended, instanceId, snapshot: snapshot.id };
  } catch (err) {
    return { appended: 0, error: err.message };
  }
}

export default { LOOP_DOMAIN, proposeMissionOutcome };
