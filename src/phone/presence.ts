/**
 * Phone presence (docs/specs/p3.md, P3-e §2): whether the paired Phone is
 * there to play with, for the disconnect pause. The game reads `away` every
 * frame, the same way it reads whether the Camera has lost the hand, and
 * pauses (with "Phone disconnected: unlock your phone") while it is true.
 *
 * The Phone is away when its link is not up (`connected` or `relay`), which
 * is how a Phone page that locks, goes to the background or reloads shows up
 * (it closes its link, or the server says `peer-left`), or when no motion
 * packet has arrived for PHONE_AWAY_MS (a Phone that froze without a word).
 * It is back once its link is up and packets have kept arriving for
 * PHONE_BACK_MS, so one stray packet doesn't end the pause; the game's own
 * wait and "3, 2, 1" then come before the next Feed or Serve, which also
 * gives the clock sync time to answer.
 *
 * `createPhonePresence` is the pure part (time is passed in);
 * `watchPhonePresence` wires it to a `PhoneLink` and a `now`.
 */
import type { LinkStatus, PhoneLink } from './types.ts';

/** ms with no motion packet before the Phone counts as away. */
export const PHONE_AWAY_MS = 1000;
/** ms of packets arriving again before an away Phone counts as back. */
export const PHONE_BACK_MS = 300;

export interface PresenceObservation {
  /** The link's status now. */
  status: LinkStatus;
  /** Laptop ms when the latest motion packet arrived; -Infinity before any. */
  lastPacketAt: number;
}

export interface PhonePresence {
  /** Advance to `nowMs` with what the link shows; returns whether the Phone is away. Cheap; call every frame. */
  update(obs: PresenceObservation, nowMs: number): boolean;
  /** As of the last `update`. Away until the Phone first sends. */
  readonly away: boolean;
  /** As of the last `update`: laptop ms when the Phone went away (the first update, if it never came), or null while present. */
  readonly awaySince: number | null;
}

export function createPhonePresence(): PhonePresence {
  let away = true;
  let awaySince: number | null = null;
  /** While away: when packets started arriving again on an up link, or null. */
  let backSince: number | null = null;
  return {
    update({ status, lastPacketAt }, nowMs) {
      const flowing = (status === 'connected' || status === 'relay') && nowMs - lastPacketAt <= PHONE_AWAY_MS;
      if (!away) {
        if (!flowing) {
          away = true;
          awaySince = nowMs;
          backSince = null;
        }
      } else if (!flowing) backSince = null;
      else {
        backSince ??= nowMs;
        if (nowMs - backSince >= PHONE_BACK_MS) {
          away = false;
          awaySince = null;
          backSince = null;
        }
      }
      if (away) awaySince ??= nowMs;
      return away;
    },
    get away() {
      return away;
    },
    get awaySince() {
      return awaySince;
    },
  };
}

/** Presence on a live link: `away` is worked out from the link's status and packets each time it is read. */
export function watchPhonePresence(link: PhoneLink, now: () => number): { readonly away: boolean; readonly awayMs: number } {
  const presence = createPhonePresence();
  let lastPacketAt = -Infinity;
  link.onPacket((_p, tRecv) => {
    lastPacketAt = tRecv;
  });
  return {
    get away() {
      return presence.update({ status: link.status(), lastPacketAt }, now());
    },
    /** ms the Phone has been away, or 0 while present. */
    get awayMs() {
      const t = now();
      presence.update({ status: link.status(), lastPacketAt }, t);
      return presence.awaySince === null ? 0 : t - presence.awaySince;
    },
  };
}
