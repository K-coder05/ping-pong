import {
  ArrowHelper,
  BufferGeometry,
  Color,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  OctahedronGeometry,
  PerspectiveCamera,
  RingGeometry,
  SphereGeometry,
  Vector3,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Vec3 } from '../game/ball.ts';
import {
  BALL_DRAW_SCALE,
  BALL_RADIUS,
  FEEDER_MOUTH,
  MAGNUS_K,
  PLAYER_END_Z,
  SPIN_TAU_S,
  TABLE_MU,
  TABLE_TOP_Y,
  TIME_SCALE,
} from '../game/constants.ts';
import { createKnobRegistry, knobs } from '../game/knobs.ts';
import { length } from '../physics/vec3.ts';
import { revsToRadPerSec } from '../physics/spin.ts';
import { drawnBall } from '../render/drawnBall.ts';
import { createDebugPanel } from '../render/debugPanel.ts';
import { createTableScene } from '../render/scene.ts';
import { analyseShot, pathDuration, positionAt, type AnalysedShot } from './shotAnalysis.ts';

/**
 * Physics debug page (spec P1-d; `physics.html`, not linked from the game).
 * Three Shots (Backspin, no spin, Topspin) are launched from the same point to
 * the same target and flight time, solved with `solveShot` and drawn as
 * trajectories with their bounces and Net-cords, then replayed as moving balls.
 * Any control (the game's physics knobs or the Shot knobs below) re-solves and
 * redraws on the next frame.
 *
 * Keys: 1 side camera, 2 top camera, 3 orbit camera (or C to cycle),
 * Q real speed / 0.25x replay, R restart the replay.
 */

const SLOW_FACTOR = 0.25;
const HOLD_S = 0.6; // a finished replay waits this long (real seconds) before starting over
const ARROW_LENGTH = 0.14;

// The Shot knobs: a second, page-local registry (the game's own stays untouched).
const shotKnobs = createKnobRegistry();
const TOPSPIN = shotKnobs.number({ name: 'Topspin (rev/s)', min: 0, max: 80, step: 1, default: 40, group: 'Shot' });
const SIDESPIN = shotKnobs.number({ name: 'Sidespin (rev/s)', min: -30, max: 30, step: 1, default: 0, group: 'Shot' });
const FLIGHT_TIME = shotKnobs.number({ name: 'Flight time T (s)', min: 0.4, max: 1.4, step: 0.05, default: 0.8, group: 'Shot' });
const TARGET_X = shotKnobs.number({ name: 'Target x (m)', min: -0.7, max: 0.7, step: 0.05, default: 0, group: 'Shot' });
const TARGET_PAST_NET = shotKnobs.number({ name: 'Target past the net (m)', min: 0.1, max: 1.3, step: 0.05, default: 0.9, group: 'Shot' });
const FROM_FEEDER = shotKnobs.toggle({ name: 'Launch from Feeder mouth', default: false, group: 'Shot' });
shotKnobs.button({ name: 'Copy knob values', onPress: copyKnobValues, group: 'Shot' });

interface ShotKind {
  label: string;
  /** Sign applied to the Topspin knob: negative = Backspin. */
  sign: number;
  colour: number;
}
const KINDS: readonly ShotKind[] = [
  { label: 'Backspin', sign: -1, colour: 0xff9f43 },
  { label: 'No spin', sign: 0, colour: 0xe6e9ef },
  { label: 'Topspin', sign: 1, colour: 0x4fd1ff },
];

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const tableScene = createTableScene(canvas);
const { scene } = tableScene;
tableScene.syncBall({ x: 0, y: -10, z: 0 }, { x: 0, y: 0, z: 0 }); // the game's own ball and its shadow stay out of sight
tableScene.syncPaddle({ position: { x: 0, y: -10, z: 0 }, yaw: 0, pitch: 0, backhandFace: false });

// Cameras: side and top are fixed; orbit is free.
const sideCamera = new PerspectiveCamera(30, 1, 0.05, 50);
sideCamera.position.set(6, TABLE_TOP_Y + 0.35, 0);
sideCamera.lookAt(0, TABLE_TOP_Y + 0.3, 0);
const topCamera = new PerspectiveCamera(30, 1, 0.05, 50);
topCamera.up.set(0, 0, -1); // the Feeder's end is at the top of the screen
topCamera.position.set(0, 7, 0);
topCamera.lookAt(0, TABLE_TOP_Y, 0);
const orbitCamera = new PerspectiveCamera(45, 1, 0.05, 50);
orbitCamera.position.set(2.2, 1.8, 3.2);
const controls = new OrbitControls(orbitCamera, canvas);
controls.target.set(0, TABLE_TOP_Y + 0.15, 0);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI / 2 - 0.05;
controls.update();

