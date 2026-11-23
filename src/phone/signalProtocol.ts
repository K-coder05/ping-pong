/**
 * The signaling protocol between the pages and `server/signal.ts`
 * (docs/specs/p3.md, P3-a): JSON messages over one WebSocket per page.
 * Pure, so the server (run by Node) and the pages share it.
 *
 *   page → server   { type: 'create' }                 laptop: make a room
 *                   { type: 'join', room }              Phone: enter a room
 *                   { type: 'signal', data }            forwarded to the other peer
 *   server → page   { type: 'created', room }           to the laptop
 *                   { type: 'joined', room }            to the Phone
 *                   { type: 'peer-joined' }             to the peer already in the room
 *                   { type: 'peer-left' }               to the peer still in the room
 *                   { type: 'signal', data }            from the other peer
 *                   { type: 'error', code }             the request failed; the socket stays open
 */

/** Room code characters: no look-alikes (0/O, 1/I/L). */
export const ROOM_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const ROOM_CODE_LENGTH = 5;

/** A room code from `randomInt(n)`, which returns an integer in [0, n). */
export function makeRoomCode(randomInt: (n: number) => number): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)];
  return code;
}

/** Uppercase and drop spaces and dashes, as typed on a Phone. */
export function normalizeRoomCode(typed: string): string {
  return typed.toUpperCase().replace(/[\s-]/g, '');
}

export function isRoomCode(s: unknown): s is string {
  if (typeof s !== 'string' || s.length !== ROOM_CODE_LENGTH) return false;
  for (const c of s) if (!ROOM_ALPHABET.includes(c)) return false;
  return true;
}

export type SignalErrorCode =
  | 'bad-message' // not JSON, or an unknown type
  | 'bad-room' // not a valid room code
  | 'no-room' // valid code, but no such room (or it expired)
  | 'room-full' // already 2 peers
  | 'already-in-room' // this socket already created or joined a room
  | 'no-peer'; // signal sent with nobody else in the room

export type ClientMessage =
  | { type: 'create' }
  | { type: 'join'; room: string }
  | { type: 'signal'; data: unknown };

export type ServerMessage =
  | { type: 'created'; room: string }
  | { type: 'joined'; room: string }
  | { type: 'peer-joined' }
  | { type: 'peer-left' }
  | { type: 'signal'; data: unknown }
  | { type: 'error'; code: SignalErrorCode };

/** Parse a client message, or null when it isn't one. */
export function parseClientMessage(text: string): ClientMessage | null {
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof m !== 'object' || m === null) return null;
  const o = m as Record<string, unknown>;
  switch (o.type) {
    case 'create':
      return { type: 'create' };
    case 'join':
      return { type: 'join', room: typeof o.room === 'string' ? o.room : '' };
    case 'signal':
      return 'data' in o ? { type: 'signal', data: o.data } : null;
    default:
      return null;
  }
}
