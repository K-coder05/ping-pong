/**
 * The Rally (spec P2-b): any Shot heading to either side gets an Ideal Time
 * at the receiver's end, the receiver (player or Opponent) gets one chance to
 * return it, and a referee ends the Rally with its Rally End and loser. A
 * Match Rally starts with a Serve (spec P2-f1), which the referee judges
 * under the Serve rules first: legal, a Fault or a Let.
 *
 * Pure and headless: `findIdealTime` simulates a just-launched Shot ahead with
 * the same integrator as the live ball, and the referee only sees what it is
 * told (each Shot's launch, the ball's events, the receiver's missed chance).
 */

import type { ShotIntent } from './solver.ts';
import { simulate, type BallEvent, type BallState, type Vec3 } from './ball.ts';
import { OPPONENT_END_Z, PHYSICS_DT, PLAYER_END_Z } from './constants.ts';
import type { ServeIntent, ServeResult } from './serve.ts';
import { otherSide, type Side } from './side.ts';

/** When and where a Shot reaches the receiver's end of the table, after its bounce there. */
export interface IdealTime {
  /** Simulated seconds after launch. Convert to real time with `simSecondsToRealMs`. */
  simSeconds: number;
  /** Ball centre as it crosses the receiver's end line. */
  position: Vec3;
}

/** Longest look-ahead: any playable Shot reaches the receiver's end well inside this. */
const IDEAL_TIME_HORIZON_S = 4;

/** The receiver's end line: the player's at +z, the Opponent's at −z. */
function endLineZ(receiver: Side): number {
  return receiver === 'player' ? PLAYER_END_Z : OPPONENT_END_Z;
}

export interface LookAheadOptions {
  /**
   * The Shot is a Serve: its first bounce must be on the server's half (the
   * other side's), and the Ideal Time comes after its second, on the
   * receiver's half. It doesn't judge a Let: a Serve that clips the net and
   * lands legally still has an Ideal Time.
   */
  serve?: boolean;
}

/**
 * Simulate a just-launched Shot ahead to its Ideal Time, and the ball there
 * (the strike). Null if its first bounce isn't on the receiver's half (for a
 * Serve: the server's half, then the receiver's), or it never crosses the
 * receiver's end line while live (net, out, a second bounce).
 * The crossing is interpolated within its substep: the strike's position is
 * exactly the Ideal Time's; its velocity and Spin are the substep's end.
 */
export function lookAhead(ball: BallState, receiver: Side, options: LookAheadOptions = {}): { ideal: IdealTime; strike: BallState } | null {
  const endZ = endLineZ(receiver);
  // Distance past the end line, positive once crossed, for either direction.
  const past = (z: number) => (receiver === 'player' ? z - endZ : endZ - z);
  // The halves the Shot must bounce on, in order, before it is the receiver's to strike.
  const expected: Side[] = options.serve ? [otherSide(receiver), receiver] : [receiver];
  let bounces = 0;
  let previous = ball;
  let found: { ideal: IdealTime; strike: BallState } | null = null;
  simulate(ball, {
    maxTime: IDEAL_TIME_HORIZON_S,
    until: (state, time, events) => {
      const before = previous;
      previous = state;
      for (const event of events) {
        if (event.type !== 'bounce' || bounces >= expected.length) continue;
        if (event.half !== expected[bounces]) return true;
        bounces++;
      }
      if (state.status !== 'live') return true;
      if (bounces < expected.length || past(state.position.z) < 0) return false;
      const a = before.position;
      const b = state.position;
      const f = b.z === a.z ? 1 : Math.min(1, Math.max(0, (endZ - a.z) / (b.z - a.z)));
      const position = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f };
      found = { ideal: { simSeconds: time - (1 - f) * PHYSICS_DT, position }, strike: { ...state, position: { ...position } } };
      return true;
    },
  });
  return found;
}

