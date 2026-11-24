/**
 * Recorded Phone fixtures (fixtures/phone/*.jsonl, see its README.md)
 * replayed through the Phone Input, checked against P3-c's done criteria:
 *
 * - at least 90% of Swing clips give their Swing with the right side,
 * - the Face Angle sign matches the label (closed on top, open on chop) on at
 *   least 90% of top and chop clips,
 * - fewer than 1 false Swing per minute on idle clips.
 *
 * Each Swing clip holds exactly one Swing, judged by the clip's first Swing
 * (the one the game would act on). With no fixtures recorded yet, the checks
 * skip and say how to record them; a synthetic set checks the scoring itself.
 */
import { describe, expect, it } from 'vitest';
import { parsePhoneLog } from '../phone/phoneLog.ts';
import type { Hand } from '../sensing/landmarks.ts';
import { replayPhoneLog } from './phoneInput.ts';
import { syntheticClip } from './phoneSwing.testkit.ts';
import type { SwingEvent } from './types.ts';

const recorded = import.meta.glob('/fixtures/phone/*.jsonl', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

type Face = 'top' | 'flat' | 'chop';
type Label =
  | { kind: 'swing'; hand: Hand; side: SwingEvent['side']; face: Face }
  | { kind: 'idle'; hand: Hand };

/** `phone-[lh-]fore|back-top|flat|chop-NN.jsonl` or `phone-[lh-]idle-NN.jsonl`; `lh` = recorded left-handed. */
export function labelOf(fileName: string): Label | null {
  const m = /^phone-(lh-)?(?:(fore|back)-(top|flat|chop)|(idle))-\d+\.jsonl$/.exec(fileName);
  if (!m) return null;
  const hand: Hand = m[1] ? 'left' : 'right';
  if (m[4]) return { kind: 'idle', hand };
  return { kind: 'swing', hand, side: m[2] === 'fore' ? 'forehand' : 'backhand', face: m[3] as Face };
}

interface Score {
  swingClips: number;
  /** Swing clips whose first Swing has the labelled side. */
  rightSide: number;
  /** Swing clips with more than one Swing (reported, not judged). */
  extraSwings: number;
  topChopClips: number;
  /** Top and chop clips whose first Swing's Face Angle has the labelled sign (+ top, − chop). */
  rightFaceSign: number;
  idleMinutes: number;
  idleSwings: number;
  /** Per-clip lines for the report. */
  lines: string[];
  unlabelled: string[];
  unzeroed: string[];
}

export function scoreClips(clips: Record<string, string>): Score {
  const s: Score = { swingClips: 0, rightSide: 0, extraSwings: 0, topChopClips: 0, rightFaceSign: 0, idleMinutes: 0, idleSwings: 0, lines: [], unlabelled: [], unzeroed: [] };
  for (const [path, text] of Object.entries(clips)) {
    const name = path.split('/').pop()!;
    const label = labelOf(name);
    if (!label) {
      s.unlabelled.push(name);
      continue;
    }
    const entries = parsePhoneLog(text);
    if (entries[0]?.type !== 'zero') s.unzeroed.push(name);
    const swings = replayPhoneLog(entries, label.hand);
    const deg = (rad: number | undefined) => (rad === undefined ? '–' : `${Math.round((rad * 180) / Math.PI)}°`);
    const found = swings.map((w) => `${w.side} ${w.peakSpeed.toFixed(1)} ${deg(w.faceAngle)}`).join(', ') || 'none';
    s.lines.push(`${name}: ${found}`);
    if (label.kind === 'idle') {
      const packets = entries.filter((e) => e.type === 'packet');
      s.idleMinutes += packets.length > 1 ? (packets[packets.length - 1]!.tRecv - packets[0]!.tRecv) / 60_000 : 0;
      s.idleSwings += swings.length;
      continue;
    }
    const first = swings[0];
    s.swingClips++;
    if (first?.side === label.side) s.rightSide++;
    if (swings.length > 1) s.extraSwings++;
    if (label.face !== 'flat') {
      s.topChopClips++;
      const want = label.face === 'top' ? 1 : -1;
      if (first?.faceAngle !== undefined && Math.sign(first.faceAngle) === want) s.rightFaceSign++;
    }
  }
  return s;
}

const NO_FIXTURES = 'no Phone fixtures in fixtures/phone/ yet: record them as fixtures/phone/README.md says';

describe('Phone fixtures (P3-c done criteria)', () => {
  const score = scoreClips(recorded);
  const none = Object.keys(recorded).length === 0;
  if (!none) console.info(['Phone fixtures replayed:', ...score.lines].join('\n  '));

  if (none) {
    console.warn(`Phone fixture checks skipped: ${NO_FIXTURES}`);
    it.skip(NO_FIXTURES, () => {});
  }

  it.skipIf(none)('every fixture is labelled by its file name and starts with a Zeroing', () => {
    expect(score.unlabelled, 'file names must match phone-[lh-]fore|back-top|flat|chop-NN.jsonl or phone-[lh-]idle-NN.jsonl').toEqual([]);
    expect(score.unzeroed, 'each clip must start with a Zeroing').toEqual([]);
  });

  it.skipIf(score.swingClips === 0)('detects at least 90% of Swings with the right Forehand/Backhand side', () => {
    expect(score.rightSide / score.swingClips).toBeGreaterThanOrEqual(0.9);
  });

  it.skipIf(score.topChopClips === 0)('matches the Face Angle sign to the label (closed on top, open on chop) on at least 90% of top and chop clips', () => {
    expect(score.rightFaceSign / score.topChopClips).toBeGreaterThanOrEqual(0.9);
  });

  it.skipIf(score.idleMinutes === 0)('has fewer than 1 false Swing per minute on idle clips', () => {
    expect(score.idleSwings / score.idleMinutes).toBeLessThan(1);
  });
});

describe('fixture scoring, on synthetic clips', () => {
  const log = (entries: ReturnType<typeof syntheticClip>) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';

  it('reads labels from file names', () => {
    expect(labelOf('phone-fore-top-03.jsonl')).toEqual({ kind: 'swing', hand: 'right', side: 'forehand', face: 'top' });
    expect(labelOf('phone-lh-back-chop-12.jsonl')).toEqual({ kind: 'swing', hand: 'left', side: 'backhand', face: 'chop' });
    expect(labelOf('phone-idle-01.jsonl')).toEqual({ kind: 'idle', hand: 'right' });
    expect(labelOf('phone-log-2026.jsonl')).toBeNull();
  });

  it('scores side, Face Angle sign and idle false Swings', () => {
    const score = scoreClips({
      '/f/phone-fore-top-01.jsonl': log(syntheticClip({ hand: 'right', side: 'forehand', screenDownDeg: 30 })),
      '/f/phone-back-chop-01.jsonl': log(syntheticClip({ hand: 'right', side: 'backhand', screenDownDeg: 30 })), // back of hand up: open
      '/f/phone-lh-fore-chop-01.jsonl': log(syntheticClip({ hand: 'left', side: 'forehand', screenDownDeg: -30 })),
      '/f/phone-back-top-01.jsonl': log(syntheticClip({ hand: 'right', side: 'forehand', screenDownDeg: 30 })), // mislabelled side
      '/f/phone-fore-chop-02.jsonl': log(syntheticClip({ hand: 'right', side: 'forehand', screenDownDeg: 30 })), // closed: wrong sign
      '/f/phone-fore-flat-01.jsonl': log(syntheticClip({ hand: 'right', side: 'forehand' })),
      '/f/phone-idle-01.jsonl': log(syntheticClip({ hand: 'right', stillMs: 30_000 })),
      '/f/notes.jsonl': '',
    });
    expect(score).toMatchObject({ swingClips: 6, rightSide: 5, extraSwings: 0, topChopClips: 5, rightFaceSign: 4, idleSwings: 0, unlabelled: ['notes.jsonl'], unzeroed: [] });
    expect(score.idleMinutes).toBeCloseTo(0.5, 2);
  });
});
