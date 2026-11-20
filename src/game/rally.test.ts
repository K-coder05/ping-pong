import { describe, expect, it } from 'vitest';
import { revsToRadPerSec } from '../physics/spin.ts';
import { launchBall, simulate, type BallEvent, type BallState, type Vec3 } from './ball.ts';
import { BALL_RADIUS, FEEDER_MOUTH, OPPONENT_END_Z, PLAYER_END_Z, TABLE_TOP_Y } from './constants.ts';
import { createReferee, findIdealTime, lookAhead, type RallyEndCall } from './rally.ts';
import { OPPONENT_SERVE_FROM, solveServe } from './serve.ts';
import { otherSide, type Side } from './side.ts';
import { solveShot, type ShotIntent } from './solver.ts';

/** Mirror a ball across the net (z → −z): position and velocity flip z; Spin, an axial vector, flips x and y. */
function mirror(ball: BallState): BallState {
  const flip = (v: Readonly<Vec3>): Vec3 => ({ x: v.x, y: v.y, z: -v.z });
  const spin = { x: -ball.spin.x, y: -ball.spin.y, z: ball.spin.z };
  return launchBall(flip(ball.position), flip(ball.velocity), spin, ball.seed);
}

/** A ball launched by the opponent side as given, or its mirror image when the player is the hitter. */
function from(hitter: Side, ball: BallState): BallState {
  return hitter === 'opponent' ? ball : mirror(ball);
}

/** Every event of `ball` over `seconds` of simulated flight, in order. */
function eventsOf(ball: BallState, seconds = 3): BallEvent[] {
  return simulate(ball, { maxTime: seconds }).events.map((e) => e.event);
}

/** A solved Shot from the Opponent's end toward the player's half. */
function solved(target: { x: number; z: number }, flightTime = 1, topspin = 0): BallState {
  const intent: ShotIntent = { target, flightTime, topspin, sidespin: 0 };
  const solution = solveShot(FEEDER_MOUTH, intent);
  expect(solution, `solve (${target.x}, ${target.z})`).not.toBeNull();
  return launchBall(FEEDER_MOUTH, solution!.velocity, solution!.spin, 12345);
}

/** Referee one Shot by `hitter`: the first decided Rally End, or null. `noReturnAfter` calls noReturn after that many events (0 = before any). */
function referee(hitter: Side, events: readonly BallEvent[], noReturnAfter: number | null = null): RallyEndCall | null {
  const ref = createReferee();
  ref.shot(hitter);
  let call: RallyEndCall | null = null;
  events.forEach((event, i) => {
    if (noReturnAfter === i) call ??= ref.noReturn();
    call ??= ref.ballEvent(event);
  });
  if (noReturnAfter !== null && noReturnAfter >= events.length) call ??= ref.noReturn();
  return call;
}

const BOTH: Side[] = ['opponent', 'player'];

