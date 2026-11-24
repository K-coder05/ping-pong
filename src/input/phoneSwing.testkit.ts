/**
 * Synthetic Phone packets for the Phone Input's tests: a Phone in the Zeroing
 * grip, turned and tipped by known amounts, built from the physics (W3C
 * axes) rather than from the detector's own conventions, so the tests check
 * those conventions. Test-only.
 */
import type { PhoneLogEntry } from '../phone/phoneLog.ts';
import type { MotionPacket } from '../phone/types.ts';
import type { Hand } from '../sensing/landmarks.ts';
import type { Mat3 } from './phoneSwing.ts';

const DEG = Math.PI / 180;
type Vec3 = [number, number, number];

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Device to earth matrix from the device x, y, z axes in earth coordinates (its columns). */
function fromColumns(x: Vec3, y: Vec3, z: Vec3): Mat3 {
  return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
}

/**
 * The `deviceorientation` angles for a device-to-earth matrix, the way a
 * browser reports them (W3C ranges: beta in [−180, 180), gamma in [−90, 90)).
 */
export function orientationFromMatrix(m: Mat3): [number, number, number] {
  const [, m01, , , m11, , m20, m21, m22] = m;
  // gamma in (−90°, 90°): cos(gamma) > 0, so cos(beta) has the sign of m22.
  let gamma = Math.atan2(-m20, m22);
  if (gamma >= Math.PI / 2) gamma -= Math.PI;
  else if (gamma < -Math.PI / 2) gamma += Math.PI;
  const cg = Math.cos(gamma);
  const cb = Math.abs(cg) > 1e-9 ? m22 / cg : -m20 / Math.sin(gamma);
  const beta = Math.atan2(m21, cb);
  const alpha = Math.atan2(-m01 * Math.sign(cb || 1), m11 * Math.sign(cb || 1));
  const deg = (r: number) => r / DEG;
  return [((deg(alpha) % 360) + 360) % 360, deg(beta), deg(gamma)];
}

export interface GripPose {
  hand: Hand;
  /** Turn about the vertical since facing the screen, degrees, + = counterclockwise seen from above. */
  turnDeg?: number;
  /** How far the screen (the Forehand face) is tipped toward the floor, degrees (− = toward the ceiling). */
  screenDownDeg?: number;
  /** How far the top of the Phone is raised above horizontal, degrees. */
  raiseDeg?: number;
}

/**
 * The Zeroing grip, the player facing north (earth +Y) toward the screen: the
 * top of the Phone points at the screen and the screen faces the palm side,
 * which is the non-hitting side (west for a right-hander, east for a
 * left-hander). Then raised, tipped and turned as asked.
 */
export function gripMatrix(pose: GripPose): Mat3 {
  const turn = (pose.turnDeg ?? 0) * DEG;
  const down = (pose.screenDownDeg ?? 0) * DEG;
  const raise = (pose.raiseDeg ?? 0) * DEG;
  const forward: Vec3 = [-Math.sin(turn), Math.cos(turn), 0];
  const toNonHitting: Vec3 = pose.hand === 'right' ? [-Math.cos(turn), -Math.sin(turn), 0] : [Math.cos(turn), Math.sin(turn), 0];
  const up: Vec3 = [0, 0, 1];
  const top: Vec3 = forward.map((f, i) => f * Math.cos(raise) + up[i]! * Math.sin(raise)) as Vec3;
  // "Up" square to the handle and the palm side (tilted back with the raise).
  const upright = pose.hand === 'right' ? cross(top, toNonHitting) : cross(toNonHitting, top);
  const screen: Vec3 = toNonHitting.map((n, i) => n * Math.cos(down) - upright[i]! * Math.sin(down)) as Vec3;
  return fromColumns(cross(top, screen), top, screen);
}

/** The orientation of a grip pose, as the Phone reports it. */
export function gripOrientation(pose: GripPose): [number, number, number] {
  return orientationFromMatrix(gripMatrix(pose));
}

/** `rotationRate` (W3C: alpha about z, beta about x, gamma about y) for turning about the vertical at `dps` (+ = counterclockwise from above). */
export function rotationRateTurning(m: Mat3, dps: number): [number, number, number] {
  // The vertical in device coordinates is the matrix's bottom row.
  const [wx, wy, wz] = [m[6] * dps, m[7] * dps, m[8] * dps];
  return [wz, wx, wy];
}

/** A packet with the given fields; gravity along the vertical. */
export function makePacket(fields: Partial<MotionPacket> & Pick<MotionPacket, 'seq' | 'tPhone'>): MotionPacket {
  return { rot: [0, 0, 0], acc: [0, 0, 9.81], ori: [0, 0, 0], ...fields };
}

/** Turn speeds of one stroke, deg/s, one per 10 ms packet: about 120°, peaking at 1,000 deg/s. */
export const STROKE_DPS = [80, 200, 450, 750, 1000, 1000, 850, 600, 350, 140, 60, 20];

export interface ClipOptions {
  hand: Hand;
  /** The Stroke's side: a Forehand turns toward the non-hitting side. */
  side?: 'forehand' | 'backhand';
  /** The screen's tip toward the floor during the stroke, degrees. */
  screenDownDeg?: number;
  /** The Phone's clock minus the laptop's, ms. */
  clockOffsetMs?: number;
  /** One-way delay of each packet, ms. */
  delayMs?: number;
  /** ms of stillness before and after the stroke (none: no stroke, all stillness). */
  stillMs?: number;
}

/**
 * A recorded clip as the laptop would log it: a Zeroing, a still grip, one
 * stroke (unless `side` is left out) and stillness again, at 100 Hz.
 */
export function syntheticClip(o: ClipOptions): PhoneLogEntry[] {
  const offset = o.clockOffsetMs ?? 5000;
  const delay = o.delayMs ?? 8;
  const still = Math.round((o.stillMs ?? 500) / 10);
  const forehandTurn = o.hand === 'right' ? 1 : -1;
  const turnSign = o.side === 'backhand' ? -forehandTurn : forehandTurn;
  const speeds = [...Array<number>(still).fill(0), ...(o.side ? STROKE_DPS : []), ...Array<number>(o.side ? still : 0).fill(0)];
  const entries: PhoneLogEntry[] = [];
  let turnDeg = 0;
  speeds.forEach((dps, seq) => {
    const tPhone = 100_000 + seq * 10;
    const tRecv = tPhone - offset + delay;
    if (seq === 0) entries.push({ type: 'zero', tRecv: tRecv - 5 });
    turnDeg += (turnSign * dps * 10) / 1000;
    // The face tips once the stroke starts.
    const m = gripMatrix({ hand: o.hand, turnDeg, screenDownDeg: dps > 0 || seq >= still ? (o.screenDownDeg ?? 0) : 0 });
    entries.push({ type: 'packet', tRecv, ...makePacket({ seq, tPhone, rot: rotationRateTurning(m, turnSign * dps), ori: orientationFromMatrix(m) }) });
  });
  return entries;
}
