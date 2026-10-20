import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { theme } from './theme';

export const TITLE_DURATION = 150;

export const Title: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 30 });
  const sub = interpolate(frame, [35, 60], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const spacing = interpolate(frame, [0, 60], [30, 14], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const fade = interpolate(frame, [TITLE_DURATION - 18, TITLE_DURATION], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill
      style={{
        background: theme.bg,
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: theme.mono,
        opacity: fade,
      }}
    >
      <div
        style={{
          fontSize: 150,
          fontWeight: 800,
          color: theme.cyan,
          letterSpacing: spacing,
          transform: `scale(${0.9 + pop * 0.1})`,
          textShadow: `0 0 60px ${theme.cyan}44`,
        }}
      >
        ◆ KAIROS
      </div>
      <div
        style={{
          fontFamily: theme.ui,
          fontSize: 38,
          color: theme.dim,
          marginTop: 30,
          opacity: sub,
        }}
      >
        Your self-hosted autonomous agent — the complete tour
      </div>
      <div
        style={{
          fontSize: 26,
          color: theme.faint,
          marginTop: 60,
          opacity: sub,
        }}
      >
        zero dependencies · one daemon · everything audited
      </div>
    </AbsoluteFill>
  );
};
