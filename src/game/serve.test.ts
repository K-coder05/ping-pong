import { describe, expect, it } from 'vitest';
import { revsToRadPerSec } from '../physics/spin.ts';
import { launchBall, simulate, type BallEvent, type BallState, type Vec3 } from './ball.ts';
import { lookAhead } from './rally.ts';
import { judgeServe, OPPONENT_SERVE_FROM, SERVE_BOUNCE1_TOLERANCE_M, SERVE_NET_MARGIN_M, SERVE_TARGET_TOLERANCE_M, solveServe, type ServeIntent } from './serve.ts';
import { otherSide, type Side } from './side.ts';
import { solveShot, type TablePoint } from './solver.ts';

const BOTH: Side[] = ['opponent', 'player'];

/** Where `server` strikes a Serve: OPPONENT_SERVE_FROM, or its mirror image at the player's end. */
function serveFrom(server: Side): Vec3 {
  return server === 'opponent' ? { ...OPPONENT_SERVE_FROM } : { ...OPPONENT_SERVE_FROM, z: -OPPONENT_SERVE_FROM.z };
}

/** A point given for a Serve from the Opponent's end, mirrored across the net for the player's. */
function onSide(server: Side, p: TablePoint): TablePoint {
  return server === 'opponent' ? { ...p } : { x: p.x, z: -p.z };
}

/** A Serve intent given from the Opponent's end, for `server`'s end. */
function intentFor(server: Side, intent: ServeIntent): ServeIntent {
  return { ...intent, bounce1: onSide(server, intent.bounce1), target: onSide(server, intent.target) };
}

/** The first bounce aimed on the line from the Opponent's serve point to `target`, at `z`. */
function inLine(target: TablePoint, z: number): TablePoint {
  const f = (z - OPPONENT_SERVE_FROM.z) / (target.z - OPPONENT_SERVE_FROM.z);
  return { x: OPPONENT_SERVE_FROM.x + (target.x - OPPONENT_SERVE_FROM.x) * f, z };
}

function eventsOf(ball: BallState, seconds = 3): BallEvent[] {
  return simulate(ball, { maxTime: seconds }).events.map((e) => e.event);
}

const bounces = (events: readonly BallEvent[]) => events.filter((e): e is Extract<BallEvent, { type: 'bounce' }> => e.type === 'bounce');
const distance = (a: TablePoint, b: TablePoint) => Math.hypot(a.x - b.x, a.z - b.z);

/** Opponent-end intents: the middle, both deep corners, short, near the net, with Topspin, Backspin and none. */
const INTENTS: ServeIntent[] = [
  { bounce1: inLine({ x: 0, z: 0.9 }, -0.6), target: { x: 0, z: 0.9 }, flightTime: 0.2, topspin: 0, sidespin: 0 },
  { bounce1: inLine({ x: 0.6, z: 1.1 }, -0.8), target: { x: 0.6, z: 1.1 }, flightTime: 0.2, topspin: revsToRadPerSec(40), sidespin: 0 },
  { bounce1: inLine({ x: -0.6, z: 1.1 }, -0.7), target: { x: -0.6, z: 1.1 }, flightTime: 0.2, topspin: -revsToRadPerSec(25), sidespin: 0 },
  { bounce1: inLine({ x: 0.3, z: 0.6 }, -0.5), target: { x: 0.3, z: 0.6 }, flightTime: 0.3, topspin: -revsToRadPerSec(10), sidespin: 0 },
  { bounce1: inLine({ x: -0.2, z: 0.8 }, -0.35), target: { x: -0.2, z: 0.8 }, flightTime: 0.15, topspin: revsToRadPerSec(15), sidespin: 0 },
];

describe.each(BOTH)('solveServe from the %s end', (server) => {
  const receiver = otherSide(server);

  it.each(INTENTS.map((intent, i) => [i, intent] as const))('meets intent %i: first bounce within 5 cm on the server half, second within 10 cm on the receiver half, clear of the net', (_i, opponentIntent) => {
    const intent = intentFor(server, opponentIntent);
    const solution = solveServe(serveFrom(server), intent);
    expect(solution).not.toBeNull();
    const ball = launchBall(serveFrom(server), solution!.velocity, solution!.spin, 99);
    const events = eventsOf(ball);
    const [first, second] = bounces(events);
    expect(first!.half).toBe(server);
    expect(second!.half).toBe(receiver);
    expect(distance(first!.position, intent.bounce1)).toBeLessThanOrEqual(SERVE_BOUNCE1_TOLERANCE_M);
    expect(distance(second!.position, intent.target)).toBeLessThanOrEqual(SERVE_TARGET_TOLERANCE_M);
    expect(events.slice(0, events.indexOf(second!)).some((e) => e.type === 'cord' || e.type === 'net')).toBe(false);
    expect(judgeServe(ball, server)).toBe('legal');
    // The flight time it reports is the first segment's: launch to first bounce.
    expect(solution!.flightTime).toBeGreaterThan(0.05);
    expect(solution!.flightTime).toBeLessThan(1);
  });

  it('is null for an intent whose target is far off the line through the first bounce; best effort still gives a launch', () => {
    const intent = intentFor(server, { bounce1: { x: 0.5, z: -0.6 }, target: { x: -0.6, z: 1.1 }, flightTime: 0.2, topspin: 0, sidespin: 0 });
    expect(solveServe(serveFrom(server), intent)).toBeNull();
    expect(solveServe(serveFrom(server), intent, solveShot, { bestEffort: true })).not.toBeNull();
  });
});

