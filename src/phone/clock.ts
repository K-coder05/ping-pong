/**
 * Clock sync and link stats (docs/specs/p3.md, P3-d): put the Phone's
 * timestamps on the laptop's clock, NTP-style, over the reliable control
 * channel, and summarise how the motion stream is arriving.
 *
 * 1. The laptop sends `ping { t0 }`; the Phone answers `pong { t0, t1, t2 }`
 *    with its receive and send times (`answerPings`); the laptop notes the
 *    arrival time t3.
 * 2. Per sample: offset θ = ((t1 − t0) + (t2 − t3)) / 2 and round trip
 *    δ = (t3 − t0) − (t2 − t1). A sample's θ is wrong by at most δ / 2, so
 *    short round trips are the trustworthy ones.
 * 3. A round collects `samples` (20) answers one after another, keeps the
 *    quarter with the smallest δ and takes their median θ (`estimateOffset`).
 * 4. The first WARMUP_ROUNDS rounds run back to back and are averaged. After
 *    that a round runs every `resyncMs` (10 s) and is blended in gradually,
 *    together with a slowly learned drift rate, so a steady drift is followed
 *    without lagging behind it.
 * 5. `toLocal(tPhone) = tPhone − θ`, with θ carried forward by the drift rate.
 *
 * Time comes from the injected `now`; timers from the injected `schedule`
 * (default `setTimeout`), so the tests drive both on a simulated link.
 */
import type { ControlMessage, PhoneLink } from './types.ts';

/** Structurally the Phone Input's `ClockOffset` (`src/input/phoneInput.ts`, P3-c): a ClockSync can be passed wherever that is wanted. */
export interface ClockOffset {
  toLocal(tPhone: number): number;
}

/** Run `fn` after `ms`; returns a function that cancels it. */
export type Schedule = (fn: () => void, ms: number) => () => void;

export interface ClockSyncOptions {
  /** Answers per round. Default 20. */
  samples: number;
  /** ms from the end of one round to the start of the next, after the warm-up. Default 10,000. */
  resyncMs: number;
  /** Default `setTimeout`. */
  schedule?: Schedule;
}

const DEFAULTS: ClockSyncOptions = { samples: 20, resyncMs: 10_000 };

/** ms between one answer and the next ping, so a round's pings don't all queue behind the same burst of Wi-Fi traffic. */
const PING_GAP_MS = 25;
/** ms to wait for an answer before pinging again; the control channel is reliable, so this only happens while the link is down. */
const PONG_TIMEOUT_MS = 1000;
/**
 * One round is noisy: with random 0–30 ms delays each way its error is about
 * 1.7 ms typically, 5 ms at the 95th percentile and up to 10 ms. So the first
 * WARMUP_ROUNDS run back to back, WARMUP_GAP_MS apart, and are averaged: a
 * good estimate within about 8 s of connecting (a usable one after the first
 * answer).
 */
const WARMUP_ROUNDS = 5;
const WARMUP_GAP_MS = 500;
/**
 * The blend after the warm-up, an alpha-beta filter on the round estimates:
 * each round moves the offset by BLEND of its surprise (the round's estimate
 * minus the offset carried forward by the drift rate), and the drift rate by
 * DRIFT_BLEND of that surprise per ms since the last round.
 *
 * A plain blend of the offset alone lags a 50 ppm drift (0.55 ms per round)
 * by drift-per-round × (1 − BLEND) / BLEND, 1.3 ms at 0.3, and it is the lag
 * plus the noise that breaks 5 ms. Learning the rate removes the lag, so the
 * offset blend can be heavier on noise: 0.2 keeps about 0.4 of a round's
 * error. In a 300-seed sweep of the simulated 50 ppm, 0–30 ms link, a plain
 * blend went past 5 ms at some moment in 4–6% of runs, this one in about 1%.
 */
const BLEND = 0.2;
const DRIFT_BLEND = 0.04;
/**
 * A round that disagrees with the estimate by more than this (or by more than
 * its own round trip, whichever is larger) is not drift: the Phone's clock
 * restarted, e.g. the page reloaded. Take it at once instead of blending.
 */
const SNAP_MIN_MS = 20;

const defaultSchedule: Schedule = (fn, ms) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

interface Sample {
  theta: number;
  delta: number;
}

/** The laptop's estimate of the Phone's clock. Before the first round finishes it uses the shortest round trip seen so far; before any answer, an offset of 0. */
export class ClockSync implements ClockOffset {
  private readonly link: PhoneLink;
  private readonly now: () => number;
  private readonly opts: ClockSyncOptions;
  private readonly schedule: Schedule;
  /** ms, the offset at laptop time `tAnchor`, changing at `drift` ms per ms. */
  private theta = 0;
  private tAnchor = 0;
  private drift = 0;
  private rtt = NaN;
  /** Rounds in the estimate since the first (or since a jump). */
  private rounds = 0;
  private round: Sample[] = [];
  private pendingT0: number | null = null;
  private cancelTimer: (() => void) | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(link: PhoneLink, now: () => number, opts?: Partial<ClockSyncOptions>) {
    this.link = link;
    this.now = now;
    this.opts = { ...DEFAULTS, ...opts };
    this.schedule = this.opts.schedule ?? defaultSchedule;
  }

