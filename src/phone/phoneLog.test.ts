import { describe, expect, it } from 'vitest';
import { createPhoneLogRecorder, parsePhoneLog } from './phoneLog.ts';
import type { MotionPacket } from './types.ts';

const packet = (seq: number): MotionPacket => ({
  seq,
  tPhone: 1000.5 + seq * 16.7,
  rot: [-12.5, 340, 0.25],
  acc: [0.1, -9.81, 3.2],
  ori: [270, -45.5, 8],
});

describe('Phone log', () => {
  it('round-trips packets and Zeroings unchanged', () => {
    const log = createPhoneLogRecorder();
    log.record(packet(0), 50);
    log.zero(60);
    log.record(packet(1), 70.25);
    expect(parsePhoneLog(log.toJsonl())).toEqual([
      { type: 'packet', tRecv: 50, ...packet(0) },
      { type: 'zero', tRecv: 60 },
      { type: 'packet', tRecv: 70.25, ...packet(1) },
    ]);
  });

  it('writes one JSON object per line with a trailing newline', () => {
    const log = createPhoneLogRecorder();
    log.record(packet(0), 1);
    log.zero(2);
    const text = log.toJsonl();
    expect(text.endsWith('\n')).toBe(true);
    expect(text.trimEnd().split('\n')).toHaveLength(2);
  });

  it('an empty recorder gives an empty log', () => {
    expect(createPhoneLogRecorder().toJsonl()).toBe('');
    expect(parsePhoneLog('')).toEqual([]);
  });

  it('ignores blank lines and a missing or extra trailing newline', () => {
    const a = JSON.stringify({ type: 'zero', tRecv: 1 });
    const b = JSON.stringify({ type: 'packet', tRecv: 2, ...packet(3) });
    const expected = [
      { type: 'zero', tRecv: 1 },
      { type: 'packet', tRecv: 2, ...packet(3) },
    ];
    expect(parsePhoneLog(`${a}\n${b}`)).toEqual(expected);
    expect(parsePhoneLog(`\n${a}\n\n  \n${b}\n\n`)).toEqual(expected);
    expect(parsePhoneLog(`${a}\r\n${b}\r\n`)).toEqual(expected);
  });

  it('rejects malformed lines', () => {
    expect(() => parsePhoneLog('not json')).toThrow(/line 1/);
    expect(() => parsePhoneLog('{"type":"nope"}')).toThrow(/unknown type/);
  });
});
