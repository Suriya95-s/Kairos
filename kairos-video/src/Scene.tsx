import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { SceneData, TermLine, bubbleSpans, termSpans } from './core';
import { theme } from './theme';

const clampChars = (s: string, start: number, cpf: number, frame: number) => {
  if (frame < start) return '';
  return s.slice(0, Math.min(s.length, Math.floor((frame - start) * cpf)));
};

const Cursor: React.FC<{ on: boolean; color: string }> = ({ on, color }) => {
  const frame = useCurrentFrame();
  if (!on) return null;
  const visible = frame % 24 < 14;
  return (
    <span
      style={{
        display: 'inline-block',
        width: '0.55em',
        height: '1.1em',
        marginLeft: 2,
        verticalAlign: 'text-bottom',
        background: visible ? color : 'transparent',
      }}
    />
  );
};

const OUT_COLORS: Record<TermLine['t'], string> = {
  cmd: theme.text,
  out: '#9aa7bd',
  ok: theme.green,
  warn: theme.amber,
  dim: theme.faint,
};

export const Scene: React.FC<{ data: SceneData; index: number; total: number }> = ({
  data,
  index,
  total,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 18 });

  const bSpans = bubbleSpans(data.bubbles);
  const tSpans = termSpans(data.term);

  return (
    <AbsoluteFill style={{ background: theme.bg, fontFamily: theme.ui, color: theme.text }}>
      {/* top bar */}
      <div
        style={{
          height: 96,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 56px',
          borderBottom: `1px solid ${theme.border}`,
          opacity: enter,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 18 }}>
          <span style={{ fontFamily: theme.mono, fontSize: 34, color: theme.cyan, fontWeight: 700 }}>
            ◆ KAIROS
          </span>
          <span style={{ fontSize: 22, color: theme.faint, letterSpacing: 4, textTransform: 'uppercase' }}>
            {data.kicker}
          </span>
        </div>
        <div style={{ fontFamily: theme.mono, fontSize: 24, color: theme.dim }}>
          {String(index + 1).padStart(2, '0')} / {String(total).padStart(2, '0')}
        </div>
      </div>

      {/* headline */}
      <div
        style={{
          padding: '30px 56px 6px',
          fontSize: 52,
          fontWeight: 700,
          letterSpacing: -0.5,
          opacity: enter,
          transform: `translateY(${(1 - enter) * 20}px)`,
        }}
      >
        {data.title}
      </div>

      {/* body */}
      <div style={{ flex: 1, display: 'flex', gap: 36, padding: '26px 56px 56px' }}>
        {/* chat panel */}
        <div
          style={{
            width: '42%',
            background: theme.panel,
            border: `1px solid ${theme.border}`,
            borderRadius: 20,
            padding: 30,
            display: 'flex',
            flexDirection: 'column',
            gap: 20,
            opacity: enter,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
            <span
              style={{
                width: 14,
                height: 14,
                borderRadius: 7,
                background: theme.green,
                boxShadow: `0 0 12px ${theme.green}`,
              }}
            />
            <span style={{ fontSize: 24, color: theme.dim }}>Kairos — your agent</span>
          </div>
          {data.bubbles.map((b, i) => {
            const span = bSpans[i];
            if (frame < span.start - 4) return null;
            const typed = clampChars(b, span.start, 2.6, frame);
            const typing = typed.length < b.length;
            const pop = interpolate(frame, [span.start - 4, span.start + 4], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            });
            return (
              <div
                key={i}
                style={{
                  background: theme.bubble,
                  borderLeft: `4px solid ${theme.cyan}`,
                  borderRadius: '4px 16px 16px 16px',
                  padding: '18px 22px',
                  fontSize: 29,
                  lineHeight: 1.5,
                  opacity: pop,
                  transform: `translateY(${(1 - pop) * 10}px)`,
                }}
              >
                {typed}
                <Cursor on={typing} color={theme.cyan} />
              </div>
            );
          })}
        </div>

        {/* terminal panel */}
        <div
          style={{
            flex: 1,
            background: theme.panelDeep,
            border: `1px solid ${theme.border}`,
            borderRadius: 20,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            opacity: enter,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '16px 22px',
              borderBottom: `1px solid ${theme.border}`,
            }}
          >
            {[theme.red, theme.amber, theme.green].map((c) => (
              <span key={c} style={{ width: 14, height: 14, borderRadius: 7, background: c, opacity: 0.8 }} />
            ))}
            <span style={{ fontFamily: theme.mono, fontSize: 20, color: theme.faint, marginLeft: 10 }}>
              kairos — terminal
            </span>
          </div>
          <div
            style={{
              padding: '24px 28px',
              fontFamily: theme.mono,
              fontSize: 25,
              lineHeight: 1.62,
              whiteSpace: 'pre-wrap',
              overflow: 'hidden',
            }}
          >
            {data.term.map((line, i) => {
              const span = tSpans[i];
              if (frame < span.start) return null;
              if (line.t === 'cmd') {
                const typed = clampChars(line.s, span.start, 1.7, frame);
                const typing = typed.length < line.s.length;
                return (
                  <div key={i}>
                    <span style={{ color: theme.green }}>❯ </span>
                    <span style={{ color: theme.text }}>{typed}</span>
                    <Cursor on={typing} color={theme.green} />
                  </div>
                );
              }
              const op = interpolate(frame, [span.start, span.start + 4], [0, 1], {
                extrapolateLeft: 'clamp',
                extrapolateRight: 'clamp',
              });
              return (
                <div key={i} style={{ color: OUT_COLORS[line.t], opacity: op }}>
                  {line.s}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
