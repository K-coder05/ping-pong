/**
 * Relay fallback decisions (docs/specs/p3.md, P3-e §1; ADR 0004): when the
 * peer-to-peer link can't carry motion, `link.ts` switches to relay and the
 * Phone's packets go through the signaling server instead.
 *
 * - The 5 s rule: the data channels aren't open `openTimeoutMs` (5,000) after
 *   signaling with the other page starts.
 * - The 3 s rule: they were open, closed, and didn't reopen within
 *   `reopenTimeoutMs` (3,000).
 *
 * Also the Phone's relay pacing: the server takes at most 100 relayed motion
 * packets per second per room (`server/signal.ts`), so the Phone sends no more
 * than `RELAY_MOTION_HZ`, spread evenly, instead of letting the server cut
 * whole stretches out of a faster stream.
 *
 * Pure: time comes from the injected `now`, timers from the injected `schedule`.
 */
import type { Schedule } from './clock.ts';

export const OPEN_TIMEOUT_MS = 5000;
export const REOPEN_TIMEOUT_MS = 3000;

/** Why the link switched to relay. */
export type RelayReason = 'never-opened' | 'not-reopened';

/**
 * - `idle`: no other page to talk to.
 * - `opening`: signaling started; waiting for the channels to open (the 5 s rule).
 * - `open`: peer to peer works.
 * - `reopening`: the channels closed; waiting for them to reopen (the 3 s rule).
 * - `relay`: gave up on peer to peer.
 */
export type FallbackState = 'idle' | 'opening' | 'open' | 'reopening' | 'relay';

export interface FallbackOptions {
  now: () => number;
  schedule: Schedule;
  /** ms. Default `OPEN_TIMEOUT_MS`. */
  openTimeoutMs?: number;
  /** ms. Default `REOPEN_TIMEOUT_MS`. */
  reopenTimeoutMs?: number;
}

export interface Fallback {
  /** Signaling with the other page started (it joined the room): the channels have `openTimeoutMs` to open. Restarts from any state. */
  started(): void;
  /** The data channels are open. */
  opened(): void;
  /** They closed. After being open, they have `reopenTimeoutMs` to reopen; before, the 5 s rule keeps running. */
  closed(): void;
  /** Stop waiting, back to `idle`: the other page left, this page closed it, or the other page already switched to relay. */
  cancel(): void;
  state(): FallbackState;
}

/** `onRelay` runs once each time the fallback gives up on peer to peer. */
export function createFallback(opts: FallbackOptions, onRelay: (reason: RelayReason) => void): Fallback {
  const openTimeoutMs = opts.openTimeoutMs ?? OPEN_TIMEOUT_MS;
  const reopenTimeoutMs = opts.reopenTimeoutMs ?? REOPEN_TIMEOUT_MS;
  let state: FallbackState = 'idle';
  let cancelTimer: (() => void) | null = null;

  const clearTimer = () => {
    cancelTimer?.();
    cancelTimer = null;
  };

  /** Switch at `deadline` unless something else happens first. Re-arms if the timer fires early. */
  const waitUntil = (deadline: number, reason: RelayReason) => {
    clearTimer();
    const arm = () => {
      cancelTimer = opts.schedule(() => {
        cancelTimer = null;
        if (opts.now() < deadline) return arm();
        state = 'relay';
        onRelay(reason);
      }, Math.max(0, deadline - opts.now()));
    };
    arm();
  };

  return {
    started: () => {
      state = 'opening';
      waitUntil(opts.now() + openTimeoutMs, 'never-opened');
    },
    opened: () => {
      if (state !== 'opening' && state !== 'reopening') return;
      clearTimer();
      state = 'open';
    },
    closed: () => {
      if (state !== 'open') return;
      state = 'reopening';
      waitUntil(opts.now() + reopenTimeoutMs, 'not-reopened');
    },
    cancel: () => {
      clearTimer();
      state = 'idle';
    },
    state: () => state,
  };
}

/** Relayed motion packets per second the Phone sends at most: under the server's 100, with room for the burst. */
export const RELAY_MOTION_HZ = 90;
/** Packets that may go back to back after a pause, so ordinary timer jitter drops nothing. */
const RELAY_BURST = 4;

/**
 * A token bucket: `allow(t)` says whether a motion packet at `t` (ms) may be
 * relayed. Over any second it allows at most `hz + burst` packets, evenly
 * spread when the Phone samples faster than `hz`, and all of them when it
 * samples slower.
 */
export function createRelayPacer(hz = RELAY_MOTION_HZ, burst = RELAY_BURST): { allow(t: number): boolean } {
  let tokens = burst;
  let last: number | null = null;
  return {
    allow(t) {
      if (last !== null) tokens = Math.min(burst, tokens + (Math.max(0, t - last) * hz) / 1000);
      last = t;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}
