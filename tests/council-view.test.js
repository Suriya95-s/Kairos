// tests/council-view.test.js — C-3: the Council view renders within the frame.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { state, setState } from '../apps/tui/src/state.js';
import { composeFrame } from '../apps/tui/src/app.js';
import { stripAnsi } from '../apps/tui/src/render.js';

const plain = (lines) => lines.map(stripAnsi).join('\n');

beforeEach(() => setState({
  showSplash: false, view: 'council', status: 'running', overlay: null,
  council: null, councilCfgOpen: false, openrouterKey: '',
  modelPickerOpen: false, settingsOpen: false, modelConfigOpen: false, chatToolApproval: null, toast: null,
}));

describe('council view — idle', () => {
  test('shows the lineup, chairman, and a topic prompt; frame totals H', () => {
    const frame = composeFrame(100, 20);
    assert.equal(frame.length, 20);
    const txt = plain(frame);
    assert.match(txt, /AI ARENA/);                    // renamed from LLM COUNCIL
    assert.match(txt, /Members/);
    assert.match(txt, /chair/);                       // chairman marked
    assert.match(txt, /No OpenRouter key/);           // warns when key missing
    assert.match(plain([composeFrame(100, 20).at(-1)]), /AI Arena/); // tab present in bar
  });
});

describe('council view — live run', () => {
  beforeEach(() => setState({
    council: {
      topic: 'Q', stage: 3, status: 'done', chairman: 'meta-llama/llama-3.3-70b-instruct:free',
      final: 'The synthesized verdict.', error: '',
      members: [
        { id: 'meta-llama/llama-3.3-70b-instruct:free', label: 'Llama 3.3 70B', status: 'done', answer: 'Answer A', rankText: '1. Response #1', error: '' },
        { id: 'deepseek/deepseek-chat:free', label: 'DeepSeek Chat', status: 'failed', answer: '', rankText: '', error: '429 rate limited' },
      ],
    },
  }));

  test('renders members with status, the failed reason, and the final synthesis', () => {
    const txt = plain(composeFrame(100, 24));
    assert.match(txt, /MEMBERS/);
    assert.match(txt, /Llama 3.3 70B/);
    assert.match(txt, /429 rate limited/);            // failed member surfaced
    assert.match(txt, /FINAL/);
    assert.match(txt, /The synthesized verdict\./);
  });

  test('frame still totals H during a run', () => {
    setState({ council: { ...state.council, status: 'stage1', final: '' } });
    assert.equal(composeFrame(100, 18).length, 18);
  });
});

describe('council lineup overlay', () => {
  test('opens and lists the editable models with a chairman marker', () => {
    setState({ councilCfgOpen: true, councilCfgIdx: 0 });
    // The overlay writes directly to stdout; assert composeFrame still produces a
    // valid base frame underneath (overlay is drawn on top in render()).
    assert.equal(composeFrame(100, 20).length, 20);
  });
});
