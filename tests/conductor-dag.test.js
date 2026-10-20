// tests/conductor-dag.test.js — Wave D-3: typed dependency DAG → execution waves.
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { buildDag, topoWaves } from '../src/agents/dag.js';

const A = (role, dependsOn = []) => ({ role, dependsOn });

describe('buildDag', () => {
  test('records nodes and valid deps', () => {
    const { nodes, deps, droppedDeps } = buildDag([A('scout'), A('planner', ['scout'])]);
    assert.equal(nodes.size, 2);
    assert.deepEqual(deps.get('planner'), ['scout']);
    assert.deepEqual(deps.get('scout'), []);
    assert.equal(droppedDeps.length, 0);
  });

  test('drops dependencies on unknown roles (typo guard)', () => {
    const { deps, droppedDeps } = buildDag([A('coder', ['ghost'])]);
    assert.deepEqual(deps.get('coder'), []);
    assert.deepEqual(droppedDeps, ['coder->ghost']);
  });
});

describe('topoWaves', () => {
  test('linear pipeline → one role per wave', () => {
    const { waves, hasCycle } = topoWaves([
      A('scout'), A('planner', ['scout']), A('coder', ['planner']),
    ]);
    assert.equal(hasCycle, false);
    assert.deepEqual(waves.map(w => w.map(a => a.role)), [['scout'], ['planner'], ['coder']]);
  });

  test('independent roles share a wave (parallelism opportunity)', () => {
    const { waves } = topoWaves([
      A('scout'), A('research'), A('planner', ['scout', 'research']),
    ]);
    // scout + research have no deps → same first wave.
    assert.deepEqual(waves[0].map(a => a.role).sort(), ['research', 'scout']);
    assert.deepEqual(waves[1].map(a => a.role), ['planner']);
  });

  test('diamond: a→{b,c}→d gives 3 waves with b,c parallel', () => {
    const { waves } = topoWaves([
      A('a'), A('b', ['a']), A('c', ['a']), A('d', ['b', 'c']),
    ]);
    assert.deepEqual(waves[0].map(a => a.role), ['a']);
    assert.deepEqual(waves[1].map(a => a.role).sort(), ['b', 'c']);
    assert.deepEqual(waves[2].map(a => a.role), ['d']);
  });

  test('preserves input order within a wave (deterministic dispatch)', () => {
    const { waves } = topoWaves([A('z'), A('y'), A('x')]);
    assert.deepEqual(waves[0].map(a => a.role), ['z', 'y', 'x']);
  });

  test('cycle is detected and flagged for sequential fallback', () => {
    const { hasCycle, cycleRoles } = topoWaves([
      A('a', ['b']), A('b', ['a']),
    ]);
    assert.equal(hasCycle, true);
    assert.deepEqual(cycleRoles.sort(), ['a', 'b']);
  });

  test('self-dependency is a cycle', () => {
    const { hasCycle } = topoWaves([A('loop', ['loop'])]);
    assert.equal(hasCycle, true);
  });
});