/** When the Shot's centre crosses the receiver's end line after bouncing on the receiver's half; null if it never does. */
export function findIdealTime(ball: BallState, receiver: Side): IdealTime | null {
  return lookAhead(ball, receiver)?.ideal ?? null;
}

/** What a receiver needs to decide how to play an incoming Shot. */
export interface Incoming {
  readonly receiver: Side;
  /** The Shot at launch. */
  readonly ball: BallState;
  /** performance.now() at launch. */
  readonly launchedAtMs: number;
  readonly ideal: IdealTime;
  /** The Ideal Time on the performance.now() clock, converted with TIME_SCALE at launch. */
  readonly idealAtMs: number;
  /** The ball at the Ideal Time (position, velocity, Spin). */
  readonly strike: BallState;
  /** 0 = the Rally's first Shot. */
  readonly shotIndex: number;
}

/**
 * Why a Rally is over (GLOSSARY "Rally End"), so who loses the Point; plus
 * `fault`, a Serve that breaks the Serve rule (GLOSSARY "Fault"), against
 * the server. A Let is not a Rally End: no Point, the Serve is taken again.
 */
export type RallyEnd = 'net' | 'out' | 'own-half' | 'unreturned' | 'fault';

export type RallyEvent =
  /** A Shot launched; a Serve is Shot 0. */
  | { readonly type: 'shot'; readonly atMs: number; readonly by: Side; readonly shotIndex: number }
  | { readonly type: 'bounce'; readonly atMs: number; readonly half: Side }
  /**
   * The Serve's result, once called: `legal` at its bounce on the receiver's
   * half (the Rally plays on), `let` there after a Net-cord (the Rally is
   * void, served again), `fault` when it breaks the rule (an `end` follows).
   */
  | { readonly type: 'serve'; readonly atMs: number; readonly by: Side; readonly result: ServeResult }
  | { readonly type: 'end'; readonly atMs: number; readonly end: RallyEnd; readonly loser: Side };

export interface Opponent {
  /**
   * Called when a Shot toward the Opponent launches (ADR 0002); the choice is
   * applied at the Ideal Time, struck from `contactPoint(strike.position)`.
   */
  chooseShot(incoming: Incoming, random: () => number): ShotIntent | 'whiff';
  /**
   * Called when the Opponent serves: a Serve from OPPONENT_SERVE_FROM that
   * `solveServe` can solve, legal and clear of the net. The Opponent never
   * Faults.
   */
  chooseServe(random: () => number): ServeIntent;
}

/** The referee's call: the Rally End and the side that loses the Point. */
export interface RallyEndCall {
  readonly end: RallyEnd;
  readonly loser: Side;
}

/**
 * Pure referee for one Rally at a time. Tell it how the Rally starts (`serve`
 * in a Match, `shot` for a Feed), each later Shot's launch (`shot`), then
 * every event of the ball in play, in order (`ballEvent`), and when the
 * receiver's chance passes without a Return (`noReturn`: an Opponent Whiff, a
 * player Early, Late or Miss). Each returns the Rally End when it decides one.
 *
 * Serve rules (GLOSSARY "Serve", "Fault", "Let"):
 * - A Serve must bounce first on the server's half, then on the receiver's
 *   half. Anything else (a first bounce on the receiver's half, a second on
 *   the server's, the net, the ball leaving the table) is a `fault`, against
 *   the server, called at once.
 * - A Serve that clips the net (`cord`) and then lands on the receiver's half
 *   is a Let: no Rally End, `serveResult` is `let`, and the referee judges
 *   nothing more until `reset`.
 * - At its bounce on the receiver's half, a Serve is `legal` and is judged
 *   from there as any Shot that has bounced on the receiver's half.
 *
 * Shot rules:
 * - Before its first bounce, a Shot into the net is `net`, off the table is
 *   `out`, and a first bounce on the hitter's half is `own-half`: all against
 *   the hitter. A Net-cord (`cord`) plays on.
 * - After a first bounce on the receiver's half, the next bounce (on either
 *   half), the ball leaving the table or meeting the net is `unreturned`,
 *   against the receiver, but only once the receiver's chance has passed: a
 *   Swing in the Hit Window always strikes the ball (ADR 0001), even one
 *   that has dropped past the end of the table, and that new Shot cancels it.
 */
