import { describe, expect, it } from 'vitest';
import { launchBall } from '../game/ball.ts';
import { OPPONENT_END_Z, TABLE_TOP_Y } from '../game/constants.ts';
import { createGameCore, type OpponentPlan } from '../game/core.ts';
import type { Incoming, RallyEvent } from '../game/rally.ts';
import { contactPoint, knobResolverParams, type ShotEvent } from '../game/shotResolver.ts';
import type { ShotIntent } from '../game/solver.ts';
import { SWING_FAST, SWING_ON, TIMING_OFFSET_MS } from '../game/constants.ts';
import type { SwingEvent } from '../input/types.ts';
import type { Vec3 } from '../physics/vec3.ts';
import { makeRng } from '../util/rng.ts';
import { createBrain } from './brain.ts';
import { DIFFICULTIES, DIFFICULTY_ORDER, type Difficulty } from './difficulty.ts';
import {
  BODY_PARAMS,
  CONTACT_PHASE,
  READY_POSE,
  SWING_BACKSWING_S,
  SWING_FOLLOW_THROUGH_S,
  WHIFF_LATE_S,
  contactSimSeconds,
  followOpponentPlan,
  planBody,
  swingEndSimSeconds,
  type BodyParams,
  type BodyPlan,
  type BodyPose,
} from './motion.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EPS = 1e-9;

/** A synthetic Shot toward the Opponent: it reaches the Opponent's end at `strike` after `idealS` simulated seconds. */
function incomingTo(strike: Vec3, idealS: number): Incoming {
  const ball = launchBall(strike, { x: 0, y: 0, z: -6 });
  return { receiver: 'opponent', ball, launchedAtMs: 0, ideal: { simSeconds: idealS, position: strike }, idealAtMs: (idealS / 0.8) * 1000, strike: ball, shotIndex: 1 };
}

/** A good Shot with `topspin` rad/s (negative = Backspin). */
function shot(topspin: number): ShotIntent {
  return { target: { x: 0, z: 0.8 }, flightTime: 0.9, topspin, sidespin: 0 };
}

/** A random choice: Topspin, Backspin, flat or a Whiff. */
function randomChoice(random: () => number): ShotIntent | 'whiff' {
  const r = random();
  if (r < 0.15) return 'whiff';
  if (r < 0.6) return shot(random() * 300);
  if (r < 0.9) return shot(-random() * 300);
  return shot(0);
}

/** A random strike at the Opponent's end: x from well inside to well out of reach, at a playable height. */
function randomStrike(random: () => number, halfWidth = 1.1): Vec3 {
  return { x: (2 * random() - 1) * halfWidth, y: TABLE_TOP_Y + 0.05 + random() * 0.4, z: OPPONENT_END_Z - random() * 0.05 };
}

const distance = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/**
 * Drive the body through one plan from its launch to `untilS` simulated seconds
 * after it, in frames of `dt()` seconds, landing the last frame exactly on
 * `untilS`. `check` sees every step.
 */
function playPlan(
  start: BodyPose,
  current: { incoming: Incoming; choice: ShotIntent | 'whiff' },
  untilS: number,
  p: BodyParams,
  dt: () => number,
  check: (prev: BodyPose, next: BodyPose, dt: number, t: number) => void = () => {},
): BodyPose {
  let pose = start;
  let t = 0;
  while (t < untilS) {
    const step = Math.min(dt(), untilS - t);
    t = untilS - t <= step ? untilS : t + step;
    const plan: BodyPlan = { ...current, simSecondsSinceLaunch: t };
    const next = planBody(pose, plan, step, p);
    check(pose, next, step, t);
    pose = next;
  }
  return pose;
}

/**
 * How far a step goes past the body's speed and acceleration limits, measured
 * from its positions (0 within them), and whether its reported velocity
 * matches its displacement. Plain arithmetic, not `expect`, so a million steps stay fast.
 */
