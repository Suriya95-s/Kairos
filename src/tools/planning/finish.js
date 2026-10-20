import { ok } from '../utils/toolResult.js';

export const definition = {
  type: 'function',
  function: {
    name: 'finish',
    description: 'Signal that the task is complete. Provide a summary of what was accomplished.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Summary of what was accomplished' },
      },
      required: ['summary'],
    },
  },
};

export function handler({ summary }) {
  // The __FINISH__ sentinel is detected downstream; renderForModel returns `data`
  // verbatim, so the marker is preserved.
  return ok(`__FINISH__:${summary}`);
}
