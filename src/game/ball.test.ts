import { describe, expect, it } from 'vitest';
import { launchBall, simulate, stepBall } from './ball.ts';
import { BALL_RADIUS, PHYSICS_DT, TABLE_TOP_Y, TABLE_WIDTH } from './constants.ts';

/** Height of the ball's bottom above the table top. */
const heightAboveTable = (y: number) => y - BALL_RADIUS - TABLE_TOP_Y;

describe('ball physics', () => {
  it('a ball dropped from 30 cm above the table bounces to about 23 cm', () => {
    const ball = launchBall({ x: 0, y: TABLE_TOP_Y + BALL_RADIUS + 0.3, z: 0.7 }, { x: 0, y: 0, z: 0 });

    let apex = -Infinity;
    let bounced = false;
    simulate(ball, {
      maxTime: 2,
      until: (state, _time, events) => {
        if (events.some((e) => e.type === 'bounce')) bounced = true;
        if (bounced) apex = Math.max(apex, heightAboveTable(state.position.y));
        return bounced && state.velocity.y < 0; // past the apex of the first rebound
      },
    });

    expect(bounced).toBe(true);
    expect(apex).toBeGreaterThan(0.21);
    expect(apex).toBeLessThan(0.24);
  });

  it('a ball thrown into the net is marked dead and stops counting', () => {
    // From above the player's half, low and fast toward the Feeder: it reaches z = 0 below net height.
    const ball = launchBall({ x: 0.2, y: TABLE_TOP_Y + 0.08, z: 0.6 }, { x: 0, y: 0.4, z: -6 });
    expect(ball.status).toBe('live');

    const run = simulate(ball, { maxTime: 3 });
    const types = run.events.map((e) => e.event.type);

    expect(types).toContain('net');
    expect(run.state.status).toBe('dead');
    // Once dead, nothing after the net hit can mark it out (it falls, bounces, rolls off).
    expect(types).not.toContain('out');
    // It never got past the net onto the Feeder's half.
    expect(run.events.filter((e) => e.event.type === 'bounce' && e.event.half === 'feeder')).toEqual([]);
  });

  it('a ball leaving the table edges is marked out once it drops below the table top', () => {
    // Thrown sideways from above the player's half, it sails past the side line without touching the table.
    const ball = launchBall({ x: 0, y: TABLE_TOP_Y + 0.3, z: 0.6 }, { x: 5, y: 1, z: 0 });

    let outAt: { y: number; x: number } | null = null;
    const run = simulate(ball, {
      maxTime: 2,
      until: (state, _time, events) => {
        const out = events.find((e) => e.type === 'out');
        if (out) outAt = { x: state.position.x, y: state.position.y };
        return out !== undefined;
      },
    });

    expect(run.state.status).toBe('out');
    expect(run.events.map((e) => e.event)).toEqual([expect.objectContaining({ type: 'out', reason: 'off-table' })]);
    expect(outAt!.x).toBeGreaterThan(TABLE_WIDTH / 2);
    expect(outAt!.y).toBeLessThan(TABLE_TOP_Y);
  });

  it('a ball bouncing twice on one half is marked out on the second bounce', () => {
    const ball = launchBall({ x: 0, y: TABLE_TOP_Y + 0.3, z: 0.7 }, { x: 0, y: 0, z: 0 });

    const run = simulate(ball, { maxTime: 3 });
    const [first, second, third] = run.events.map((e) => e.event);

    expect(first).toMatchObject({ type: 'bounce', half: 'player' });
    expect(second).toMatchObject({ type: 'bounce', half: 'player' });
    expect(third).toMatchObject({ type: 'out', reason: 'double-bounce' });
    expect(run.state.status).toBe('out');
    expect(run.events.filter((e) => e.event.type === 'out')).toHaveLength(1);
  });

  it('a bounce on each half is not out', () => {
    // Lands on the Feeder's half, carries over the net, then lands on the player's half.
    const ball = launchBall({ x: 0, y: TABLE_TOP_Y + 0.25, z: -1.0 }, { x: 0, y: 0, z: 2.6 });

    const run = simulate(ball, {
      maxTime: 2,
      until: (_state, _time, events) => events.some((e) => e.type === 'bounce' && e.half === 'player'),
    });

    expect(run.events.map((e) => e.event)).toEqual([
      expect.objectContaining({ type: 'bounce', half: 'feeder' }),
      expect.objectContaining({ type: 'bounce', half: 'player' }),
    ]);
    expect(run.state.status).toBe('live');
  });

  it('a ball resting on the table stays on it without bouncing', () => {
    const ball = launchBall({ x: 0, y: TABLE_TOP_Y + BALL_RADIUS, z: 0.7 }, { x: 0, y: 0, z: 0 });

    const run = simulate(ball, { maxTime: 1 });

    expect(run.events).toEqual([]);
    expect(run.state.status).toBe('live');
    expect(run.state.position.y).toBeCloseTo(TABLE_TOP_Y + BALL_RADIUS, 6);
  });

  it('a dropped ball settles on the table after its bounces die away', () => {
    const ball = launchBall({ x: 0, y: TABLE_TOP_Y + BALL_RADIUS + 0.3, z: 0.7 }, { x: 0, y: 0, z: 0 });

    const run = simulate(ball, { maxTime: 6 });
    const bounces = run.events.filter((e) => e.event.type === 'bounce');

    expect(bounces.length).toBeLessThan(40);
    expect(bounces.at(-1)!.time).toBeLessThan(5);
    expect(run.state.position.y).toBeCloseTo(TABLE_TOP_Y + BALL_RADIUS, 6);
  });

  it('a ball that leaves the table comes to rest on the floor, silently', () => {
    const ball = launchBall({ x: 0, y: TABLE_TOP_Y + 0.3, z: 0.6 }, { x: 5, y: 1, z: 0 });

    const run = simulate(ball, { maxTime: 8 });

    expect(run.state.position.y).toBeCloseTo(BALL_RADIUS, 6);
    expect(run.events.map((e) => e.event.type)).toEqual(['out']);
  });

  it('air drag slows a 10 m/s ball by about 1.4 g', () => {
    const ball = launchBall({ x: 0, y: 2, z: 0.5 }, { x: 0, y: 0, z: -10 });

    const { state } = stepBall(ball);
    const deceleration = (state.velocity.z - ball.velocity.z) / PHYSICS_DT;

    expect(deceleration / 9.81).toBeCloseTo(1.4, 1);
  });

  describe('simulating ahead without rendering', () => {
    const drop = () => launchBall({ x: 0, y: TABLE_TOP_Y + BALL_RADIUS + 0.3, z: 0.7 }, { x: 0, y: 0, z: 0 });

    it('stamps each event with its simulated time', () => {
      const run = simulate(drop(), { maxTime: 1, until: (_s, _t, events) => events.length > 0 });

      // Free fall from 30 cm takes √(2·0.3/9.81) ≈ 0.247 s; drag adds a little.
      expect(run.events).toHaveLength(1);
      expect(run.events[0]!.time).toBeGreaterThan(0.245);
      expect(run.events[0]!.time).toBeLessThan(0.256);
      expect(run.time).toBe(run.events[0]!.time);
    });

    it('stops at maxTime when nothing else stops it', () => {
      const run = simulate(drop(), { maxTime: 0.1 });

      expect(run.time).toBeCloseTo(0.1, 2);
      expect(run.events).toEqual([]);
    });

    it('predicts exactly what stepping the live ball will do', () => {
      const ahead = simulate(drop(), { maxTime: 1.5 });

      let live = drop();
      for (let i = 0; i < Math.round(1.5 / PHYSICS_DT); i++) live = stepBall(live).state;

      expect(live).toEqual(ahead.state);
    });

    it('can find when a Feed reaches the player\'s end after its bounce (the Ideal Time)', () => {
      const feed = launchBall({ x: 0, y: TABLE_TOP_Y + 0.3, z: -1.37 }, { x: 0, y: 2.4, z: 3.7 });

      const run = simulate(feed, {
        maxTime: 3,
        until: (state) => state.lastBounceHalf === 'player' && state.position.z >= 1.37,
      });

      expect(run.events.map((e) => e.event)).toEqual([expect.objectContaining({ type: 'bounce', half: 'player' })]);
      expect(run.state.position.z).toBeGreaterThanOrEqual(1.37);
      expect(run.state.position.z).toBeLessThan(1.37 + 3.7 * PHYSICS_DT);
      expect(run.time).toBeGreaterThan(run.events[0]!.time);
      expect(run.time).toBeLessThan(3);
    });
  });

  describe('a fast ball never passes through', () => {
    // 40 m/s covers 17 cm per 240 Hz substep and 2 m per 50 ms step: far more than a ball width.
    for (const dt of [PHYSICS_DT, 0.05]) {
      it(`the table (step ${dt.toFixed(4)} s)`, () => {
        let state = launchBall({ x: 0, y: TABLE_TOP_Y + 0.1, z: 0.7 }, { x: 0, y: -40, z: 0 });
        const events = [];
        for (let i = 0; i < 3; i++) {
          const step = stepBall(state, dt);
          state = step.state;
          events.push(...step.events);
          expect(state.position.y).toBeGreaterThanOrEqual(TABLE_TOP_Y + BALL_RADIUS);
        }
        expect(events[0]).toMatchObject({ type: 'bounce', half: 'player' });
        expect(state.velocity.y).toBeGreaterThan(0);
      });

      it(`the net (step ${dt.toFixed(4)} s)`, () => {
        let state = launchBall({ x: 0, y: TABLE_TOP_Y + 0.08, z: 0.1 }, { x: 0, y: 0, z: -40 });
        for (let i = 0; i < 3; i++) {
          state = stepBall(state, dt).state;
          expect(state.position.z).toBeGreaterThan(0);
        }
        expect(state.status).toBe('dead');
      });
    }
  });
});
