import { describe, expect, it } from 'vitest';
import { createPhonePresence, PHONE_AWAY_MS, PHONE_BACK_MS, watchPhonePresence } from './presence.ts';
import type { LinkStatus, MotionPacket, PhoneLink } from './types.ts';

const FRAME_MS = 1000 / 60;

describe('createPhonePresence', () => {
  it('is away until the Phone sends, and back once packets have kept coming for PHONE_BACK_MS', () => {
    const p = createPhonePresence();
    expect(p.away).toBe(true);
    expect(p.update({ status: 'connected', lastPacketAt: -Infinity }, 0)).toBe(true);
    expect(p.update({ status: 'connected', lastPacketAt: 100 }, 100)).toBe(true);
    expect(p.update({ status: 'connected', lastPacketAt: 100 + PHONE_BACK_MS - 1 }, 100 + PHONE_BACK_MS - 1)).toBe(true);
    expect(p.update({ status: 'connected', lastPacketAt: 100 + PHONE_BACK_MS }, 100 + PHONE_BACK_MS)).toBe(false);
  });

  it('goes away at once when the link goes down (the Phone page locked, hid or reloaded)', () => {
    const p = createPhonePresence();
    p.update({ status: 'connected', lastPacketAt: 0 }, 0);
    p.update({ status: 'connected', lastPacketAt: 500 }, 500);
    expect(p.away).toBe(false);
    for (const status of ['disconnected', 'connecting', 'waiting', 'idle'] as LinkStatus[]) {
      const q = createPhonePresence();
      q.update({ status: 'relay', lastPacketAt: 0 }, 0);
      q.update({ status: 'relay', lastPacketAt: 500 }, 500);
      expect(q.update({ status, lastPacketAt: 510 }, 510)).toBe(true);
    }
  });

  it('goes away when no packet arrives for PHONE_AWAY_MS on a link that still looks up', () => {
    const p = createPhonePresence();
    p.update({ status: 'connected', lastPacketAt: 0 }, 0);
    p.update({ status: 'connected', lastPacketAt: 400 }, 400);
    expect(p.update({ status: 'connected', lastPacketAt: 400 }, 400 + PHONE_AWAY_MS)).toBe(false);
    expect(p.update({ status: 'connected', lastPacketAt: 400 }, 401 + PHONE_AWAY_MS)).toBe(true);
  });

  it('remembers when the Phone went away, until it is back', () => {
    const p = createPhonePresence();
    p.update({ status: 'waiting', lastPacketAt: -Infinity }, 50);
    expect(p.awaySince).toBe(50);
    p.update({ status: 'connected', lastPacketAt: 100 }, 100);
    p.update({ status: 'connected', lastPacketAt: 400 }, 400);
    expect(p.awaySince).toBeNull();
    p.update({ status: 'disconnected', lastPacketAt: 400 }, 700);
    p.update({ status: 'disconnected', lastPacketAt: 400 }, 9000);
    expect(p.awaySince).toBe(700);
  });

  it('counts relay as up, and a packet gap shorter than PHONE_AWAY_MS as still there', () => {
    const p = createPhonePresence();
    p.update({ status: 'relay', lastPacketAt: 0 }, 0);
    p.update({ status: 'relay', lastPacketAt: 300 }, 300);
    expect(p.update({ status: 'relay', lastPacketAt: 300 }, 1200)).toBe(false);
  });

  it('a link that drops again before PHONE_BACK_MS starts the wait for its return over', () => {
    const p = createPhonePresence();
    p.update({ status: 'connected', lastPacketAt: 0 }, 0);
    p.update({ status: 'disconnected', lastPacketAt: 0 }, 200);
    p.update({ status: 'disconnected', lastPacketAt: 0 }, 250);
    expect(p.update({ status: 'connected', lastPacketAt: 300 }, 300)).toBe(true);
    expect(p.update({ status: 'connected', lastPacketAt: 400 }, 400)).toBe(true);
    expect(p.update({ status: 'disconnected', lastPacketAt: 400 }, 410)).toBe(true);
    expect(p.update({ status: 'connected', lastPacketAt: 420 }, 420)).toBe(true);
    expect(p.update({ status: 'connected', lastPacketAt: 420 + PHONE_BACK_MS - 1 }, 420 + PHONE_BACK_MS - 1)).toBe(true);
    expect(p.update({ status: 'connected', lastPacketAt: 420 + PHONE_BACK_MS }, 420 + PHONE_BACK_MS)).toBe(false);
  });
});

/** A link whose status and packets the test drives. */
function fakeLink() {
  let status: LinkStatus = 'waiting';
  const packetCbs = new Set<(p: MotionPacket, tRecv: number) => void>();
  const packet: MotionPacket = { seq: 0, tPhone: 0, rot: [0, 0, 0], acc: [0, 9.8, 0], ori: [0, 0, 0] };
  const link: PhoneLink = {
    status: () => status,
    onStatus: () => () => {},
    onPacket: (cb) => (packetCbs.add(cb), () => packetCbs.delete(cb)),
    onControl: () => () => {},
    sendPacket: () => {},
    sendControl: () => {},
    close: () => {},
  };
  return {
    link,
    setStatus: (s: LinkStatus) => (status = s),
    deliver: (tRecv: number) => {
      for (const cb of packetCbs) cb({ ...packet, seq: packet.seq++ }, tRecv);
    },
  };
}

describe('watchPhonePresence', () => {
  it('follows the link: away while it is down or silent, back once it streams again', () => {
    let now = 0;
    const fake = fakeLink();
    const presence = watchPhonePresence(fake.link, () => now);
    const streamFor = (ms: number) => {
      for (const end = now + ms; now < end; now += FRAME_MS) {
        fake.deliver(now);
        void presence.away; // read every frame, as the game does
      }
    };
    fake.setStatus('connected');
    streamFor(500);
    expect(presence.away).toBe(false);
    fake.setStatus('disconnected'); // the Phone page went to the background
    expect(presence.away).toBe(true);
    now += 5000;
    fake.setStatus('connected'); // back in the same room
    expect(presence.away).toBe(true);
    streamFor(PHONE_BACK_MS + FRAME_MS);
    expect(presence.away).toBe(false);
  });
});
