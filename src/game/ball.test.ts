import { describe, expect, it } from 'vitest';
import { knobBounceParams, knobFlightParams, launchBall, simulate, stepBall, type BallState, type Vec3 } from './ball.ts';
import { BALL_RADIUS, DRAG_K, FEEDER_MOUTH, GRAVITY, NET_HEIGHT, PHYSICS_DT, TABLE_TOP_Y, TABLE_WIDTH } from './constants.ts';
import { judgeReturnFlight } from './score.ts';
import { revsToRadPerSec, spinVector } from '../physics/spin.ts';
import { cross, length, scale, ZERO } from '../physics/vec3.ts';

/** Height of the ball's bottom above the table top. */
const heightAboveTable = (y: number) => y - BALL_RADIUS - TABLE_TOP_Y;
const TOWARD_FEEDER = { x: 0, y: 0, z: -1 };

describe('ball physics', () => {
  // The bounce alone gives 23.2 cm (e² · 30 cm, checked in physics/bounce.test.ts);
  // air drag on the way down and up takes it to 21.6 cm, and the 240 Hz
  // integrator lands at 22.0 cm. Hence 21 cm, not 22, as the lower bound here.
  it('a ball dropped from 30 cm above the table bounces to about 22 cm (with air drag)', () => {
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
    const ball = launchBall({ x: 0, y: TABLE_TOP_Y + 0.35, z: -1.3 }, { x: 0, y: 0, z: 3.5 });

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
      const feed = launchBall({ x: 0, y: TABLE_TOP_Y + 0.3, z: -1.37 }, { x: 0, y: 2.4, z: 4.5 });

      const run = simulate(feed, {
        maxTime: 3,
        until: (state) => state.lastBounceHalf === 'player' && state.position.z >= 1.37,
      });

      expect(run.events.map((e) => e.event)).toEqual([expect.objectContaining({ type: 'bounce', half: 'player' })]);
      expect(run.state.position.z).toBeGreaterThanOrEqual(1.37);
      expect(run.state.position.z).toBeLessThan(1.37 + 4.5 * PHYSICS_DT);
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

    // Golden values for the flight before spin: where and when each ball
    // first bounces, with the default knobs. The Feed is the solver's launch
    // from FEEDER_MOUTH to (0.3, 0.75) in 1 s; the hard Return its launch from
    // the player's end to (−0.2, −1.2) in 0.55 s. Captured from the P1-a
    // integrator (commit 6db5fe4), which matched the pre-spin one (a8eec49) to
    // within 1 mm after 1 s; from P1-b on the bounce itself trades speed and
    // spin, so only the flight up to the bounce is compared.
    const GOLDEN = [
      {
        name: 'a Feed',
        from: FEEDER_MOUTH,
        velocity: { x: 0.4018, y: 4.625, z: 2.8393 },
        bounce: { x: 0.2999009755294899, y: 0.78, z: 0.7492355396238946 },
        bounceTime: 0.9291666666666667,
      },
      {
        name: 'a hard Return',
        from: { x: 0.1, y: TABLE_TOP_Y + 0.3, z: 1.37 },
        velocity: { x: -0.6857, y: 2.1887, z: -5.8746 },
        bounce: { x: -0.19990175638335173, y: 0.78, z: -1.1993493627674479 },
        bounceTime: 0.5333333333333333,
      },
    ];
    for (const { name, from, velocity, bounce, bounceTime } of GOLDEN) {
      it(`with zero spin, ${name} bounces where the old integrator put it (within 1 mm)`, () => {
        const run = simulate(launchBall(from, velocity), { maxTime: 1, until: (_s, _t, events) => events.length > 0 });
        expect(run.events).toHaveLength(1);
        const { event, time } = run.events[0]!;
        expect(event.type).toBe('bounce');
        const p = event.position;
        expect(Math.hypot(p.x - bounce.x, p.y - bounce.y, p.z - bounce.z)).toBeLessThan(0.001);
        expect(time).toBeCloseTo(bounceTime, 9);
      });
    }

    // 8 m/s toward the Feeder, 10° up, from (0, 1.0, 1.2).
    const FROM = { x: 0, y: 1.0, z: 1.2 };
    const UP_10 = (10 * Math.PI) / 180;
    const LAUNCH = { x: 0, y: 8 * Math.sin(UP_10), z: -8 * Math.cos(UP_10) };
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

  });

  describe('spin at the table bounce', () => {
    it('builds its bounce parameters from the knobs, at the spec starting values', () => {
      expect(knobBounceParams()).toEqual({ e: 0.88, mu: 0.25, kappa: 1.5, r: BALL_RADIUS });
    });

    it('a bounce trades horizontal speed for spin as tableBounce does (Δω = −(κ/r) ŷ × Δv), keeping the seed', () => {
      // No drag, no Magnus, no decay: across the bounce substep only the bounce changes v_T and ω.
      const params = { ...knobFlightParams(), k: 0, kM: 0, spinTau: Infinity };
      const spin = { x: -150, y: 0, z: 0 }; // Topspin for a Shot toward the Feeder
      let state: BallState = launchBall({ x: 0, y: TABLE_TOP_Y + 0.2, z: 0.7 }, { x: 0, y: 0, z: 0 }, spin, 99);
      let before = state;
      for (let i = 0; i < 240; i++) {
        before = state;
        const step = stepBall(state, PHYSICS_DT, params);
        state = step.state;
        if (step.events.some((e) => e.type === 'bounce')) break;
      }
      expect(state.velocity.y).toBeGreaterThan(0);

      const dv = { x: state.velocity.x - before.velocity.x, y: 0, z: state.velocity.z - before.velocity.z };
      const expected = scale(cross({ x: 0, y: 1, z: 0 }, dv), -knobBounceParams().kappa / BALL_RADIUS);
      expect(state.spin.x - spin.x).toBeCloseTo(expected.x, 9);
      expect(state.spin.y).toBe(0);
      expect(state.spin.z - spin.z).toBeCloseTo(expected.z, 9);
      // A Topspin ball dropped straight down kicks forward, toward the Feeder, and spins less.
      expect(state.velocity.z).toBeLessThan(0);
      expect(Math.abs(state.spin.x)).toBeLessThan(150);
      expect(state.seed).toBe(99);
    });

    it('Topspin comes off the table faster and Backspin no faster than no spin', () => {
      // Arrives at about 6 m/s, 30° down, toward the Feeder, just above the table.
      // No Magnus, so all three arrive alike and only the bounce tells them apart.
      const params = { ...knobFlightParams(), kM: 0 };
      const at = { x: 0, y: TABLE_TOP_Y + BALL_RADIUS + 0.01, z: -0.6 };
      const v = { x: 0, y: -3, z: -5.2 };
      const after = (topspin: number) => {
        const ball = launchBall(at, v, spinVector(revsToRadPerSec(topspin), 0, TOWARD_FEEDER));
        const run = simulate(ball, { maxTime: 0.1, until: (_s, _t, events) => events.length > 0 }, params);
        expect(run.events.map((e) => e.event.type)).toEqual(['bounce']);
        return -run.state.velocity.z;
      };
      expect(after(50)).toBeGreaterThan(after(0) + 1);
      expect(after(-50)).toBeLessThanOrEqual(after(0) + 1e-9);
    });

    it('a ball rolling slowly on the table settles: it stops, never bounces, and keeps its spin', () => {
      const params = { ...knobFlightParams(), spinTau: Infinity };
      const spin = { x: -50, y: 20, z: 0 };
      const ball = launchBall({ x: 0, y: TABLE_TOP_Y + BALL_RADIUS, z: 0.7 }, { x: 0, y: 0, z: -1 }, spin);

      const run = simulate(ball, { maxTime: 1 }, params);

      expect(run.events).toEqual([]);
      expect(length(run.state.velocity)).toBeLessThan(1e-6);
      expect(run.state.position.y).toBeCloseTo(TABLE_TOP_Y + BALL_RADIUS, 6);
      expect(run.state.spin).toEqual(spin);
    });
  });

  describe('the Net-cord', () => {
    const NET_TOP_Y = TABLE_TOP_Y + NET_HEIGHT;
    /** A ball 1 cm from the net heading for the Feeder's half with its bottom `below` under the net top. */
    const atNet = (below: number, vz: number, seed = 0) =>
      launchBall({ x: 0.1, y: NET_TOP_Y + BALL_RADIUS - below, z: 0.01 }, { x: 0, y: 0, z: vz }, ZERO, seed);
    const untilSettled = { maxTime: 3 };

    it('a ball clipping the net top leaves upward, emits one cord event and stays live', () => {
      const ball = atNet(0.01, -3, 5);
      let after: BallState | null = null;
      const run = simulate(ball, {
        maxTime: 1,
        until: (state, _time, events) => {
          if (events.some((e) => e.type === 'cord')) after = state;
          return after !== null;
        },
      });

      expect(run.events.map((e) => e.event.type)).toEqual(['cord']);
      const cord = run.events[0]!.event;
      // At the contact the ball's bottom sits on the net top, on the net plane.
      expect(cord.position.y).toBeCloseTo(NET_TOP_Y + BALL_RADIUS, 9);
      expect(Math.abs(cord.position.z)).toBeLessThan(1e-9);
      expect(after!.velocity.y).toBeGreaterThan(0);
      expect(after!.status).toBe('live');
      expect(after!.position.y).toBeGreaterThan(NET_TOP_Y + BALL_RADIUS);
    });

    it('the same ball and seed cord the same way twice', () => {
      expect(simulate(atNet(0.01, -1, 42), untilSettled)).toEqual(simulate(atNet(0.01, -1, 42), untilSettled));
    });

    it('across 100 seeds some slow cords trickle over and some drop back', () => {
      let over = 0;
      let back = 0;
      for (let seed = 0; seed < 100; seed++) {
        const run = simulate(atNet(0.01, -1, seed), {
          maxTime: 1,
          until: (_s, _t, events) => events.some((e) => e.type === 'bounce'),
        });
        expect(run.events.filter((e) => e.event.type === 'cord')).toHaveLength(1);
        const bounce = run.events.find((e) => e.event.type === 'bounce')!.event;
        if (bounce.type === 'bounce' && bounce.half === 'feeder') over++;
        else back++;
      }
      expect(over).toBeGreaterThan(0);
      expect(back).toBeGreaterThan(0);
    });

    it('a live Net-cord that lands on the far half is a bounce there and stays live (a Return)', () => {
      const run = simulate(atNet(0.015, -3, 1), {
        maxTime: 1,
        until: (_s, _t, events) => events.some((e) => e.type === 'bounce'),
      });

      const events = run.events.map((e) => e.event);
      expect(events).toEqual([expect.objectContaining({ type: 'cord' }), expect.objectContaining({ type: 'bounce', half: 'feeder' })]);
      expect(run.state.status).toBe('live');
      expect(run.state.lastBounceHalf).toBe('feeder');
      expect(judgeReturnFlight(events)).toMatchObject({ type: 'return' });
    });

    it('a ball more than a radius below the net top hits the net: dead, no cord', () => {
      const run = simulate(atNet(BALL_RADIUS + 0.002, -3), untilSettled);
      const types = run.events.map((e) => e.event.type);
      expect(types[0]).toBe('net');
      expect(types).not.toContain('cord');
      expect(run.state.status).toBe('dead');
    });

    it('a ball whose bottom clears the net top crosses with no contact', () => {
      const ball = launchBall({ x: 0, y: NET_TOP_Y + BALL_RADIUS + 0.002, z: 0.01 }, { x: 0, y: 1, z: -3 });
      const run = simulate(ball, { maxTime: 0.05 });
      expect(run.events).toEqual([]);
      expect(run.state.position.z).toBeLessThan(0);
      expect(run.state.velocity.z).toBeLessThan(-2.9);
    });
  });
});