describe('findIdealTime', () => {
  it('finds when a Shot toward the player crosses the player end line after bouncing on its half', () => {
    const ball = solved({ x: -0.3, z: 0.7 });
    const ideal = findIdealTime(ball, 'player')!;
    expect(ideal).not.toBeNull();
    expect(ideal.position.z).toBeCloseTo(PLAYER_END_Z, 6);
    expect(ideal.position.y).toBeGreaterThan(TABLE_TOP_Y);
    expect(ideal.simSeconds).toBeGreaterThan(1);
  });

  it('gives a Shot and its mirror image the same time and a mirrored position, within 1 ms and 1 mm', () => {
    const cases = [solved({ x: -0.3, z: 0.7 }), solved({ x: 0.5, z: 1.0 }, 0.8, revsToRadPerSec(30)), solved({ x: 0.1, z: 1.1 }, 0.7, -revsToRadPerSec(20))];
    for (const ball of cases) {
      const toPlayer = findIdealTime(ball, 'player')!;
      const toOpponent = findIdealTime(mirror(ball), 'opponent')!;
      expect(toOpponent).not.toBeNull();
      expect(Math.abs(toOpponent.simSeconds - toPlayer.simSeconds)).toBeLessThan(0.001);
      expect(Math.abs(toOpponent.position.x - toPlayer.position.x)).toBeLessThan(0.001);
      expect(Math.abs(toOpponent.position.y - toPlayer.position.y)).toBeLessThan(0.001);
      expect(Math.abs(toOpponent.position.z + toPlayer.position.z)).toBeLessThan(0.001);
      expect(toOpponent.position.z).toBeCloseTo(OPPONENT_END_Z, 6);
    }
  });

  it('is null for the wrong receiver, a Shot into the net, and a first bounce on the hitter half', () => {
    const ball = solved({ x: 0, z: 0.8 });
    expect(findIdealTime(ball, 'opponent')).toBeNull();
    expect(findIdealTime(launchBall({ x: 0, y: 0.85, z: -1 }, { x: 0, y: 0, z: 10 }), 'player')).toBeNull();
    // Bounces on the Opponent half, then carries over the net onto the player half and off the end: still not legal.
    const ownHalf = launchBall({ x: 0, y: TABLE_TOP_Y + 0.25, z: -1.2 }, { x: 0, y: -1, z: 5 });
    const halves = eventsOf(ownHalf).filter((e) => e.type === 'bounce').map((e) => (e.type === 'bounce' ? e.half : null));
    expect(halves.slice(0, 2)).toEqual(['opponent', 'player']);
    expect(findIdealTime(ownHalf, 'player')).toBeNull();
  });

  it('lookAhead gives the ball at the Ideal Time: the strike', () => {
    const ball = solved({ x: 0.2, z: 0.8 }, 1, revsToRadPerSec(20));
    const { ideal, strike } = lookAhead(ball, 'player')!;
    expect(ideal).toEqual(findIdealTime(ball, 'player'));
    expect(strike.position).toEqual(ideal.position);
    expect(strike.velocity.z).toBeGreaterThan(0); // still travelling toward the player
    expect(strike.lastBounceHalf).toBe('player');
    expect(Math.hypot(strike.spin.x, strike.spin.y, strike.spin.z)).toBeGreaterThan(0);
  });
});

