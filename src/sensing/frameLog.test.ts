import { describe, expect, it } from 'vitest';
import { createFrameLog } from './frameLog.ts';

describe('frame log', () => {
  it('writes a header from the row fields, then one line per frame in order', () => {
    const log = createFrameLog();
    log.push({ t: 1000, wristX: 0.5 });
    log.push({ t: 1033.3, wristX: 0.25 });
    expect(log.length).toBe(2);
    expect(log.toCsv()).toBe('t,wristX\n1000,0.5\n1033.3,0.25\n');
  });

  it('leaves cells empty for missing, null or non-finite values, and adds columns first seen in later rows', () => {
    const log = createFrameLog();
    log.push({ t: 1, wristX: null });
    log.push({ t: 2, wristX: NaN, sStroke: 3.5 });
    log.push({ t: 3, wristX: Infinity, onset: true });
    expect(log.toCsv()).toBe('t,wristX,sStroke,onset\n1,,,\n2,,3.5,\n3,,,true\n');
  });

  it('rounds numbers to 6 decimal places to keep the file small', () => {
    const log = createFrameLog();
    log.push({ x: 0.123456789, t: 1234.5678912 });
    expect(log.toCsv()).toBe('x,t\n0.123457,1234.567891\n');
  });

  it('quotes text containing commas, quotes or newlines', () => {
    const log = createFrameLog();
    log.push({ note: 'GPU, fallback "CPU"', side: 'forehand' });
    expect(log.toCsv()).toBe('note,side\n"GPU, fallback ""CPU""",forehand\n');
  });

  it('is empty again after clear', () => {
    const log = createFrameLog();
    log.push({ t: 1 });
    log.clear();
    expect(log.length).toBe(0);
    expect(log.toCsv()).toBe('\n');
  });

  it('drops the oldest frames once it holds the maximum', () => {
    const log = createFrameLog({ maxRows: 2 });
    [1, 2, 3].forEach((t) => log.push({ t }));
    expect(log.toCsv()).toBe('t\n2\n3\n');
    for (let t = 4; t <= 11; t++) log.push({ t });
    expect(log.length).toBe(2);
    expect(log.toCsv()).toBe('t\n10\n11\n');
  });
});