type CameraMode = 'side' | 'top' | 'orbit';
const CAMERAS: Record<CameraMode, PerspectiveCamera> = { side: sideCamera, top: topCamera, orbit: orbitCamera };
const CAMERA_ORDER: readonly CameraMode[] = ['side', 'top', 'orbit'];
let cameraMode: CameraMode = 'side';

// Panels: the existing knob panel for the game's knobs, a second one for the Shot.
const physicsPanel = createDebugPanel(knobs);
physicsPanel.setVisible(true);
const physicsPanelElement = document.body.lastElementChild as HTMLElement;
for (const fieldset of physicsPanelElement.querySelectorAll('fieldset')) {
  const group = fieldset.querySelector('legend')?.textContent;
  if (group !== 'Physics' && group !== 'Timing') fieldset.hidden = true; // only the physics knobs matter here
}
for (const button of physicsPanelElement.querySelectorAll<HTMLElement>('fieldset button')) button.hidden = true;
const shotPanel = createDebugPanel(shotKnobs);
shotPanel.setVisible(true);
const shotPanelElement = document.body.lastElementChild as HTMLElement;
shotPanelElement.style.right = 'auto';
shotPanelElement.style.left = '8px';
shotPanelElement.querySelector('strong')!.textContent = 'Shot';

const readout = document.createElement('div');
readout.style.cssText =
  'position:fixed;left:8px;bottom:8px;z-index:10;padding:6px 10px;border-radius:6px;white-space:pre;' +
  'background:rgba(12,14,20,0.85);color:#e6e9ef;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;';
document.body.append(readout);

// Drawn Shots.
const shotsGroup = new Group();
scene.add(shotsGroup);
const balls = KINDS.map((kind) => {
  const mesh = new Mesh(new SphereGeometry(BALL_RADIUS, 20, 14), new MeshBasicMaterial({ color: kind.colour }));
  const arrow = new ArrowHelper(new Vector3(0, 1, 0), new Vector3(), ARROW_LENGTH, kind.colour, 0.04, 0.025);
  scene.add(mesh, arrow);
  return { mesh, arrow };
});

let shots: (AnalysedShot | null)[] = [];
let dirty = true;
let replayClock = 0; // seconds of Shot time since launch
let slow = false;
let heldFor = 0;

function launchPoint(): Vec3 {
  return FROM_FEEDER.value ? { ...FEEDER_MOUTH } : { x: 0, y: TABLE_TOP_Y + 0.3, z: PLAYER_END_Z };
}

/** The target is on the far half: the Feeder's from the player's end, the player's from the Feeder mouth. */
function targetPoint(): { x: number; z: number } {
  return { x: TARGET_X.value, z: (FROM_FEEDER.value ? 1 : -1) * TARGET_PAST_NET.value };
}

function recompute(): void {
  const from = launchPoint();
  const target = targetPoint();
  shots = KINDS.map((kind) =>
    analyseShot(from, {
      target,
      flightTime: FLIGHT_TIME.value,
      topspin: revsToRadPerSec(TOPSPIN.value * kind.sign),
      sidespin: revsToRadPerSec(SIDESPIN.value),
    }),
  );
  redraw(target);
  readout.textContent = readoutText();
  replayClock = 0;
  heldFor = 0;
}

