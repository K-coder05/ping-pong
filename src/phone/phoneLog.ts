/**
 * The Phone log: what the laptop received from the Phone (packets and
 * Zeroings), as JSONL. Recorded to make fixtures; replayed only in tests,
 * through the Swing detector.
 */
import type { MotionPacket } from './types.ts';

/** A received packet, stamped with the laptop's receive time (ms). */
export type PhoneLogPacket = { type: 'packet'; tRecv: number } & MotionPacket;
/** A Zeroing, stamped with the laptop's receive time (ms). */
export type PhoneLogZero = { type: 'zero'; tRecv: number };
export type PhoneLogEntry = PhoneLogPacket | PhoneLogZero;

export interface PhoneLogRecorder {
  record(packet: MotionPacket, tRecv: number): void;
  zero(tRecv: number): void;
  /** One JSON object per line, newline-terminated; empty string when nothing was recorded. */
  toJsonl(): string;
}

export function createPhoneLogRecorder(): PhoneLogRecorder {
  const lines: string[] = [];
  return {
    record(packet, tRecv) {
      const entry: PhoneLogPacket = {
        type: 'packet',
        tRecv,
        seq: packet.seq,
        tPhone: packet.tPhone,
        rot: [...packet.rot],
        acc: [...packet.acc],
        ori: [...packet.ori],
      };
      lines.push(JSON.stringify(entry));
    },
    zero(tRecv) {
      const entry: PhoneLogZero = { type: 'zero', tRecv };
      lines.push(JSON.stringify(entry));
    },
    toJsonl() {
      return lines.length === 0 ? '' : lines.join('\n') + '\n';
    },
  };
}

/** Parse a Phone log. Blank lines are skipped; a malformed line throws with its line number. */
export function parsePhoneLog(text: string): PhoneLogEntry[] {
  const entries: PhoneLogEntry[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (line === '') return;
    let obj: { type?: unknown };
    try {
      obj = JSON.parse(line);
    } catch {
      throw new Error(`Phone log line ${i + 1}: invalid JSON`);
    }
    if (obj.type !== 'packet' && obj.type !== 'zero') {
      throw new Error(`Phone log line ${i + 1}: unknown type ${String(obj.type)}`);
    }
    entries.push(obj as PhoneLogEntry);
  });
  return entries;
}
