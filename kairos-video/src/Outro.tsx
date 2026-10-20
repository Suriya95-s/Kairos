import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { theme } from './theme';

export const OUTRO_DURATION = 240;

const LINES: Array<[string, string]> = [
  ['kairos', 'open the cockpit'],
  ['kairos say "…"', 'talk to it'],
  ['kairos ontology verify <domain>', 'let a model check its knowledge'],
  ['kairos usage', 'see every token it ever spent'],
  ['kairos audit', 'see every action it ever took'],
];

export const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 24 });

  return (
    <AbsoluteFill
      style={{
        background: theme.bg,
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: theme.ui,
      }}
    >
      <div
        style={{
          fontFamily: theme.mono,
          fontSize: 72,
          fontWeight: 800,
          color: theme.cyan,
          transform: `scale(${0.92 + pop * 0.08})`,
        }}
      >
        ◆ KAIROS
      </div>
      <div style={{ fontSize: 32, color: theme.dim, marginTop: 18, opacity: pop }}>
        One word starts everything.
      </div>
      <div style={{ marginTop: 56, display: 'flex', flexDirection: 'column', gap: 20 }}>
        {LINES.map(([cmd, what], i) => {
          const at = 40 + i * 16;
          const op = interpolate(frame, [at, at + 12], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          });
          return (
            <div
              key={cmd}
              style={{
                display: 'flex',
                gap: 30,
                alignItems: 'baseline',
                opacity: op,
                transform: `translateY(${(1 - op) * 8}px)`,
              }}
            >
              <span
                style={{
                  fontFamily: theme.mono,
                  fontSize: 30,
                  color: theme.green,
                  width: 640,
                }}
              >
                ❯ {cmd}
              </span>
              <span style={{ fontSize: 26, color: theme.faint }}>{what}</span>
            </div>
          );
        })}
      </div>
      <div
        style={{
          marginTop: 64,
          fontSize: 24,
          color: theme.faint,
          opacity: interpolate(frame, [140, 160], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
        }}
      >
        Everything runs on your machine. Every credential encrypted. Every token metered. Every action reversible.
      </div>
    </AbsoluteFill>
  );
};
