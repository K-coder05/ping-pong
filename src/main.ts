/**
 * Boot and game loop for Return Drill.
 *
 * Each animation frame: measure real elapsed time, advance the simulation,
 * update debug mode, then draw from whichever camera is active.
 */
import { launchBall, stepBall, type BallState } from './game/ball.ts';
import { BALL_RADIUS, TABLE_TOP_Y, TIME_SCALE } from './game/constants.ts';
import { DEBUG_THROWS } from './game/debugThrows.ts';
import { knobs } from './game/knobs.ts';
import { createSimClock } from './game/simClock.ts';
import { installPoseInput } from './input/installPoseInput.ts';
import { createBallStatusReadout } from './render/ballStatusReadout.ts';
import { installCameraOverlay } from './render/cameraOverlay.ts';
import { createDebugMode } from './render/debugMode.ts';
import { createTableScene } from './render/scene.ts';

const canvas = document.querySelector<HTMLCanvasElement>('#scene');
if (!canvas) throw new Error('index.html must contain <canvas id="scene">');

const tableScene = createTableScene(canvas);
const debug = createDebugMode({ renderer: tableScene.renderer, playCamera: tableScene.playCamera, registry: knobs });
knobs.button({ name: 'Reset all knobs', group: 'Debug', onPress: () => knobs.resetAll() });
installCameraOverlay(knobs); // camera + pose debug overlay: D → "Camera overlay", or ?overlay
installPoseInput(knobs); // pose Swing detector; returns the SwingSource the shot resolver (#13) will consume

/** The one ball in play: at rest on the player's half until something launches it. */
let ball: BallState = launchBall({ x: 0, y: TABLE_TOP_Y + BALL_RADIUS, z: 0.7 }, { x: 0, y: 0, z: 0 });
const simClock = createSimClock();
const ballStatus = createBallStatusReadout();

knobs.button({ name: 'Drop ball (30 cm)', group: 'Ball', onPress: () => (ball = DEBUG_THROWS.drop()) });
knobs.button({ name: 'Throw into net', group: 'Ball', onPress: () => (ball = DEBUG_THROWS.intoNet()) });
knobs.button({ name: 'Throw off table', group: 'Ball', onPress: () => (ball = DEBUG_THROWS.offTable()) });

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

  // Fixed 240 Hz substeps, slowed by TIME_SCALE. Ball events (bounces for the
  // sound, net and out for the rally) are returned by stepBall for later tickets.
  const steps = simClock.advance(elapsedSeconds, TIME_SCALE.value);
  for (let i = 0; i < steps; i++) ball = stepBall(ball).state;

  debug.update(elapsedSeconds);
  ballStatus.update(ball, debug.active);
  tableScene.syncBall(ball.position);
  tableScene.render(debug.camera);
}

tableScene.renderer.setAnimationLoop(frame);
