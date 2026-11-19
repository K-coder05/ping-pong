import { describe, expect, it } from 'vitest';
import { launchBall, simulate } from './ball.ts';
import { BALL_RADIUS, FEEDER_END_Z, NET_HEIGHT, TABLE_TOP_Y } from './constants.ts';
import { solveLaunch } from './solver.ts';

/** Where the ball first touches the table (or reaches table height off it), found with the real integrator. */
function firstLanding(from: { x: number; y: number; z: number }, velocity: { x: number; y: number; z: number }) {
  const run = simulate(launchBall(from, velocity), {
    maxTime: 5,
    until: (state, _time, events) => events.some((e) => e.type === 'bounce') || state.position.y <= TABLE_TOP_Y + BALL_RADIUS,
  });
  const bounce = run.events.find((e) => e.event.type === 'bounce');
  return { position: bounce ? bounce.event.position : run.state.position, time: run.time };
}

const FEEDER_MOUTH = { x: 0, y: TABLE_TOP_Y + 0.3, z: FEEDER_END_Z };

describe('target solver', () => {
  it('lands a Feed on its target despite drag', () => {
    const target = { x: 0.4, z: 0.8 };
    const { velocity } = solveLaunch(FEEDER_MOUTH, target, 1.0);

    const landing = firstLanding(FEEDER_MOUTH, velocity);
    expect(landing.position.x).toBeCloseTo(0.4, 2);
    expect(landing.position.z).toBeCloseTo(0.8, 2);
  });

  it('lands a hard Return from the player end on the far half (where drag matters most)', () => {
    const contact = { x: 0.3, y: TABLE_TOP_Y + 0.2, z: 1.5 };
    const { velocity } = solveLaunch(contact, { x: -0.5, z: -1.1 }, 0.55);

    const landing = firstLanding(contact, velocity);
    expect(landing.position.x).toBeCloseTo(-0.5, 2);
    expect(landing.position.z).toBeCloseTo(-1.1, 2);
  });

  it('raises the arc (longer flight time) when the asked-for shot would not clear the net by 5 cm', () => {
    // Low and fast: in 0.3 s from just above the table, the straight solution skims into the net.
    const low = { x: 0, y: TABLE_TOP_Y + 0.05, z: -1.2 };
    const solution = solveLaunch(low, { x: 0.2, z: 0.7 }, 0.3);

    expect(solution.flightTime).toBeGreaterThan(0.3);
    expect(netClearance(low, solution.velocity)).toBeGreaterThanOrEqual(0.05);
    const landing = firstLanding(low, solution.velocity);
    expect(landing.position.x).toBeCloseTo(0.2, 2);
    expect(landing.position.z).toBeCloseTo(0.7, 2);
  });

  it('keeps the asked-for flight time when the shot already clears the net', () => {
    const solution = solveLaunch(FEEDER_MOUTH, { x: 0, z: 0.6 }, 1.0);
    expect(solution.flightTime).toBe(1.0);
    expect(netClearance(FEEDER_MOUTH, solution.velocity)).toBeGreaterThanOrEqual(0.05);
  });
});

/** Height of the ball's bottom above the net top as its centre crosses z = 0. */
function netClearance(from: { x: number; y: number; z: number }, velocity: { x: number; y: number; z: number }): number {
  let previous = launchBall(from, velocity);
  let crossingY = NaN;
  simulate(previous, {
    maxTime: 5,
    until: (state) => {
      if (Math.sign(state.position.z) !== Math.sign(previous.position.z)) {
        const f = previous.position.z / (previous.position.z - state.position.z);
        crossingY = previous.position.y + f * (state.position.y - previous.position.y);
        return true;
      }
      previous = state;
      return false;
    },
  });
  return crossingY - BALL_RADIUS - (TABLE_TOP_Y + NET_HEIGHT);
}