function limitBreach(prev: BodyPose, next: BodyPose, dt: number, p: BodyParams): number {
  if (dt <= 0) return next.x === prev.x ? 0 : Infinity;
  const v = (next.x - prev.x) / dt;
  if (Math.abs(v - next.vx) > 1e-6) return Infinity;
  return Math.max(0, Math.abs(v) - p.maxSpeed, Math.abs(next.vx) - p.maxSpeed, Math.abs(next.vx - prev.vx) / dt - p.maxAccel);
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

describe('BODY_PARAMS', () => {
  it('has the spec starting values per Difficulty', () => {
    expect(BODY_PARAMS.novice).toEqual({ reactionS: 0.25, maxSpeed: 2.5, maxAccel: 12, reach: 0.7 });
    expect(BODY_PARAMS.intermediate).toEqual({ reactionS: 0.18, maxSpeed: 3, maxAccel: 12, reach: 0.7 });
    expect(BODY_PARAMS.expert).toEqual({ reactionS: 0.12, maxSpeed: 3.5, maxAccel: 12, reach: 0.7 });
  });

  it('starts at rest in the centre, paddle at the ready, not swinging', () => {
    expect(READY_POSE).toMatchObject({ x: 0, vx: 0, lean: 0, swingPhase: 0, paddleTilt: 0 });
    expect(READY_POSE.paddle.z).toBeLessThan(OPPONENT_END_Z);
  });
});

// ---------------------------------------------------------------------------
// Footwork
// ---------------------------------------------------------------------------

describe('planBody footwork', () => {
  const p = BODY_PARAMS.intermediate;

  it('waits reactionS after the launch before moving toward the ball', () => {
    const plan = { incoming: incomingTo({ x: -0.9, y: 0.95, z: OPPONENT_END_Z }, 0.9), choice: shot(100) };
    let movedAt: number | null = null;
    playPlan(READY_POSE, plan, 0.9, p, () => 1 / 120, (_prev, next, _dt, t) => {
      if (movedAt === null && next.x !== 0) movedAt = t;
    });
    expect(movedAt).not.toBeNull();
    expect(movedAt!).toBeGreaterThan(p.reactionS);
    expect(movedAt!).toBeLessThan(p.reactionS + 1 / 60 + EPS);
  });

  it('slides sideways toward the strike and stops there', () => {
    const plan = { incoming: incomingTo({ x: -0.6, y: 0.95, z: OPPONENT_END_Z }, 1.1), choice: shot(100) };
    const end = playPlan(READY_POSE, plan, 1.1, p, () => 1 / 120);
    expect(end.x).toBeLessThan(0);
    expect(Math.abs(end.x - -0.6)).toBeLessThan(p.reach);
    expect(Math.abs(end.vx)).toBeLessThan(0.2);
  });

  it('drifts back to the centre between Shots', () => {
    let pose: BodyPose = { ...READY_POSE, x: 0.8, vx: 0 };
    for (let i = 0; i < 240; i++) pose = planBody(pose, null, 1 / 120, p);
    expect(Math.abs(pose.x)).toBeLessThan(0.01);
    expect(Math.abs(pose.vx)).toBeLessThan(0.05);
    expect(pose.lean).toBe(0);
    expect(pose.swingPhase).toBe(0);
  });

  it('does not move on a frame with no simulated time', () => {
    const pose: BodyPose = { ...READY_POSE, x: 0.4, vx: 1 };
    expect(planBody(pose, null, 0, p).x).toBe(0.4);
  });

  it('never exceeds maxSpeed or maxAccel across 1,000 seeded Rallies', () => {
    let steps = 0;
    let worst = 0;
    let atTopSpeed = 0;
    for (let rally = 0; rally < 1000; rally++) {
      const random = makeRng(5000 + rally);
      const params = BODY_PARAMS[DIFFICULTY_ORDER[rally % 3]!];
      let pose = READY_POSE;
      let held: BodyPlan | null = null;
      const shots = 2 + Math.floor(random() * 7);
      for (let s = 0; s < shots; s++) {
        // Between Shots: no plan (the ball is with the player), for up to a second.
        expect(held).toBeNull();
        const gap = random() * 1.0;
        for (let t = 0; t < gap; ) {
          const dt = random() < 0.03 ? 0 : 0.002 + random() * 0.025;
          t += dt || 0.01;
          const next = planBody(pose, null, dt, params);
          worst = Math.max(worst, limitBreach(pose, next, dt, params));
          pose = next;
          steps++;
        }
        // A Shot toward the Opponent, held through its follow-through.
        const current = { incoming: incomingTo(randomStrike(random), 0.45 + random() * 0.85), choice: randomChoice(random) };
        const until = swingEndSimSeconds(current) + 0.2;
        for (let t = 0; t < until; ) {
          const dt = random() < 0.03 ? 0 : 0.002 + random() * 0.025;
          t += dt;
          const live = t < current.incoming.ideal.simSeconds ? current : null;
          held = followOpponentPlan(live, held, (incoming) => (incoming === current.incoming ? t : 0));
          const next = planBody(pose, held, dt, params);
          worst = Math.max(worst, limitBreach(pose, next, dt, params));
          if (next.vx !== 0 && Math.abs(next.vx) >= params.maxSpeed - 1e-9) atTopSpeed++;
          pose = next;
          steps++;
        }
      }
    }
    expect(steps).toBeGreaterThan(100_000);
    // Not vacuous: the body does run flat out, and never past its limits.
    expect(atTopSpeed).toBeGreaterThan(1000);
    expect(worst).toBeLessThanOrEqual(1e-9);
  });
});

// ---------------------------------------------------------------------------
// Reach, swing and paddle face
// ---------------------------------------------------------------------------

describe('planBody swing', () => {
  it.each(DIFFICULTY_ORDER)('%s: for reachable balls, the paddle is within 5 cm of the strike position at the Ideal Time', (name: Difficulty) => {
    const p = BODY_PARAMS[name];
    const random = makeRng(77);
    let reachable = 0;
    const trials = 400;
    for (let i = 0; i < trials; i++) {
      const start: BodyPose = { ...READY_POSE, x: (2 * random() - 1) * 0.6, vx: (2 * random() - 1) * p.maxSpeed * 0.5 };
      const strike = randomStrike(random, 0.9);
      const idealS = 0.45 + random() * 0.8;
      const current = { incoming: incomingTo(strike, idealS), choice: random() < 0.5 ? shot(random() * 300) : shot(-random() * 300) };
      const atIdeal = playPlan(start, current, idealS, p, () => 0.004 + random() * 0.02);
      expect(atIdeal.swingPhase).toBeCloseTo(CONTACT_PHASE, 9);
      const struck = contactPoint(strike);
      if (Math.abs(struck.x - atIdeal.x) <= p.reach) {
        reachable++;
        expect(distance(atIdeal.paddle, struck)).toBeLessThanOrEqual(0.05);
      }
    }
    // Not vacuous: nearly every ball across the table is reachable.
    expect(reachable).toBeGreaterThan(trials * 0.9);
  });

  it('leans and stretches toward a ball it cannot reach, without the paddle teleporting', () => {
    const p = BODY_PARAMS.novice;
    // A very wide ball with little time: the body can't get within reach.
    const strike = { x: 1.6, y: 0.95, z: OPPONENT_END_Z };
    const current = { incoming: incomingTo(strike, 0.45), choice: shot(100) };
    let maxPaddleStep = 0;
    const atIdeal = playPlan(READY_POSE, current, 0.45, p, () => 1 / 120, (prev, next) => {
      maxPaddleStep = Math.max(maxPaddleStep, distance(prev.paddle, next.paddle));
    });
    expect(Math.abs(strike.x - atIdeal.x)).toBeGreaterThan(p.reach);
    expect(atIdeal.lean).toBeGreaterThan(0); // toward +x, where the ball is
    // The paddle stretches past plain reach, but stays attached to the body.
    expect(atIdeal.paddle.x - atIdeal.x).toBeGreaterThan(p.reach);
    expect(atIdeal.paddle.x - atIdeal.x).toBeLessThan(p.reach + 0.5);
    expect(maxPaddleStep).toBeLessThan(0.1);
  });

  it('does not lean for a ball within reach', () => {
    const p = BODY_PARAMS.expert;
    const current = { incoming: incomingTo({ x: -0.2, y: 0.95, z: OPPONENT_END_Z }, 0.9), choice: shot(100) };
    const atIdeal = playPlan(READY_POSE, current, 0.9, p, () => 1 / 120);
    expect(atIdeal.lean).toBe(0);
  });

  it('backswings from SWING_BACKSWING_S before the Ideal Time and follows through for SWING_FOLLOW_THROUGH_S', () => {
    const p = BODY_PARAMS.intermediate;
    const idealS = 1.0;
    const current = { incoming: incomingTo({ x: -0.3, y: 0.95, z: OPPONENT_END_Z }, idealS), choice: shot(150) };
    const phases: { t: number; phase: number; paddle: Vec3 }[] = [];
    playPlan(READY_POSE, current, idealS + 0.6, p, () => 1 / 240, (_prev, next, _dt, t) => phases.push({ t, phase: next.swingPhase, paddle: next.paddle }));
    const first = phases.find((f) => f.phase > 0)!;
    expect(first.t).toBeGreaterThan(idealS - SWING_BACKSWING_S - EPS);
    expect(first.t).toBeLessThan(idealS - SWING_BACKSWING_S + 1 / 240 + EPS);
    const lastSwinging = phases.filter((f) => f.phase > 0).at(-1)!;
    expect(lastSwinging.t).toBeLessThanOrEqual(idealS + SWING_FOLLOW_THROUGH_S + EPS);
    expect(lastSwinging.t).toBeGreaterThan(idealS + SWING_FOLLOW_THROUGH_S - 1 / 120);
    // The backswing goes away from the net, the follow-through toward it.
    const contactZ = contactPoint(current.incoming.strike.position).z;
    const backswing = phases.find((f) => f.t >= idealS - 0.1 - EPS)!;
    const followThrough = phases.find((f) => f.t >= idealS + SWING_FOLLOW_THROUGH_S - EPS)!;
    expect(backswing.paddle.z).toBeLessThan(contactZ - 0.1);
    expect(followThrough.paddle.z).toBeGreaterThan(contactZ + 0.1);
    // Phases only go forward through the swing.
    const swinging = phases.filter((f) => f.phase > 0);
    for (let i = 1; i < swinging.length; i++) expect(swinging[i]!.phase).toBeGreaterThanOrEqual(swinging[i - 1]!.phase);
  });

  it('on a Whiff, the contact pose comes WHIFF_LATE_S late, through empty air', () => {
    const p = BODY_PARAMS.intermediate;
    const idealS = 0.9;
    const current = { incoming: incomingTo({ x: -0.3, y: 0.95, z: OPPONENT_END_Z }, idealS), choice: 'whiff' as const };
    expect(contactSimSeconds(current)).toBeCloseTo(idealS + WHIFF_LATE_S, 12);
    const atIdeal = playPlan(READY_POSE, current, idealS, p, () => 1 / 120);
    expect(atIdeal.swingPhase).toBeLessThan(CONTACT_PHASE);
    expect(distance(atIdeal.paddle, contactPoint(current.incoming.strike.position))).toBeGreaterThan(0.05);
    const late = playPlan(READY_POSE, current, idealS + WHIFF_LATE_S, p, () => 1 / 120);
    expect(late.swingPhase).toBeCloseTo(CONTACT_PHASE, 9);
  });

  it('closes the paddle face for Topspin and opens it for Backspin', () => {
    const p = BODY_PARAMS.intermediate;
    const strike = { x: -0.3, y: 0.95, z: OPPONENT_END_Z };
    const topspin = playPlan(READY_POSE, { incoming: incomingTo(strike, 0.9), choice: shot(150) }, 0.9, p, () => 1 / 120);
    const backspin = playPlan(READY_POSE, { incoming: incomingTo(strike, 0.9), choice: shot(-150) }, 0.9, p, () => 1 / 120);
    const flat = playPlan(READY_POSE, { incoming: incomingTo(strike, 0.9), choice: shot(0) }, 0.9, p, () => 1 / 120);
    expect(topspin.paddleTilt).toBeGreaterThan(0.2);
    expect(backspin.paddleTilt).toBeLessThan(-0.2);
    expect(Math.abs(flat.paddleTilt)).toBeLessThan(0.05);
  });
});

// ---------------------------------------------------------------------------
// Following the core's plan
// ---------------------------------------------------------------------------

describe('followOpponentPlan', () => {
  const current = { incoming: incomingTo({ x: 0, y: 0.95, z: OPPONENT_END_Z }, 0.8), choice: shot(100) };

  it('follows the core\'s plan while it is set, with the simulated time since its launch', () => {
    expect(followOpponentPlan(current, null, () => 0.3)).toEqual({ ...current, simSecondsSinceLaunch: 0.3 });
  });

  it('holds the last plan after the core clears it, until the swing is over', () => {
    const held = followOpponentPlan(current, null, () => 0.79);
    const end = swingEndSimSeconds(current);
    expect(end).toBeGreaterThanOrEqual(0.8 + SWING_FOLLOW_THROUGH_S);
    expect(followOpponentPlan(null, held, () => 0.95)).toEqual({ ...current, simSecondsSinceLaunch: 0.95 });
    expect(followOpponentPlan(null, held, () => end + 0.01)).toBeNull();
  });

  it('a new plan replaces a held one', () => {
    const held = followOpponentPlan(current, null, () => 0.9);
    const next = { incoming: incomingTo({ x: 0.3, y: 0.95, z: OPPONENT_END_Z }, 0.7), choice: shot(-50) };
    expect(followOpponentPlan(next, held, (incoming) => (incoming === next.incoming ? 0.1 : 0.9))?.incoming).toBe(next.incoming);
  });

  it('is null with no plan to follow', () => {
    expect(followOpponentPlan(null, null, () => 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ADR 0002: the body is cosmetic
// ---------------------------------------------------------------------------

/** Every source file under src/game/, as raw text. */
const gameSources = import.meta.glob('/src/game/**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

describe('the body never changes an outcome (ADR 0002)', () => {
  it('core.ts, and nothing else in src/game/, imports motion.ts', () => {
    expect(Object.keys(gameSources)).toContain('/src/game/core.ts');
    const importers = Object.entries(gameSources).filter(([, text]) => /from\s*['"][^'"]*opponent\/motion(\.ts)?['"]/.test(text));
    expect(importers.map(([path]) => path)).toEqual([]);
  });

  it('a headless Match is identical with or without the body', () => {
    function play(withBody: boolean): { shots: ShotEvent[]; rally: RallyEvent[]; plans: OpponentPlan[] } {
      const core = createGameCore({ random: makeRng(91), resolverParams: knobResolverParams, hand: () => 'right', mode: 'match', opponent: createBrain(DIFFICULTIES.expert) });
      const shots: ShotEvent[] = [];
      const rally: RallyEvent[] = [];
      const plans: OpponentPlan[] = [];
      core.onShot((e) => shots.push(e));
      core.onRally((e) => rally.push(e));
      const pending: { swing: SwingEvent | null } = { swing: null };
      core.onIncoming((incoming) => {
        if (incoming.receiver === 'player') pending.swing = { t: incoming.idealAtMs + TIMING_OFFSET_MS.value, peakSpeed: (SWING_ON.value + SWING_FAST.value) / 2, side: 'forehand', vertPath: 0 };
      });
      let pose = READY_POSE;
      let held: BodyPlan | null = null;
      const frameS = 1 / 60;
      for (let i = 1; i <= 60 * 40; i++) {
        const nowMs = 1000 + i * frameS * 1000;
        if (pending.swing && nowMs >= pending.swing.t) {
          core.swing(pending.swing, nowMs);
          pending.swing = null;
        }
        core.frame({ nowMs, elapsedSeconds: frameS });
        const plan = core.opponentPlan;
        if (plan && plans.at(-1) !== plan) plans.push(plan);
        if (withBody) {
          held = followOpponentPlan(plan, held, (incoming) => ((nowMs - incoming.launchedAtMs) / 1000) * 0.8);
          pose = planBody(pose, held, frameS * 0.8, BODY_PARAMS.expert);
        }
      }
      if (withBody) expect(pose.paddle).toBeDefined();
      return { shots, rally, plans };
    }
    const without = play(false);
    const withBody = play(true);
    expect(without.rally.filter((e) => e.type === 'shot' && e.by === 'opponent').length).toBeGreaterThan(2);
    expect(withBody.rally).toEqual(without.rally);
    expect(withBody.shots).toEqual(without.shots);
    expect(withBody.plans).toEqual(without.plans);
  });
});