describe('referee: Rally Ends from real flights', () => {
  it.each(BOTH)('calls a dead net against the hitter (%s)', (hitter) => {
    const ball = from(hitter, launchBall({ x: 0, y: 0.85, z: -1 }, { x: 0, y: 0, z: 10 }));
    const events = eventsOf(ball);
    expect(events.some((e) => e.type === 'net')).toBe(true);
    expect(referee(hitter, events)).toEqual({ end: 'net', loser: hitter });
  });

  it.each(BOTH)('calls a Shot off the table with no bounce Out, against the hitter (%s)', (hitter) => {
    const solution = solveShot(FEEDER_MOUTH, { target: { x: 0, z: PLAYER_END_Z + 0.3 }, flightTime: 0.9, topspin: 0, sidespin: 0 })!;
    expect(solution).not.toBeNull();
    const ball = from(hitter, launchBall(FEEDER_MOUTH, solution.velocity));
    const events = eventsOf(ball);
    expect(events.find((e) => e.type !== 'cord')?.type).toBe('out');
    expect(referee(hitter, events)).toEqual({ end: 'out', loser: hitter });
  });

  it.each(BOTH)('calls a first bounce on the hitter half Own-half (%s)', (hitter) => {
    const ball = from(hitter, launchBall({ x: 0, y: TABLE_TOP_Y + 0.25, z: -1.2 }, { x: 0, y: -1, z: 5 }));
    expect(referee(hitter, eventsOf(ball))).toEqual({ end: 'own-half', loser: hitter });
  });

  it.each(BOTH)('calls a legal Shot the receiver never returns Unreturned, against the receiver (%s)', (hitter) => {
    const ball = from(hitter, solved({ x: 0.2, z: 0.8 }));
    const events = eventsOf(ball);
    const receiver = otherSide(hitter);
    // While the receiver could still return it, the ball leaving the table ends nothing.
    expect(referee(hitter, events)).toBeNull();
    // Their chance passes (a Whiff, or Early, Late or Miss) before the ball is done, or after.
    expect(referee(hitter, events, 0)).toEqual({ end: 'unreturned', loser: receiver });
    expect(referee(hitter, events, events.length)).toEqual({ end: 'unreturned', loser: receiver });
  });

  it.each(BOTH)('calls a second bounce on the receiver half Unreturned (%s)', (hitter) => {
    // Short and slow: bounces twice on the receiver's half.
    const ball = from(hitter, launchBall({ x: 0, y: TABLE_TOP_Y + 0.35, z: -0.3 }, { x: 0, y: 0.5, z: 1.6 }));
    const events = eventsOf(ball);
    const receiverHalf = otherSide(hitter);
    const bounces = events.filter((e) => e.type === 'bounce').map((e) => (e.type === 'bounce' ? e.half : null));
    expect(bounces.slice(0, 2)).toEqual([receiverHalf, receiverHalf]);
    expect(referee(hitter, events, 0)).toEqual({ end: 'unreturned', loser: receiverHalf });
  });

  it.each(BOTH)('lets a Net-cord that lands on the receiver half play on (%s)', (hitter) => {
    const ball = from(hitter, findNetCord());
    const events = eventsOf(ball);
    const cordAt = events.findIndex((e) => e.type === 'cord');
    expect(cordAt).toBeGreaterThanOrEqual(0);
    const firstBounce = events.find((e) => e.type === 'bounce');
    expect(firstBounce?.type === 'bounce' && firstBounce.half).toBe(otherSide(hitter));
    const ref = createReferee();
    ref.shot(hitter);
    for (const event of events.slice(0, cordAt + 1)) expect(ref.ballEvent(event)).toBeNull();
    // Played on: the receiver's chance is still open after the legal bounce.
    for (const event of events.slice(cordAt + 1)) expect(ref.ballEvent(event)).toBeNull();
    expect(ref.ended).toBeNull();
  });
});

describe('referee: bookkeeping', () => {
  it('ends nothing before the first Shot, and nothing more once ended', () => {
    const ref = createReferee();
    const net: BallEvent = { type: 'net', position: { x: 0, y: 0.8, z: 0 } };
    expect(ref.ballEvent(net)).toBeNull();
    expect(ref.noReturn()).toBeNull();
    ref.shot('player');
    expect(ref.ballEvent(net)).toEqual({ end: 'net', loser: 'player' });
    expect(ref.ended).toEqual({ end: 'net', loser: 'player' });
    expect(ref.ballEvent({ type: 'out', reason: 'off-table', position: { x: 0, y: 0, z: 0 } })).toBeNull();
    expect(ref.noReturn()).toBeNull();
  });

  it('starts each Shot afresh: a Return made in time cancels the previous Shot pending end', () => {
    const ref = createReferee();
    ref.shot('opponent');
    const bounce = (half: Side): BallEvent => ({ type: 'bounce', half, position: { x: 0, y: TABLE_TOP_Y + BALL_RADIUS, z: half === 'player' ? 1 : -1 } });
    expect(ref.ballEvent(bounce('player'))).toBeNull();
    expect(ref.ballEvent({ type: 'out', reason: 'off-table', position: { x: 0, y: 0.7, z: 1.5 } })).toBeNull();
    // A late but accepted Swing strikes it anyway (ADR 0001): a new Shot, judged on its own.
    ref.shot('player');
    expect(ref.noReturn()).toBeNull();
    expect(ref.ballEvent(bounce('opponent'))).toBeNull();
    expect(ref.ballEvent(bounce('player'))).toEqual({ end: 'unreturned', loser: 'opponent' });
  });

  it('starts a new Rally after reset()', () => {
    const ref = createReferee();
    ref.shot('player');
    ref.ballEvent({ type: 'net', position: { x: 0, y: 0.8, z: 0 } });
    ref.reset();
    expect(ref.ended).toBeNull();
    ref.shot('opponent');
    expect(ref.ballEvent({ type: 'net', position: { x: 0, y: 0.8, z: 0 } })).toEqual({ end: 'net', loser: 'opponent' });
  });
});

