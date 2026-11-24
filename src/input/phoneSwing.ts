/**
 * The Phone's Swing detector (docs/specs/p3.md, P3-c): pure, packet in,
 * `SwingEvent` out. The Phone's gyro plays the role the Wii Remote's
 * accelerometer did: a Swing Onset is the angular speed staying above
 * `onDps` for 2 consecutive packets, outside the cooldown; it re-arms once
 * the speed drops below `offDps`.
 *
 * Zeroing gives the neutral grip ("hold the phone like the handle of a bat,
 * screen facing your palm side, point it at the screen"): the Face Angle and
 * the sideways turn are measured from it, and no Swing is emitted before it.
 *
 * Orientation follows the W3C DeviceOrientation conventions: device axes x
 * to the right of the screen, y toward its top, z out of the screen; the
 * earth frame has Z up; `deviceorientation` alpha, beta, gamma are the
 * intrinsic Z-X'-Y'' angles. Every angle is turned into a rotation matrix
 * before use, because the instructed grip (the Phone on its long edge) sits
 * right where beta and gamma jump (gamma = ±90°), while the matrix is
 * continuous there.
 */
import type { Hand } from '../sensing/landmarks.ts';
import type { MotionPacket } from '../phone/types.ts';
import type { SwingEvent } from './types.ts';

export interface PhoneSwingParams {
  /** Swing Onset: angular speed above this, deg/s, for 2 consecutive packets. */
  onDps: number;
  /** Re-arm once the angular speed drops below this, deg/s. */
  offDps: number;
  /** No new Swing Onset within this long of the last one, ms. */
  cooldownMs: number;
  /** deg/s per `peakSpeed` unit, putting Phone Swings on the Camera's shoulder-widths/s scale. */
  dpsPerUnit: number;
}

/** Starting guesses (P3-c), to tune with real Phones. */
export const DEFAULT_PHONE_SWING_PARAMS: Readonly<PhoneSwingParams> = { onDps: 400, offDps: 150, cooldownMs: 400, dpsPerUnit: 120 };

type Axis = 'x' | 'y' | 'z';

/**
 * Every axis and sign convention the Phone Input relies on, in one place.
 *
 * PROVISIONAL until recorded Phone fixtures confirm them (fixtures/phone/,
 * `phoneSwing.fixtures.test.ts`). They are reasoned from the W3C axes and the
 * Zeroing grip: the Phone held like a bat handle, its top pointing at the
 * laptop screen, its screen facing the palm side (for a right-hander: screen
 * toward the left, x up; for a left-hander: screen toward the right, x down).
 * If the fixtures disagree, change a value here, not the detector.
 */
export const PHONE_AXES = {
  /**
   * The device axis each `rot` entry turns about. W3C: rotationRate alpha is
   * about z, beta about x, gamma about y. (Browsers have disagreed on this
   * before; the fixtures decide.)
   */
  rotationRate: ['z', 'x', 'y'] as readonly [Axis, Axis, Axis],
  /**
   * Which way a Forehand turns the Phone about the vertical, by hitting hand:
   * +1 = counterclockwise seen from above. A right-hander's Forehand sweeps
   * from their right toward their left (the non-hitting side), which is
   * counterclockwise; a left-hander's is mirrored. A Backhand turns the other
   * way. Measured about the true vertical (from orientation), so it holds
   * whatever the Face Angle or however the Phone is gripped.
   */
  forehandTurn: { right: 1, left: -1 } as Readonly<Record<Hand, 1 | -1>>,
  /**
   * The device axis pointing out of the bat's Forehand face: the screen
   * (+z), which faces the palm, as the Forehand rubber does in a shakehand
   * grip. The Backhand face is the opposite side (−z, the back of the hand).
   */
  forehandFace: { axis: 'z', sign: 1 } as { readonly axis: Axis; readonly sign: 1 | -1 },
  /** The device axis along the handle, pointing at the screen at Zero: the Phone's top (+y). */
  handle: { axis: 'y', sign: 1 } as { readonly axis: Axis; readonly sign: 1 | -1 },
} as const;

/** Angular speed: the magnitude of `rot`, deg/s. */
export function angularSpeed(rot: readonly [number, number, number]): number {
  return Math.hypot(rot[0], rot[1], rot[2]);
}

/** A 3×3 rotation matrix, row-major: rows are earth X (east), Y (north), Z (up); columns are device x, y, z. */
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

const DEG = Math.PI / 180;
const AXIS_INDEX: Record<Axis, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };

/** Device to earth rotation for a `deviceorientation` (alpha, beta, gamma), degrees (W3C, Z-X'-Y''). */
export function rotationMatrix(ori: readonly [number, number, number]): Mat3 {
  const [a, b, g] = [ori[0] * DEG, ori[1] * DEG, ori[2] * DEG];
  const [ca, sa, cb, sb, cg, sg] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b), Math.cos(g), Math.sin(g)];
  return [
    ca * cg - sa * sb * sg, -cb * sa, cg * sa * sb + ca * sg,
    cg * sa + ca * sb * sg, ca * cb, sa * sg - ca * cg * sb,
    -cb * sg, sb, cb * cg,
  ];
}

type Vec3 = [number, number, number];

/** A device axis (times its sign) in earth coordinates: that column of the matrix. */
function deviceAxisInEarth(m: Mat3, axis: { axis: Axis; sign: 1 | -1 }): Vec3 {
  const i = AXIS_INDEX[axis.axis];
  const column: Vec3 = [m[i], m[(3 + i) as 3 | 4 | 5], m[(6 + i) as 6 | 7 | 8]];
  return column.map((v) => v * axis.sign) as Vec3;
}

