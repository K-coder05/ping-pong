import { describe, expect, it } from 'vitest';
import { FEEDER_MOUTH, PHYSICS_DT, TABLE_TOP_Y } from '../game/constants.ts';
import { revsToRadPerSec } from '../physics/spin.ts';
import { analyseShot, pathDuration, positionAt } from './shotAnalysis.ts';

const FROM = { x: 0, y: TABLE_TOP_Y + 0.3, z: 1.37 };
const intent = (revs: number) => ({ target: { x: 0, z: -0.9 }, flightTime: 0.8, topspin: revsToRadPerSec(revs), sidespin: 0 });

describe('analyseShot', () => {
  it('lands a no-spin Shot on its target with the readouts filled in', () => {
    const shot = analyseShot(FROM, intent(0))!;
    expect(shot).not.toBeNull();
    const r = shot.readouts;
    expect(r.landingError).toBeLessThan(0.02);
    expect(r.netClearance).toBeGreaterThanOrEqual(0.05 - 1e-6);
    expect(r.apexHeight).toBeGreaterThanOrEqual(0.3 - 1e-9);
    expect(r.speedAfterBounce).toBeGreaterThan(0);
    expect(r.passes).toBeGreaterThan(0);
    expect(shot.markers.some((m) => m.kind === 'bounce')).toBe(true);
  });

  it('lands Backspin and Topspin on the same target, with Topspin leaving the table faster', () => {
    const back = analyseShot(FROM, intent(-40))!;
    const top = analyseShot(FROM, intent(40))!;
    expect(back.readouts.landingError).toBeLessThan(0.02);
    expect(top.readouts.landingError).toBeLessThan(0.02);
    expect(top.readouts.speedAfterBounce!).toBeGreaterThan(back.readouts.speedAfterBounce!);
  });

  it('flies from the Feeder mouth to the player\'s half too', () => {
    const shot = analyseShot(FEEDER_MOUTH, { target: { x: 0, z: 0.9 }, flightTime: 0.8, topspin: 0, sidespin: 0 })!;
    expect(shot.readouts.landingError).toBeLessThan(0.02);
  });

  it('reports no solution as null', () => {
    expect(analyseShot(FROM, { target: { x: 0, z: -0.9 }, flightTime: 0.05, topspin: 0, sidespin: 0 })).toBeNull();
  });

  it('samples the path by time and holds the last point', () => {
    const shot = analyseShot(FROM, intent(0))!;
    expect(positionAt(shot.path, 0)).toEqual(FROM);
    expect(positionAt(shot.path, 100)).toBe(shot.path[shot.path.length - 1]);
    expect(pathDuration(shot.path)).toBeCloseTo((shot.path.length - 1) * PHYSICS_DT);
  });
});
