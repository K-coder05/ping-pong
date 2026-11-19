import { describe, expect, it } from 'vitest';
import { createFrameStats } from './frameStats.ts';

describe('frame stats', () => {
  it('reports no rates before it has two frames', () => {
    const stats = createFrameStats();
    expect(stats.cameraFps).toBeNull();
    stats.record({ t: 1000, inferenceMs: 10 });
    expect(stats.cameraFps).toBeNull();
    expect(stats.poseFps).toBeNull();
  });

  it('measures the real frame rate from frame timestamps', () => {
    const stats = createFrameStats();
    for (let i = 0; i < 20; i++) stats.record({ t: 5000 + i * 33.4, inferenceMs: 10 });
    expect(stats.cameraFps).toBeCloseTo(29.94, 1);
    expect(stats.poseFps).toBeCloseTo(29.94, 1);
  });

  it('averages inference time over the most recent frames only', () => {
    const stats = createFrameStats(4);
    expect(stats.inferenceMs).toBeNull();
    [100, 100, 8, 10, 12, 14].forEach((ms, i) => stats.record({ t: i * 16, inferenceMs: ms }));
    expect(stats.inferenceMs).toBe(11);
  });

  it('counts camera frames that pose inference skipped, using the presented-frame counter', () => {
    const stats = createFrameStats();
    // A 60 FPS camera where inference only keeps up with every other frame.
    for (let i = 0; i < 20; i++) stats.record({ t: i * 33.4, inferenceMs: 30, presentedFrames: 100 + i * 2 });
    expect(stats.cameraFps).toBeCloseTo(59.88, 1);
    expect(stats.poseFps).toBeCloseTo(29.94, 1);
  });
});
