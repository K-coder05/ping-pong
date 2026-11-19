import { describe, expect, it } from 'vitest';
import type { PoseLandmark } from './landmarks.ts';
import { frameLogRow, type SensingFrame } from './sensingFrame.ts';

const landmarks: PoseLandmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }));
landmarks[16] = { x: 0.31, y: 0.62, z: -0.1, visibility: 0.97 };

const frame: SensingFrame = {
  t: 12345.5,
  timeSource: 'capture',
  hand: 'right',
  landmarks,
  wrist: { x: 0.3, y: 0.6 },
  hittingShoulder: { x: 0.4, y: 0.4 },
  otherShoulder: { x: 0.6, y: 0.41 },
  wristVisibility: 0.97,
  inferenceMs: 11.2,
  meanInferenceMs: 12,
  processedAt: 12395.25,
  cameraFps: 30,
  poseFps: 29.5,
};

describe('sensing frame log row', () => {
  it('logs time, raw and smoothed hitting wrist, shoulders, visibility, inference cost and capture-to-result time', () => {
    expect(frameLogRow(frame)).toEqual({
      t: 12345.5,
      hand: 'right',
      wristVisibility: 0.97,
      wristRawX: 0.31,
      wristRawY: 0.62,
      wristX: 0.3,
      wristY: 0.6,
      hittingShoulderX: 0.4,
      hittingShoulderY: 0.4,
      otherShoulderX: 0.6,
      otherShoulderY: 0.41,
      inferenceMs: 11.2,
      captureToResultMs: 49.75,
      cameraFps: 30,
      poseFps: 29.5,
    });
  });

  it('logs empty positions for a frame with no pose, so the row still has every column', () => {
    const row = frameLogRow({ ...frame, landmarks: null, wrist: null, hittingShoulder: null, otherShoulder: null, wristVisibility: 0 });
    expect(Object.keys(row)).toEqual(Object.keys(frameLogRow(frame)));
    expect(row.wristRawX).toBeNull();
    expect(row.wristX).toBeNull();
    expect(row.otherShoulderY).toBeNull();
    expect(row.wristVisibility).toBe(0);
  });

  it('logs the left wrist as raw wrist for a left-hander', () => {
    const left = landmarks.slice();
    left[15] = { x: 0.7, y: 0.5, z: 0, visibility: 0.8 };
    const row = frameLogRow({ ...frame, hand: 'left', landmarks: left });
    expect(row.wristRawX).toBe(0.7);
    expect(row.hand).toBe('left');
  });
});
