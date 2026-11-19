/**
 * Boot and game loop for Return Drill.
 *
 * Each animation frame: measure real elapsed time, advance the simulation,
 * update debug mode, then draw from whichever camera is active.
 */
import { BALL_RADIUS, TABLE_TOP_Y } from './game/constants.ts';
import { knobs } from './game/knobs.ts';
import { installCameraOverlay } from './render/cameraOverlay.ts';
import { createDebugMode } from './render/debugMode.ts';
import { createTableScene, type Vec3Like } from './render/scene.ts';

const canvas = document.querySelector<HTMLCanvasElement>('#scene');
if (!canvas) throw new Error('index.html must contain <canvas id="scene">');

const tableScene = createTableScene(canvas);
const debug = createDebugMode({ renderer: tableScene.renderer, playCamera: tableScene.playCamera, registry: knobs });
knobs.button({ name: 'Reset all knobs', group: 'Debug', onPress: () => knobs.resetAll() });
installCameraOverlay(knobs); // camera + pose debug overlay: D → "Camera overlay", or ?overlay

/** Ball physics centre: at rest on the player's half until ball physics lands. */
const ballPosition: Vec3Like = { x: 0, y: TABLE_TOP_Y + BALL_RADIUS, z: 0.7 };

function resize(): void {
  const width = window.innerWidth;
  const height = window.innerHeight;
  tableScene.resize(width, height);
  debug.resize(width, height);
}
window.addEventListener('resize', resize);
resize();

let lastFrameTime = performance.now();

function frame(now: number): void {
  const elapsedSeconds = (now - lastFrameTime) / 1000;
  lastFrameTime = now;

  // Simulation slot (next ticket): fixed-step accumulator. Add
  // Math.min(elapsedSeconds, MAX_FRAME_DT) * TIME_SCALE.value to an
  // accumulator and step the ball in PHYSICS_DT chunks while it holds enough.

  debug.update(elapsedSeconds);
  tableScene.syncBall(ballPosition);
  tableScene.render(debug.camera);
}

tableScene.renderer.setAnimationLoop(frame);