  /** Start a round now, then keep re-syncing. Keeps the current estimate, so a restart after a short drop needs no warm-up. */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.link.onControl((m) => this.onControl(m));
    this.beginRound();
  }

  /** Stop pinging. The estimate stays available. */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clearTimer();
    this.pendingT0 = null;
    this.round = [];
  }

  /** ms, the Phone's clock minus the laptop's, now. */
  offsetMs(): number {
    return this.offsetAt(this.now());
  }

  /** ms, median round trip of the samples kept from the last round (NaN before any answer). */
  rttMs(): number {
    return this.rtt;
  }

  /** Whether a full round has finished. */
  isSynced(): boolean {
    return this.rounds > 0;
  }

  /** A Phone time on the laptop's clock. */
  toLocal(tPhone: number): number {
    return tPhone - this.offsetAt(tPhone - this.theta);
  }

  private offsetAt(tLocal: number): number {
    return this.theta + this.drift * (tLocal - this.tAnchor);
  }

  private beginRound() {
    this.round = [];
    this.ping();
  }

  private ping() {
    const t0 = this.now();
    this.pendingT0 = t0;
    this.link.sendControl({ type: 'ping', t0 });
    this.setTimer(() => this.ping(), PONG_TIMEOUT_MS);
  }

  private onControl(m: ControlMessage) {
    // Only the answer to the ping in flight: a late or stray pong says nothing about now.
    if (m.type !== 'pong' || this.pendingT0 === null || m.t0 !== this.pendingT0) return;
    const t3 = this.now();
    this.pendingT0 = null;
    this.clearTimer();
    this.round.push(clockSample(m.t0, m.t1, m.t2, t3));
    if (this.rounds === 0) {
      const best = this.round.reduce((a, b) => (b.delta < a.delta ? b : a));
      this.theta = best.theta;
      this.tAnchor = t3;
      this.rtt = best.delta;
    }
    if (this.round.length < this.opts.samples) {
      this.setTimer(() => this.ping(), PING_GAP_MS);
      return;
    }
    this.finishRound(t3);
    this.setTimer(() => this.beginRound(), this.rounds < WARMUP_ROUNDS ? WARMUP_GAP_MS : this.opts.resyncMs);
  }

  private finishRound(t: number) {
    const est = estimateOffset(this.round);
    this.round = [];
    const predicted = this.offsetAt(t);
    const surprise = est.offsetMs - predicted;
    if (this.rounds === 0 || Math.abs(surprise) > Math.max(SNAP_MIN_MS, est.rttMs)) {
      this.theta = est.offsetMs;
      this.drift = 0;
      this.rounds = 1;
    } else if (++this.rounds <= WARMUP_ROUNDS) {
      this.theta = predicted + surprise / this.rounds; // the mean of the rounds so far
    } else {
      this.theta = predicted + BLEND * surprise;
      this.drift += (DRIFT_BLEND * surprise) / (t - this.tAnchor);
    }
    this.tAnchor = t;
    this.rtt = est.rttMs;
  }

  private setTimer(fn: () => void, ms: number) {
    this.clearTimer();
    this.cancelTimer = this.schedule(fn, ms);
  }

  private clearTimer() {
    this.cancelTimer?.();
    this.cancelTimer = null;
  }
}

/** One ping's offset θ and round trip δ, from the laptop's send and receive times (t0, t3) and the Phone's (t1, t2). */
export function clockSample(t0: number, t1: number, t2: number, t3: number): Sample {
  return { theta: (t1 - t0 + (t2 - t3)) / 2, delta: t3 - t0 - (t2 - t1) };
}

/** A round's estimate: the median θ and δ of the quarter of samples with the smallest δ. */
export function estimateOffset(samples: readonly Sample[]): { offsetMs: number; rttMs: number } {
  const kept = [...samples].sort((a, b) => a.delta - b.delta).slice(0, Math.max(1, Math.round(samples.length / 4)));
  return { offsetMs: median(kept.map((s) => s.theta)), rttMs: median(kept.map((s) => s.delta)) };
}

/**
 * Phone side: answer each `ping` with `pong { t0, t1: receive time, t2: send
 * time }`. `t1` is the link's receive stamp. Returns a function that stops.
 */
export function answerPings(link: PhoneLink, now: () => number): () => void {
  return link.onControl((m, tRecv) => {
    if (m.type === 'ping') link.sendControl({ type: 'pong', t0: m.t0, t1: tRecv, t2: now() });
  });
}

export interface LinkStats {
  /** ms, one-way delay from the Phone's motion event to the laptop receiving it, median and 95th percentile (NaN with no packets). */
  oneWayP50: number;
  oneWayP95: number;
  /** % of packets missing from the window's `seq` range. */
  lossPct: number;
  /** The Phone's sample rate in Hz, from `seq` and `tPhone`, so lost packets don't lower it. */
  rateHz: number;
}

/**
 * Stats for a window of received packets (any order; the motion channel is
 * unordered). The one-way delay is `tRecv − sync.toLocal(tPhone)`, so it is
 * only as good as the clock sync.
 */
export function linkStats(window: readonly { tPhone: number; tRecv: number; seq: number }[], sync: ClockOffset): LinkStats {
  if (window.length === 0) return { oneWayP50: NaN, oneWayP95: NaN, lossPct: 0, rateHz: 0 };
  const delays = window.map((w) => w.tRecv - sync.toLocal(w.tPhone)).sort((a, b) => a - b);
  const bySeq = [...window].sort((a, b) => a.seq - b.seq);
  const first = bySeq[0]!;
  const last = bySeq[bySeq.length - 1]!;
  const expected = last.seq - first.seq + 1;
  const received = new Set(window.map((w) => w.seq)).size;
  const span = last.tPhone - first.tPhone;
  return {
    oneWayP50: percentile(delays, 0.5),
    oneWayP95: percentile(delays, 0.95),
    lossPct: (100 * (expected - received)) / expected,
    rateHz: span > 0 ? ((last.seq - first.seq) * 1000) / span : 0,
  };
}

/** Nearest-rank percentile of an ascending, non-empty list. */
function percentile(sorted: readonly number[], q: number): number {
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil(q * sorted.length))) - 1]!;
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
