/**
 * The Phone page coming back to its room (docs/specs/p3.md, P3-e §2). When
 * the page hides (the Phone locks or the player switches app) it leaves the
 * room, so the laptop pauses at once; when it shows again, or its link drops
 * while it is showing, it joins the same room again, after a short wait that
 * grows with each failed try. A reloaded page finds its room in `?room=`.
 * Pure; `phonePage.ts` does the DOM side.
 */
import type { LinkError } from './link.ts';

/** ms before each try in a row at rejoining: the first soon, then backing off. */
export const REJOIN_DELAYS_MS: readonly number[] = [250, 1000, 2000, 4000];

/** ms to wait before rejoin try number `attempt` (0 = the first since the link was last up). */
export function rejoinDelayMs(attempt: number): number {
  return REJOIN_DELAYS_MS[Math.min(Math.max(0, attempt), REJOIN_DELAYS_MS.length - 1)]!;
}

/**
 * Whether to keep trying after this error. The server unreachable, or the
 * room still holding this Phone's old connection for a moment, pass; a room
 * that is gone or a code that is wrong won't, so the page stops and shows the
 * room code box.
 */
export function keepRejoining(e: LinkError): boolean {
  return e === 'socket-closed' || e === 'room-full';
}

/** The page's address with `?room=<code>`, so a reload joins the same room. Keeps the rest of the query and the hash. */
export function urlWithRoom(href: string, code: string): string {
  const url = new URL(href);
  url.searchParams.set('room', code);
  return url.toString();
}
