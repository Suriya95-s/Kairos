// src/client/token.js — read the live-view server's session token.
//
// The web-ui server (apps/web-ui/server.js) requires a bearer token on every
// /events and /api route and publishes it to <root>/.agent/web-ui-token (mode
// 0600). The TUI is a separate process, so it reads that file to authenticate.
// Read fresh each call: the server may start AFTER the TUI, so the file can
// appear later — and it is tiny, so the cost is negligible.

import fs from 'node:fs';
import path from 'node:path';

export function readWebUiToken(root) {
  if (!root) return '';
  try {
    return fs.readFileSync(path.join(root, '.agent', 'web-ui-token'), 'utf-8').trim();
  } catch {
    return '';
  }
}