describe('solveServe: solver failures', () => {
  it('is null when the first segment never solves, and best effort asks the solver for its best', () => {
    const asked: boolean[] = [];
    const never = ((_from: Vec3, _intent: unknown, opts?: { bestEffort?: boolean }) => {
      asked.push(!!opts?.bestEffort);
      return opts?.bestEffort ? { velocity: { x: 0, y: 0, z: 1 }, spin: { x: 0, y: 0, z: 0 }, flightTime: 0.2, passes: 1 } : null;
    }) as typeof solveShot;
    expect(solveServe(OPPONENT_SERVE_FROM, INTENTS[0]!, never)).toBeNull();
    expect(solveServe(OPPONENT_SERVE_FROM, INTENTS[0]!, never, { bestEffort: true })).toMatchObject({ flightTime: 0.2 });
    expect(asked).toEqual([false, false, true]);
  });

  it('keeps its net margin: asked for far more clearance than a Serve can have, it has no solution', () => {
    expect(solveServe(OPPONENT_SERVE_FROM, INTENTS[0]!, solveShot, { netMargin: SERVE_NET_MARGIN_M + 1 })).toBeNull();
  });
});

/**
 * A Serve by `server` with no Spin whose flight matches `wanted`, found by
 * scanning first bounces and first-segment flight times with `solveShot`
 * (the first segment only), and a few Net-cord seeds.
 */
function findServe(server: Side, wanted: (events: readonly BallEvent[]) => boolean): BallState {
  const from = serveFrom(server);
  for (const z of [-0.9, -0.75, -0.6, -0.45, -0.3, -0.2, -0.1]) {
    for (let flightTime = 0.06; flightTime <= 0.8; flightTime += 0.01) {
      const solution = solveShot(from, { target: onSide(server, { x: 0, z }), flightTime, topspin: 0, sidespin: 0 });
      if (!solution) continue;
      for (const seed of [1, 2, 3, 4, 5]) {
        const ball = launchBall(from, solution.velocity, solution.spin, seed);
        if (wanted(eventsOf(ball))) return ball;
      }
    }
  }
  throw new Error('no such Serve found');
}

/** The ball's events up to the first `bounce` on the receiver half, a `net`, or an `out`, as short strings. */
function outline(server: Side, events: readonly BallEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    out.push(e.type === 'bounce' ? (e.half === server ? 'own' : 'other') : e.type);
    if (e.type === 'net' || e.type === 'out' || (e.type === 'bounce' && e.half !== server) || out.length >= 3) break;
  }
  return out;
}

describe.each(BOTH)('judgeServe: a Serve from the %s end, real flights', (server) => {
  const starts = (prefix: string[]) => (events: readonly BallEvent[]) => {
    const seen = outline(server, events);
    return prefix.every((p, i) => seen[i] === p);
  };

  it('is legal: own half, then the other half, clear of the net', () => {
    const ball = findServe(server, (events) => outline(server, events).join() === 'own,other');
    expect(judgeServe(ball, server)).toBe('legal');
    expect(lookAhead(ball, otherSide(server), { serve: true })).not.toBeNull();
  });

  it('is a Fault whose first bounce is on the receiver half', () => {
    const solution = solveShot(serveFrom(server), { target: onSide(server, { x: 0, z: 0.8 }), flightTime: 0.7, topspin: 0, sidespin: 0 })!;
    const ball = launchBall(serveFrom(server), solution.velocity, solution.spin, 1);
    expect(outline(server, eventsOf(ball))[0]).toBe('other');
    expect(judgeServe(ball, server)).toBe('fault');
  });

  it('is a Fault into the net after its first bounce', () => {
    const ball = findServe(server, starts(['own', 'net']));
    expect(judgeServe(ball, server)).toBe('fault');
  });

  it('is a Fault that bounces twice on the server half', () => {
    const ball = findServe(server, starts(['own', 'own']));
    expect(judgeServe(ball, server)).toBe('fault');
  });

  it('is a Fault that leaves the table after its first bounce', () => {
    const ball = findServe(server, starts(['own', 'out']));
    expect(judgeServe(ball, server)).toBe('fault');
  });

  it('is a Fault that misses the table', () => {
    const ball = launchBall(serveFrom(server), { x: 2, y: 1, z: 0 });
    expect(outline(server, eventsOf(ball))[0]).toBe('out');
    expect(judgeServe(ball, server)).toBe('fault');
  });

  it('is a Let that clips the net and then lands on the receiver half', () => {
    const ball = findServe(server, (events) => outline(server, events).join() === 'own,cord,other');
    expect(judgeServe(ball, server)).toBe('let');
  });
});