/** `rot` as an angular velocity along device x, y, z, deg/s. */
function rotInDevice(rot: readonly [number, number, number]): Vec3 {
  const w: Vec3 = [0, 0, 0];
  PHONE_AXES.rotationRate.forEach((axis, i) => (w[AXIS_INDEX[axis]] = rot[i as 0 | 1 | 2]));
  return w;
}

/** Turn rate about the vertical, deg/s, + = counterclockwise seen from above. */
export function verticalTurnRate(p: Pick<MotionPacket, 'rot' | 'ori'>): number {
  const m = rotationMatrix(p.ori);
  const w = rotInDevice(p.rot);
  // Earth Z of the device-frame angular velocity: the bottom row of the matrix.
  return m[6] * w[0] + m[7] * w[1] + m[8] * w[2];
}

/** How far the Forehand face points toward the floor, radians (− = toward the ceiling). */
function forehandFaceDown(m: Mat3): number {
  const up = deviceAxisInEarth(m, PHONE_AXES.forehandFace)[2];
  return -Math.asin(Math.max(-1, Math.min(1, up)));
}

/** The handle's heading in the horizontal plane, radians, counterclockwise from north. */
function handleHeading(m: Mat3): number {
  const [x, y] = deviceAxisInEarth(m, PHONE_AXES.handle);
  return Math.atan2(-x, y);
}

function wrapAngle(rad: number): number {
  return Math.atan2(Math.sin(rad), Math.cos(rad));
}

/** The Phone's orientation relative to Zero. */
export interface PhoneAttitude {
  /** The Forehand face's Face Angle from Zero, radians; + = closed (toward the floor). The Backhand face's is the negative. */
  forehandFaceAngle: number;
  /** How far the handle has turned toward the hitting side since Zero, radians (− = toward the non-hitting side). */
  turnToHitting: number;
}

/** A packet's index is stale if it is at most this far behind the newest: anything further back is a restarted Phone page. */
const SEQ_RESTART = 1000;

interface Neutral {
  faceDown: number;
  heading: number;
}

/** One packet of a run above `onDps`. */
interface Fast {
  speed: number;
  turn: number;
}

/**
 * Packets in, Swings out. `zero(neutral)` sets the neutral grip; before the
 * first Zeroing `push` never returns a Swing. Packets arriving out of order
 * (the motion channel is unordered) are ignored.
 */
export class PhoneSwingDetector {
  readonly hand: Hand;
  readonly #params: PhoneSwingParams;
  #neutral: Neutral | null = null;
  #armed = true;
  /** The latest run of consecutive packets above `onDps`, at most the last 2. */
  #run: Fast[] = [];
  #lastOnset = -Infinity;
  #lastSeq: number | null = null;

  constructor(p: PhoneSwingParams, hand: Hand) {
    this.#params = p;
    this.hand = hand;
  }

  get zeroed(): boolean {
    return this.#neutral !== null;
  }

  /** Zeroing: `neutral`'s orientation is the upright face pointing at the screen. */
  zero(neutral: MotionPacket): void {
    const m = rotationMatrix(neutral.ori);
    this.#neutral = { faceDown: forehandFaceDown(m), heading: handleHeading(m) };
  }

  /** The Phone's orientation from Zero, or null before the first Zeroing. */
  attitude(p: Pick<MotionPacket, 'ori'>): PhoneAttitude | null {
    if (!this.#neutral) return null;
    const m = rotationMatrix(p.ori);
    const turnedCcw = wrapAngle(handleHeading(m) - this.#neutral.heading);
    return {
      forehandFaceAngle: forehandFaceDown(m) - this.#neutral.faceDown,
      // A Forehand turns toward the non-hitting side.
      turnToHitting: -turnedCcw * PHONE_AXES.forehandTurn[this.hand] + 0,
    };
  }

  /** One packet, stamped on the laptop's clock (`tLocal`, ms). Returns the Swing whose Onset it is, if any. */
  push(p: MotionPacket, tLocal: number): SwingEvent | null {
    if (this.#lastSeq !== null && p.seq <= this.#lastSeq && this.#lastSeq - p.seq < SEQ_RESTART) return null;
    this.#lastSeq = p.seq;
    if (!this.#neutral) return null;

    const { onDps, offDps, cooldownMs, dpsPerUnit } = this.#params;
    const speed = angularSpeed(p.rot);
    if (speed < offDps) this.#armed = true;
    if (speed > onDps) {
      this.#run.push({ speed, turn: verticalTurnRate(p) });
      if (this.#run.length > 2) this.#run.shift();
    } else {
      this.#run = [];
    }
    if (!this.#armed || this.#run.length < 2 || tLocal - this.#lastOnset < cooldownMs) return null;

    this.#armed = false;
    this.#lastOnset = tLocal;
    const peak = Math.max(...this.#run.map((f) => f.speed));
    const turn = this.#run.reduce((sum, f) => sum + f.turn, 0);
    const side = turn * PHONE_AXES.forehandTurn[this.hand] >= 0 ? 'forehand' : 'backhand';
    const forehandFaceAngle = this.attitude(p)!.forehandFaceAngle;
    return {
      t: tLocal,
      peakSpeed: peak / dpsPerUnit,
      side,
      vertPath: 0, // the Phone doesn't use Lift (ADR 0003)
      faceAngle: (side === 'forehand' ? forehandFaceAngle : -forehandFaceAngle) + 0,
    };
  }
}
