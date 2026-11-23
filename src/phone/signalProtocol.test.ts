import { describe, expect, it } from 'vitest';
import { makeRng } from '../util/rng.ts';
import {
  ROOM_ALPHABET,
  isRoomCode,
  makeRoomCode,
  normalizeRoomCode,
  parseClientMessage,
} from './signalProtocol.ts';

describe('room codes', () => {
  it('have no look-alike characters', () => {
    for (const c of '0O1IL') expect(ROOM_ALPHABET).not.toContain(c);
  });

  it('are 5 characters from the alphabet', () => {
    const rng = makeRng(7);
    for (let i = 0; i < 200; i++) {
      const code = makeRoomCode((n) => Math.floor(rng() * n));
      expect(code).toHaveLength(5);
      expect(isRoomCode(code)).toBe(true);
    }
  });

  it('rejects wrong lengths, look-alikes and non-strings', () => {
    expect(isRoomCode('ABCD')).toBe(false);
    expect(isRoomCode('ABCDEF')).toBe(false);
    expect(isRoomCode('ABCD0')).toBe(false);
    expect(isRoomCode('abcde')).toBe(false);
    expect(isRoomCode(12345)).toBe(false);
  });

  it('normalizes a typed code', () => {
    expect(normalizeRoomCode(' ab-cd e ')).toBe('ABCDE');
  });
});

describe('parseClientMessage', () => {
  it('parses the three messages', () => {
    expect(parseClientMessage('{"type":"create"}')).toEqual({ type: 'create' });
    expect(parseClientMessage('{"type":"join","room":"ABCDE"}')).toEqual({ type: 'join', room: 'ABCDE' });
    expect(parseClientMessage('{"type":"signal","data":{"x":1}}')).toEqual({ type: 'signal', data: { x: 1 } });
  });

  it('returns null for garbage', () => {
    expect(parseClientMessage('not json')).toBeNull();
    expect(parseClientMessage('null')).toBeNull();
    expect(parseClientMessage('{"type":"nope"}')).toBeNull();
    expect(parseClientMessage('{"type":"signal"}')).toBeNull();
  });
});