/**
 * A Shot from the Opponent half that clips the net top (a Net-cord) and still
 * lands on the player half, found by scanning launch heights with a fixed seed.
 */
function findNetCord(): BallState {
  for (let dy = 0; dy <= 0.2; dy += 0.002) {
    for (const vz of [5, 5.5, 6, 6.5, 7]) {
      const ball = launchBall({ x: 0.1, y: TABLE_TOP_Y + 0.12 + dy, z: -0.8 }, { x: 0, y: 0.5, z: vz }, { x: 0, y: 0, z: 0 }, 7);
      const events = eventsOf(ball);
      const cord = events.findIndex((e) => e.type === 'cord');
      const first = events.find((e) => e.type === 'bounce' || e.type === 'net' || e.type === 'out');
      if (cord >= 0 && first?.type === 'bounce' && first.half === 'player' && events.indexOf(first) > cord) return ball;
    }
  }
  throw new Error('no Net-cord found');
}

// ---------------------------------------------------------------------------
// Serves (spec P2-f1): the referee's Serve rules, from synthetic ball events.
// Real Serve flights are in serve.test.ts (judgeServe).
// ---------------------------------------------------------------------------

const at = (half: Side) => ({ x: 0, y: TABLE_TOP_Y + BALL_RADIUS, z: half === 'player' ? 0.8 : -0.8 });
const bounceOn = (half: Side): BallEvent => ({ type: 'bounce', half, position: at(half) });
const NET: BallEvent = { type: 'net', position: { x: 0, y: 0.85, z: 0 } };
const CORD: BallEvent = { type: 'cord', position: { x: 0, y: 0.95, z: 0 } };
const OFF_TABLE: BallEvent = { type: 'out', reason: 'off-table', position: { x: 0, y: 0.7, z: 1.5 } };

/** Referee a Serve by `server` through `events`: every call it made, its Serve result and Rally End. */
function refereeServe(server: Side, events: readonly BallEvent[]) {
  const ref = createReferee();
  ref.serve(server);
  const calls = events.map((event) => ref.ballEvent(event));
  return { ref, calls, result: ref.serveResult, ended: ref.ended };
}

