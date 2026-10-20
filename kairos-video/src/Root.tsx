import React from 'react';
import { AbsoluteFill, Composition, Sequence, useCurrentFrame, useVideoConfig } from 'remotion';
import { FPS, sceneDuration } from './core';
import { SCENES } from './scenes';
import { Scene } from './Scene';
import { Title, TITLE_DURATION } from './Title';
import { Outro, OUTRO_DURATION } from './Outro';
import { theme } from './theme';

const offsets: number[] = [];
let cursor = TITLE_DURATION;
for (const s of SCENES) {
  offsets.push(cursor);
  cursor += sceneDuration(s);
}
const TOTAL = cursor + OUTRO_DURATION;

const Progress: React.FC = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        bottom: 0,
        height: 6,
        width: `${(frame / durationInFrames) * 100}%`,
        background: theme.cyan,
        opacity: 0.7,
      }}
    />
  );
};

const Tour: React.FC = () => (
  <AbsoluteFill style={{ background: theme.bg }}>
    <Sequence durationInFrames={TITLE_DURATION}>
      <Title />
    </Sequence>
    {SCENES.map((s, i) => (
      <Sequence key={s.id} from={offsets[i]} durationInFrames={sceneDuration(s)}>
        <Scene data={s} index={i} total={SCENES.length} />
      </Sequence>
    ))}
    <Sequence from={cursor} durationInFrames={OUTRO_DURATION}>
      <Outro />
    </Sequence>
    <Progress />
  </AbsoluteFill>
);

export const Root: React.FC = () => (
  <Composition
    id="KairosTour"
    component={Tour}
    durationInFrames={TOTAL}
    fps={FPS}
    width={1920}
    height={1080}
  />
);
