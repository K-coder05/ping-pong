/** Types shared by the laptop and the Phone page (docs/specs/p3.md, P3-0). */

export interface MotionPacket {
  seq: number; // increments per packet
  tPhone: number; // ms, the Phone's performance.now()
  rot: [number, number, number]; // rotationRate alpha, beta, gamma, deg/s
  acc: [number, number, number]; // accelerationIncludingGravity x, y, z, m/s²
  ori: [number, number, number]; // deviceorientation alpha, beta, gamma, deg
}

export type ControlMessage =
  | { type: 'ping'; t0: number }
  | { type: 'pong'; t0: number; t1: number; t2: number }
  | { type: 'zero' }
  | { type: 'haptic'; ms: number };

export type LinkStatus = 'idle' | 'waiting' | 'connecting' | 'connected' | 'relay' | 'disconnected';

export interface PhoneLink {
  status(): LinkStatus;
  onStatus(cb: (s: LinkStatus) => void): () => void;
  onPacket(cb: (p: MotionPacket, tRecv: number) => void): () => void;
  onControl(cb: (m: ControlMessage, tRecv: number) => void): () => void;
  sendPacket(p: MotionPacket): void; // Phone side
  sendControl(m: ControlMessage): void;
  close(): void;
}
