import { describe, expect, it } from 'vitest';
import { keepRejoining, rejoinDelayMs, urlWithRoom } from './rejoin.ts';

describe('rejoinDelayMs', () => {
  it('tries soon first, then backs off to at most 4 s', () => {
    expect([0, 1, 2, 3, 4, 50].map(rejoinDelayMs)).toEqual([250, 1000, 2000, 4000, 4000, 4000]);
  });
});

describe('keepRejoining', () => {
  it('keeps trying while the server is unreachable or still holds the old connection; stops when the room is gone', () => {
    expect(keepRejoining('socket-closed')).toBe(true);
    expect(keepRejoining('room-full')).toBe(true);
    for (const e of ['no-room', 'bad-room', 'already-in-room', 'bad-message', 'no-peer'] as const) expect(keepRejoining(e)).toBe(false);
  });
});

describe('urlWithRoom', () => {
  it('puts the room code in the query, so a reload joins the same room', () => {
    expect(urlWithRoom('https://host/ping-pong/phone.html', 'AB234')).toBe('https://host/ping-pong/phone.html?room=AB234');
    expect(urlWithRoom('https://host/phone.html?room=ZZZZZ&x=1#h', 'AB234')).toBe('https://host/phone.html?room=AB234&x=1#h');
  });
});