export interface Referee {
  /** The Rally End, once called; null while the Rally is on (and after a Let). */
  readonly ended: RallyEndCall | null;
  /** The Serve's result once called; null before, and in a Rally that didn't start with `serve`. */
  readonly serveResult: ServeResult | null;
  /** A Serve by `server` starts the Rally (after `reset`): judge it under the Serve rules. */
  serve(server: Side): void;
  /** A Shot launched by `by` (a Feed as Shot 0, or any later Shot): judge it from here on. */
  shot(by: Side): void;
  /** One event of the ball in play since its Shot launched. */
  ballEvent(event: BallEvent): RallyEndCall | null;
  /** The receiver's chance at the current Shot passed with no Return. */
  noReturn(): RallyEndCall | null;
  /** Forget the Rally, for the next one. */
  reset(): void;
}

export function createReferee(): Referee {
  let ended: RallyEndCall | null = null;
  let hitter: Side | null = null;
  /** The current Shot has bounced on the receiver's half. */
  let bounced = false;
  /** After that bounce, the ball has bounced again, left the table or met the net. */
  let ballDone = false;
  /** The receiver's chance has passed. */
  let chanceOver = false;
  /** While a Serve is being judged: how far it has got under the Serve rules. */
  let serving: { bouncedOwnHalf: boolean; corded: boolean } | null = null;
  let serveResult: ServeResult | null = null;

  function end(rallyEnd: RallyEnd, loser: Side): RallyEndCall {
    ended = { end: rallyEnd, loser };
    return ended;
  }

  function unreturnedIfDue(): RallyEndCall | null {
    return ballDone && chanceOver && hitter ? end('unreturned', otherSide(hitter)) : null;
  }

  /** The Serve rules, until the Serve is legal. */
  function judgeServe(server: Side, event: BallEvent, serve: { bouncedOwnHalf: boolean; corded: boolean }): RallyEndCall | null {
    const fault = () => {
      serving = null;
      serveResult = 'fault';
      return end('fault', server);
    };
    if (event.type === 'cord') {
      serve.corded = true;
      return null;
    }
    if (event.type !== 'bounce') return fault();
    if (!serve.bouncedOwnHalf) {
      if (event.half !== server) return fault();
      serve.bouncedOwnHalf = true;
      return null;
    }
    if (event.half === server) return fault();
    serving = null;
    serveResult = serve.corded ? 'let' : 'legal';
    bounced = true;
    return null;
  }

  return {
    get ended() {
      return ended;
    },
    get serveResult() {
      return serveResult;
    },
    serve(server) {
      if (ended) return;
      hitter = server;
      bounced = false;
      ballDone = false;
      chanceOver = false;
      serving = { bouncedOwnHalf: false, corded: false };
      serveResult = null;
    },
    shot(by) {
      if (ended || serveResult === 'let') return;
      hitter = by;
      bounced = false;
      ballDone = false;
      chanceOver = false;
      serving = null;
    },
    ballEvent(event) {
      if (ended || serveResult === 'let' || !hitter) return null;
      if (serving) return judgeServe(hitter, event, serving);
      if (event.type === 'cord') return null;
      if (!bounced) {
        if (event.type === 'net') return end('net', hitter);
        if (event.type === 'out') return end('out', hitter);
        if (event.half === hitter) return end('own-half', hitter);
        bounced = true;
        return null;
      }
      ballDone = true;
      return unreturnedIfDue();
    },
    noReturn() {
      if (ended || serveResult === 'let' || !hitter) return null;
      chanceOver = true;
      return unreturnedIfDue();
    },
    reset() {
      ended = null;
      hitter = null;
      bounced = false;
      ballDone = false;
      chanceOver = false;
      serving = null;
      serveResult = null;
    },
  };
}
