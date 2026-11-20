import { describe, expect, it } from 'vitest';
import { knobFlightParams, launchBall, simulate, stepBall, type BallState, type Vec3 } from './ball.ts';
import { BALL_RADIUS, DRAG_K, FEEDER_MOUTH, GRAVITY, PHYSICS_DT, TABLE_TOP_Y, TABLE_WIDTH } from './constants.ts';
import { revsToRadPerSec, spinVector } from '../physics/spin.ts';
import { cross, length, scale } from '../physics/vec3.ts';

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

  describe('spin in flight', () => {
    it('builds its flight parameters from the knobs, at the spec starting values', () => {
      expect(knobFlightParams()).toEqual({ g: GRAVITY, k: DRAG_K, kM: 0.003, spinTau: 4 });
    });

    it('a new ball has no spin and seed 0 unless given them', () => {
      const plain = launchBall({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -5 });
      expect(plain.spin).toEqual({ x: 0, y: 0, z: 0 });
      expect(plain.seed).toBe(0);

      const spin = { x: -100, y: 0, z: 0 };
      const spun = launchBall({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -5 }, spin, 42);
      expect(spun.spin).toEqual(spin);
      expect(spun.spin).not.toBe(spin);
      expect(spun.seed).toBe(42);
    });

    // Golden values from the integrator before spin (commit a8eec49): positions
    // after 1 s (240 substeps) with the default knobs. The Feed is the solver's
    // launch from FEEDER_MOUTH to (0.3, 0.75) in 1 s; the hard Return its launch
    // from the player's end to (−0.2, −1.2) in 0.55 s. Both bounce once.
    const GOLDEN = [
      {
        name: 'a Feed',
        from: FEEDER_MOUTH,
        velocity: { x: 0.4018, y: 4.625, z: 2.8393 },
        after1s: { x: 0.3166587085323193, y: 1.0333047471443821, z: 0.8676532382673328 },
      },
      {
        name: 'a hard Return',
        from: { x: 0.1, y: TABLE_TOP_Y + 0.3, z: 1.37 },
        velocity: { x: -0.6857, y: 2.1887, z: -5.8746 },
        after1s: { x: -0.3754921966955337, y: 0.8392398569562248, z: -2.703685954072605 },
      },
    ];
    for (const { name, from, velocity, after1s } of GOLDEN) {
      it(`with zero spin, ${name} is where the old integrator put it after 1 s (within 1 mm)`, () => {
        const run = simulate(launchBall(from, velocity), { maxTime: 1 });
        expect(run.events).toHaveLength(1);
        expect(run.events[0]!.event.type).toBe('bounce');
        const p = run.state.position;
        expect(Math.hypot(p.x - after1s.x, p.y - after1s.y, p.z - after1s.z)).toBeLessThan(0.001);
      });
    }

    // 8 m/s toward the Feeder, 10° up, from (0, 1.0, 1.2).
    const FROM = { x: 0, y: 1.0, z: 1.2 };
    const UP_10 = (10 * Math.PI) / 180;
    const LAUNCH = { x: 0, y: 8 * Math.sin(UP_10), z: -8 * Math.cos(UP_10) };
    const TOWARD_FEEDER = { x: 0, y: 0, z: -1 };
    const CONTACT_Y = TABLE_TOP_Y + BALL_RADIUS;

    /** Where the centre first comes down to table-contact height (on the table or past it). */
    function landing(spin: Vec3): Vec3 {
      let before: BallState = launchBall(FROM, LAUNCH, spin);
      let at: Vec3 | null = null;
      simulate(before, {
        maxTime: 3,
        until: (state, _time, events) => {
          const bounce = events.find((e) => e.type === 'bounce');
          if (bounce) at = bounce.position;
          else if (state.position.y <= CONTACT_Y && state.velocity.y < 0) {
            const f = (before.position.y - CONTACT_Y) / (before.position.y - state.position.y);
            const a = before.position;
            const b = state.position;
            at = { x: a.x + (b.x - a.x) * f, y: CONTACT_Y, z: a.z + (b.z - a.z) * f };
          }
          before = state;
          return at !== null;
        },
      });
      if (!at) throw new Error('never came down to the table');
      return at;
    }

    const noSpin = landing({ x: 0, y: 0, z: 0 });

    it('Topspin 50 rev/s lands at least 15 cm shorter than no spin', () => {
      const topspin = landing(spinVector(revsToRadPerSec(50), 0, TOWARD_FEEDER));
      // Shorter = less far toward the Feeder (−z).
      expect(topspin.z - noSpin.z).toBeGreaterThanOrEqual(0.15);
    });

    it('Backspin 50 rev/s lands at least 15 cm longer than no spin', () => {
      const backspin = landing(spinVector(-revsToRadPerSec(50), 0, TOWARD_FEEDER));
      expect(noSpin.z - backspin.z).toBeGreaterThanOrEqual(0.15);
    });

    it('Sidespin 20 rev/s moves the landing at least 5 cm sideways, toward ŷ × v', () => {
      const sidespin = revsToRadPerSec(20);
      const landed = landing(spinVector(0, sidespin, TOWARD_FEEDER));
      const shift = landed.x - noSpin.x;
      const expectedSide = Math.sign(cross(scale({ x: 0, y: 1, z: 0 }, sidespin), LAUNCH).x);
      expect(Math.abs(shift)).toBeGreaterThanOrEqual(0.05);
      expect(Math.sign(shift)).toBe(expectedSide);
    });

    it('spin falls to 1/e of its start after one decay time constant (within 1%)', () => {
      const params = { ...knobFlightParams(), spinTau: 0.5 };
      const start = { x: -314, y: 30, z: 0 };
      const ball = launchBall({ x: 0, y: 3, z: 0.5 }, { x: 0, y: 0, z: -1 }, start);

      const run = simulate(ball, { maxTime: params.spinTau }, params);

      const ratio = length(run.state.spin) / length(start);
      expect(Math.abs(ratio / Math.exp(-1) - 1)).toBeLessThan(0.01);
    });

    it('stepping the ball does not mutate its input', () => {
      const ball = launchBall({ x: 0, y: TABLE_TOP_Y + 0.05, z: 0.3 }, { x: 0.5, y: -3, z: -4 }, { x: -200, y: 40, z: 0 }, 7);
      const frozen: BallState = Object.freeze({
        ...ball,
        position: Object.freeze({ ...ball.position }),
        velocity: Object.freeze({ ...ball.velocity }),
        spin: Object.freeze({ ...ball.spin }),
      });
      const copy = structuredClone(frozen);

      // Several substeps through a table bounce, with the default and an explicit step.
      let state = frozen;
      for (let i = 0; i < 20; i++) state = stepBall(state, i % 2 ? undefined : PHYSICS_DT / 2).state;
      stepBall(frozen, PHYSICS_DT, knobFlightParams());

      expect(frozen).toEqual(copy);
      expect(state.seed).toBe(7);
    });

    it('a ball with spin keeps its seed and spin through a bounce (bounces don\'t change spin yet)', () => {
      const params = { ...knobFlightParams(), spinTau: Infinity };
      const spin = { x: -150, y: 0, z: 0 };
      const ball = launchBall({ x: 0, y: TABLE_TOP_Y + 0.2, z: 0.7 }, { x: 0, y: 0, z: 0 }, spin, 99);

      const run = simulate(ball, { maxTime: 0.5 }, params);

      expect(run.events.map((e) => e.event.type)).toContain('bounce');
      expect(run.state.spin).toEqual(spin);
      expect(run.state.seed).toBe(99);
    });
  });
});