describe('referee: Serve rules', () => {
  describe.each(BOTH)('a Serve by %s', (server) => {
    const receiver = otherSide(server);
    const fault = { end: 'fault', loser: server };

    it('is legal once it bounces on the server half, then the receiver half; then the Rally plays on', () => {
      const ref = createReferee();
      ref.serve(server);
      expect(ref.serveResult).toBeNull();
      expect(ref.ballEvent(bounceOn(server))).toBeNull();
      expect(ref.serveResult).toBeNull();
      expect(ref.ballEvent(bounceOn(receiver))).toBeNull();
      expect(ref.serveResult).toBe('legal');
      // Then the receiver must return it, as after any Shot.
      expect(ref.ballEvent(OFF_TABLE)).toBeNull();
      expect(ref.noReturn()).toEqual({ end: 'unreturned', loser: receiver });
    });

    it('is legal and returned: the Return is judged as any Shot', () => {
      const ref = createReferee();
      ref.serve(server);
      ref.ballEvent(bounceOn(server));
      ref.ballEvent(bounceOn(receiver));
      ref.shot(receiver);
      expect(ref.ballEvent(bounceOn(receiver))).toEqual({ end: 'own-half', loser: receiver });
      expect(ref.serveResult).toBe('legal');
    });

    it('is a Fault whose first bounce is on the receiver half', () => {
      expect(refereeServe(server, [bounceOn(receiver)])).toMatchObject({ calls: [fault], result: 'fault', ended: fault });
    });

    it('is a Fault into the net, before or after its first bounce', () => {
      expect(refereeServe(server, [NET]).calls).toEqual([fault]);
      expect(refereeServe(server, [bounceOn(server), NET])).toMatchObject({ calls: [null, fault], result: 'fault' });
    });

    it('is a Fault off the table, before or after its first bounce', () => {
      expect(refereeServe(server, [OFF_TABLE]).calls).toEqual([fault]);
      expect(refereeServe(server, [bounceOn(server), OFF_TABLE]).calls).toEqual([null, fault]);
    });

    it('is a Fault that bounces twice on the server half', () => {
      const doubleBounce: BallEvent = { type: 'out', reason: 'double-bounce', position: at(server) };
      expect(refereeServe(server, [bounceOn(server), bounceOn(server), doubleBounce]).calls).toEqual([null, fault, null]);
    });

    it('is a Let that clips the net and then lands on the receiver half: no Point, and nothing more is judged', () => {
      const { ref, calls, result, ended } = refereeServe(server, [bounceOn(server), CORD, bounceOn(receiver)]);
      expect(calls).toEqual([null, null, null]);
      expect(result).toBe('let');
      expect(ended).toBeNull();
      expect(ref.ballEvent(bounceOn(receiver))).toBeNull();
      expect(ref.noReturn()).toBeNull();
      expect(ref.ended).toBeNull();
    });

    it('is a Fault that clips the net and then dies or drops back', () => {
      expect(refereeServe(server, [bounceOn(server), CORD, NET]).calls).toEqual([null, null, fault]);
      expect(refereeServe(server, [bounceOn(server), CORD, bounceOn(server)]).result).toBe('fault');
    });

    it('lets the receiver\'s chance pass before the Serve lands without ending anything, then calls it once the ball is done', () => {
      const ref = createReferee();
      ref.serve(server);
      expect(ref.noReturn()).toBeNull();
      expect(ref.ballEvent(bounceOn(server))).toBeNull();
      expect(ref.ballEvent(bounceOn(receiver))).toBeNull();
      expect(ref.ballEvent(OFF_TABLE)).toEqual({ end: 'unreturned', loser: receiver });
    });
  });

  it('has no Serve result in a Rally started with a Shot, and forgets it on reset()', () => {
    const ref = createReferee();
    ref.shot('opponent');
    expect(ref.ballEvent(bounceOn('player'))).toBeNull();
    expect(ref.serveResult).toBeNull();
    ref.reset();
    ref.serve('player');
    ref.ballEvent(bounceOn('opponent'));
    expect(ref.serveResult).toBe('fault');
    ref.reset();
    expect(ref.serveResult).toBeNull();
    expect(ref.ended).toBeNull();
  });
});

describe('lookAhead for a Serve', () => {
  it('finds the Ideal Time after the bounce on the server half, then the receiver half; a Shot look-ahead finds none', () => {
    // Bounces on the Opponent half, then carries on to the player half.
    const solution = solveServe(OPPONENT_SERVE_FROM, { bounce1: { x: 0, z: -0.6 }, target: { x: 0, z: 0.9 }, flightTime: 0.2, topspin: 0, sidespin: 0 })!;
    expect(solution).not.toBeNull();
    const ball = launchBall(OPPONENT_SERVE_FROM, solution.velocity, solution.spin, 3);
    const halves = eventsOf(ball).filter((e) => e.type === 'bounce').map((e) => (e.type === 'bounce' ? e.half : null));
    expect(halves.slice(0, 2)).toEqual(['opponent', 'player']);
    expect(lookAhead(ball, 'player')).toBeNull();
    const ahead = lookAhead(ball, 'player', { serve: true })!;
    expect(ahead).not.toBeNull();
    expect(ahead.ideal.position.z).toBeCloseTo(PLAYER_END_Z, 6);
    expect(ahead.strike.lastBounceHalf).toBe('player');
    // Mirrored, from the player's end.
    const mirrored = lookAhead(mirror(ball), 'opponent', { serve: true })!;
    expect(Math.abs(mirrored.ideal.simSeconds - ahead.ideal.simSeconds)).toBeLessThan(0.001);
  });

  it('finds none for a Serve whose first bounce is on the receiver half', () => {
    expect(lookAhead(solved({ x: 0, z: 0.8 }), 'player', { serve: true })).toBeNull();
  });
});
