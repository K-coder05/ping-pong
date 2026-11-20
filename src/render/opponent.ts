/**
 * The Opponent's figure (spec P2-d): a simple low-poly player behind the far
 * end of the table, drawn from the `BodyPose` that `opponent/motion.ts` plans.
 * It only draws: where the body is, how it leans, where its paddle is and how
 * the face is tilted. It never decides anything (ADR 0002).
 *
 * Built like the rest of the scene: plain meshes with standard materials. The
 * legs stay upright under the hips; the torso, head and arms lean from the
 * hips and twist with the swing; the hitting arm (right, the −x side) runs
 * from the shoulder to the paddle's handle.
 */

import {
  BoxGeometry,
  CapsuleGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import { OPPONENT_STANCE_Z, type BodyPose } from '../opponent/motion.ts';

export interface OpponentFigure {
  /** Add this to the scene. */
  readonly root: Group;
  /** Draw the figure in `pose`. */
  sync(pose: BodyPose): void;
}

const HIP_Y = 0.85;
const TORSO_RADIUS = 0.15;
const TORSO_LENGTH = 0.36;
const HEAD_RADIUS = 0.11;
const SHOULDER = { x: 0.2, y: 0.45 }; // from the hips, each side
const ARM_RADIUS = 0.04;
const LEG_RADIUS = 0.065;
const LEG_SPREAD = 0.13;

const BLADE_RADIUS = 0.076; // a 15 cm blade, like the player's
const BLADE_THICKNESS = 0.012;
const HANDLE_LENGTH = 0.1;

/** How much the torso turns with the paddle's travel along z (backswing coils, follow-through uncoils), rad per m, and at most. */
const TWIST_PER_M = 0.9;
const MAX_TWIST = 0.5;
/** No twist with the paddle this far in front of the body: about the ready position. */
const TWIST_REST_Z = 0.3;

const UP = new Vector3(0, 1, 0);

export function createOpponentFigure(): OpponentFigure {
  const shirt = new MeshStandardMaterial({ color: 0x2f9e8f, roughness: 0.7 });
  const shorts = new MeshStandardMaterial({ color: 0x22252b, roughness: 0.8 });
  const skin = new MeshStandardMaterial({ color: 0xe0b48a, roughness: 0.6 });

  const root = new Group();
  root.position.z = OPPONENT_STANCE_Z;

  // Legs, upright from the floor to the hips.
  const legLength = HIP_Y - 2 * LEG_RADIUS;
  const legGeometry = new CapsuleGeometry(LEG_RADIUS, legLength, 4, 8);
  for (const side of [-1, 1]) {
    const leg = new Mesh(legGeometry, shorts);
    leg.position.set(side * LEG_SPREAD, HIP_Y / 2, 0);
    root.add(leg);
  }

  // Everything above the hips leans from them and twists with the swing.
  const upper = new Group();
  upper.position.y = HIP_Y;
  root.add(upper);

  const torso = new Mesh(new CapsuleGeometry(TORSO_RADIUS, TORSO_LENGTH, 4, 10), shirt);
  torso.position.y = TORSO_LENGTH / 2 + TORSO_RADIUS * 0.6;
  torso.scale.z = 0.7; // flatter front to back
  upper.add(torso);

  const head = new Mesh(new SphereGeometry(HEAD_RADIUS, 14, 10), skin);
  head.position.y = SHOULDER.y + HEAD_RADIUS + 0.06;
  upper.add(head);

  // The right shoulder (the hitting arm's) is on the −x side; the left arm hangs.
  const hittingShoulder = new Object3D();
  hittingShoulder.position.set(-SHOULDER.x, SHOULDER.y, 0);
  upper.add(hittingShoulder);
  const freeArm = new Mesh(new CapsuleGeometry(ARM_RADIUS, 0.45, 4, 8), skin);
  freeArm.position.set(SHOULDER.x + 0.03, SHOULDER.y - 0.25, 0.04);
  freeArm.rotation.z = 0.15;
  upper.add(freeArm);

  // The hitting arm: a unit-length cylinder, stretched from the shoulder to the hand each frame.
  const arm = new Mesh(new CylinderGeometry(ARM_RADIUS, ARM_RADIUS, 1, 8), skin);
  root.add(arm);

  const paddle = createOpponentPaddle();
  root.add(paddle.group);

  const shoulderWorld = new Vector3();
  const handWorld = new Vector3();
  const direction = new Vector3();
  const turn = new Quaternion();

  return {
    root,
    sync(pose) {
      root.position.x = pose.x;

      // Paddle: blade centre where the pose puts it, face toward the player, tilted closed (+) or open (−).
      const local = paddle.group.position;
      local.set(pose.paddle.x - pose.x, pose.paddle.y, pose.paddle.z - OPPONENT_STANCE_Z);
      paddle.group.rotation.set(pose.paddleTilt, 0, 0);

      // Lean toward +x tips the upper body clockwise seen from the player; twist with the paddle's reach along z.
      const twist = Math.max(-MAX_TWIST, Math.min(MAX_TWIST, (local.z - TWIST_REST_Z) * TWIST_PER_M));
      upper.rotation.set(0, twist, -pose.lean, 'ZYX');

      // The hitting arm, shoulder to hand (the handle's end).
      root.updateMatrixWorld(true);
      hittingShoulder.getWorldPosition(shoulderWorld);
      paddle.hand.getWorldPosition(handWorld);
      root.worldToLocal(shoulderWorld);
      root.worldToLocal(handWorld);
      direction.subVectors(handWorld, shoulderWorld);
      const length = Math.max(direction.length(), 1e-3);
      arm.position.copy(shoulderWorld).addScaledVector(direction, 0.5);
      arm.quaternion.copy(turn.setFromUnitVectors(UP, direction.normalize()));
      arm.scale.set(1, length, 1);
    },
  };
}

/**
 * The Opponent's paddle, like the player's: a round blade standing across the
 * table, with the handle hanging below. Red rubber faces the player at rest.
 * Its origin is the blade's centre; `hand` is where the hand grips the handle.
 */
function createOpponentPaddle(): { group: Group; hand: Object3D } {
  const group = new Group();
  const wood = new MeshStandardMaterial({ color: 0xc89a5b, roughness: 0.7 });
  const forehandRubber = new MeshStandardMaterial({ color: 0xc0262d, roughness: 0.55 });
  const backhandRubber = new MeshStandardMaterial({ color: 0x15161a, roughness: 0.55 });

  // CylinderGeometry's groups: 0 the edge, 1 the top cap (+y), 2 the bottom cap (−y).
  // Turned to lie along z, the top cap faces the player (+z).
  const blade = new Mesh(new CylinderGeometry(BLADE_RADIUS, BLADE_RADIUS, BLADE_THICKNESS, 32), [wood, forehandRubber, backhandRubber]);
  blade.rotation.x = Math.PI / 2;
  group.add(blade);

  const handleY = -(BLADE_RADIUS + HANDLE_LENGTH / 2 - 0.01);
  const handle = new Mesh(new BoxGeometry(0.026, HANDLE_LENGTH, 0.022), wood);
  handle.position.y = handleY;
  group.add(handle);

  const hand = new Object3D();
  hand.position.y = handleY - HANDLE_LENGTH / 4;
  group.add(hand);
  return { group, hand };
}
