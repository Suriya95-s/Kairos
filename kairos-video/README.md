# kairos-video

The Kairos feature-tour video, built with [Remotion](https://remotion.dev).
This folder is deliberately separate from the Kairos tree — Kairos itself stays
zero-dependency; only the video needs npm packages.

## Commands

```
npm install            # once
npm run studio         # live-preview / edit the video in a browser
npm run render         # render out/kairos-tour.mp4
```

## Editing the tour

- `src/scenes.ts` — the entire script. Each scene is data: a kicker, a title,
  the chatbot's narration bubbles, and the terminal demo lines
  (`cmd` lines are typed live; `out`/`ok`/`warn`/`dim` are output styles).
  Add, remove, or reword scenes here — all timing is computed from content
  length automatically (`src/core.ts`).
- `src/Scene.tsx` — the layout: chat panel left, terminal right.
- `src/Title.tsx` / `src/Outro.tsx` — the bookends.
- `src/theme.ts` — colors and fonts.

Every claim in the script was checked against the code (kernel CLI, TUI,
ontology engine, trust/vault/usage modules). Known trap: `missions --watch`
appears in the CLI help but is not implemented — it is deliberately not shown.
