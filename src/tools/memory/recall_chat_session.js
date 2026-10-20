// src/tools/memory/recall_chat_session.js
// Kairos tool: retrieve stored chat session history.

import {
  readSession,
  summarizeSession,
  searchTurns,
  recentTurns,
  listSessions,
} from '../../chat/session.js';
import { ok, fail } from '../utils/toolResult.js';

export const definition = {
  type: 'function',
  function: {
    name: 'recall_chat_session',
    description: 'Retrieve stored chat session history. Supports lookup by session ID, recent turns, and keyword search within sessions.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID to retrieve. Omit to list recent sessions.',
        },
        mode: {
          type: 'string',
          enum: ['summary', 'turns', 'search', 'recent', 'list'],
          description: 'summary=one-liner per session; turns=full turns for sessionId; search=keyword search; recent=last N turns across sessions; list=all sessions.',
          default: 'summary',
        },
        query: {
          type: 'string',
          description: 'Search keyword (used when mode=search)',
        },
        limit: {
          type: 'integer',
          description: 'Max results to return (default: 10)',
          default: 10,
        },
      },
      required: [],
    },
  },
};

export function handler({ sessionId, mode = 'summary', query = '', limit = 10 } = {}) {
  switch (mode) {
    case 'list': {
      const sessions = listSessions().slice(0, limit);
      if (sessions.length === 0) return ok('No chat sessions recorded yet.');
      return ok(sessions.map(s =>
        `${s.sessionId}  turns=${s.turnCount}  last=${s.lastTs?.slice(0, 16) ?? '?'}  mode=${s.mode ?? 'chat'}`
      ).join('\n'));
    }

    case 'summary': {
      if (sessionId) return ok(String(summarizeSession(sessionId)));
      const sessions = listSessions().slice(0, limit);
      if (sessions.length === 0) return ok('No chat sessions recorded yet.');
      return ok(sessions.map(s => summarizeSession(s.sessionId)).join('\n\n'));
    }

    case 'turns': {
      if (!sessionId) return fail('Error: sessionId is required for mode=turns.');
      const turns = readSession(sessionId);
      if (turns.length === 0) return ok(`No turns found for session "${sessionId}".`);
      return ok(turns.slice(-limit).map(t =>
        `[${t.ts?.slice(0, 16) ?? '?'}] ${t.role}: ${t.content?.slice(0, 300)}`
      ).join('\n\n'));
    }

    case 'search': {
      if (!query) return fail('Error: query is required for mode=search.');
      const results = searchTurns(query, limit);
      if (results.length === 0) return ok(`No turns found matching "${query}".`);
      return ok(results.map(t =>
        `[${t.sessionId}] [${t.ts?.slice(0, 16) ?? '?'}] ${t.role}: ${t.content?.slice(0, 200)}`
      ).join('\n\n'));
    }

    case 'recent': {
      const turns = recentTurns(limit);
      if (turns.length === 0) return ok('No chat turns recorded yet.');
      return ok(turns.map(t =>
        `[${t.sessionId}] [${t.ts?.slice(0, 16) ?? '?'}] ${t.role}: ${t.content?.slice(0, 200)}`
      ).join('\n\n'));
    }

    default:
      return fail(`Unknown mode "${mode}". Use: list, summary, turns, search, recent.`);
  }
}
