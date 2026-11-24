import { describe, expect, it } from 'vitest';
import { overlayLines, pathLabel } from './latencyOverlay.ts';

const stats = { oneWayP50: 12.34, oneWayP95: 30, lossPct: 0.5, rateHz: 59.6 };

describe('link overlay wording', () => {
  it('shows relay in the status and the path', () => {
    const lines = overlayLines('relay', stats, 1.5, 80);
    expect(lines[0]).toMatch(/Phone\s+Connected \(relay\)/);
    expect(lines[1]).toMatch(/Path\s+relay through the server \(max 90 Hz\)/);
  });

  it('shows peer to peer when connected directly, and no path otherwise', () => {
    expect(pathLabel('connected')).toBe('peer to peer');
    expect(pathLabel('connecting')).toBe('–');
    expect(pathLabel('disconnected')).toBe('–');
  });
});