function redraw(target: { x: number; z: number }): void {
  for (const child of [...shotsGroup.children]) {
    shotsGroup.remove(child);
    disposeObject(child);
  }
  const ring = new Mesh(new RingGeometry(0.03, 0.045, 32), new MeshBasicMaterial({ color: 0xfff27a }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(target.x, TABLE_TOP_Y + 0.003, target.z);
  shotsGroup.add(ring);

  shots.forEach((shot, i) => {
    if (!shot) return;
    const colour = new Color(KINDS[i]!.colour);
    const line = new Line(
      new BufferGeometry().setFromPoints(shot.path.map((p) => new Vector3(p.x, p.y, p.z))),
      new LineBasicMaterial({ color: colour }),
    );
    shotsGroup.add(line);
    for (const marker of shot.markers) {
      const mesh =
        marker.kind === 'bounce'
          ? new Mesh(new SphereGeometry(0.012, 10, 8), new MeshBasicMaterial({ color: colour }))
          : new Mesh(new OctahedronGeometry(0.025), new MeshBasicMaterial({ color: marker.kind === 'cord' ? 0xff4fd8 : 0xff3b3b }));
      mesh.position.set(marker.position.x, marker.position.y, marker.position.z);
      shotsGroup.add(mesh);
    }
  });
}

function disposeObject(object: Group['children'][number]): void {
  if (object instanceof Mesh || object instanceof Line) {
    object.geometry.dispose();
    (object.material as { dispose(): void }).dispose();
  }
}

function readoutText(): string {
  const m = (v: number | null, digits = 3) => (v === null ? '-' : v.toFixed(digits));
  const rows: [string, (s: AnalysedShot) => string][] = [
    ['landing error (m)', (s) => m(s.readouts.landingError)],
    ['net clearance (m)', (s) => m(s.readouts.netClearance)],
    ['apex height (m)', (s) => m(s.readouts.apexHeight)],
    ['speed after bounce (m/s)', (s) => m(s.readouts.speedAfterBounce, 2)],
    ['solver passes', (s) => String(s.readouts.passes)],
    ['flight time used (s)', (s) => m(s.readouts.flightTime, 2)],
  ];
  const col = (text: string) => text.padStart(12);
  const lines = [''.padEnd(25) + KINDS.map((k) => col(k.label)).join('')];
  for (const [name, value] of rows) {
    lines.push(name.padEnd(25) + shots.map((s) => col(s ? value(s) : 'no solution')).join(''));
  }
  lines.push('');
  lines.push(`replay: ${slow ? '0.25x' : 'real speed'} of game time (TIME_SCALE ${TIME_SCALE.value.toFixed(2)})`);
  lines.push('keys: 1 side  2 top  3 orbit  C cycle camera  Q speed  R restart');
  lines.push('markers: dot = bounce, magenta diamond = Net-cord, red diamond = net');
  return lines.join('\n');
}

function copyKnobValues(): void {
  const json = JSON.stringify(
    { MAGNUS_K: MAGNUS_K.value, SPIN_TAU_S: SPIN_TAU_S.value, TABLE_MU: TABLE_MU.value, TIME_SCALE: TIME_SCALE.value },
    null,
    2,
  );
  const fallback = () => window.prompt('Copy the knob values:', json);
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(json).catch(fallback);
  else fallback();
}

function setCamera(mode: CameraMode): void {
  cameraMode = mode;
  controls.enabled = mode === 'orbit';
}

window.addEventListener('keydown', (event) => {
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.target instanceof HTMLInputElement && !['range', 'checkbox', 'button'].includes(event.target.type)) return;
  switch (event.key.toLowerCase()) {
    case '1':
      return setCamera('side');
    case '2':
      return setCamera('top');
    case '3':
      return setCamera('orbit');
    case 'c':
      return setCamera(CAMERA_ORDER[(CAMERA_ORDER.indexOf(cameraMode) + 1) % CAMERA_ORDER.length]!);
    case 'q':
      slow = !slow;
      dirty = true;
      return;
    case 'r':
      replayClock = 0;
      heldFor = 0;
      return;
  }
});

knobs.onChange(() => (dirty = true));
shotKnobs.onChange(() => (dirty = true));

function resize(): void {
  const width = window.innerWidth;
  const height = window.innerHeight;
  tableScene.resize(width, height);
  for (const camera of Object.values(CAMERAS)) {
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
  // Keep the whole table in view whatever the window shape: widen the field of view for narrow windows.
  sideCamera.fov = Math.min(80, 30 * Math.max(1, 1.9 / (height ? width / height : 1)));
  topCamera.fov = Math.min(80, 30 * Math.max(1, 1 / (height ? width / height : 1)));
  sideCamera.updateProjectionMatrix();
  topCamera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

let lastTime = performance.now();
function frame(now: number): void {
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;
  if (dirty) {
    dirty = false;
    recompute();
  }

  const longest = Math.max(0, ...shots.map((s) => (s ? pathDuration(s.path) : 0)));
  if (replayClock >= longest) {
    heldFor += dt;
    if (heldFor >= HOLD_S) {
      replayClock = 0;
      heldFor = 0;
    }
  } else {
    replayClock += dt * TIME_SCALE.value * (slow ? SLOW_FACTOR : 1);
  }

  shots.forEach((shot, i) => {
    const { mesh, arrow } = balls[i]!;
    mesh.visible = arrow.visible = shot !== null;
    if (!shot) return;
    const position = positionAt(shot.path, replayClock);
    const { centre, radius } = drawnBall(position, BALL_DRAW_SCALE.value);
    mesh.position.set(centre.x, centre.y, centre.z);
    mesh.scale.setScalar(radius / BALL_RADIUS);
    const speed = length(shot.spin);
    arrow.visible = speed > 1e-6;
    if (arrow.visible) {
      arrow.position.set(centre.x, centre.y, centre.z); // from the ball centre, along the spin axis
      arrow.setDirection(new Vector3(shot.spin.x / speed, shot.spin.y / speed, shot.spin.z / speed));
    }
  });

  controls.update();
  tableScene.render(CAMERAS[cameraMode]);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
