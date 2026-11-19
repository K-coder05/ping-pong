/**
 * Boot and game loop for Return Drill.
 *
 * Each animation frame: measure real elapsed time, advance the simulation,
 * let the Feeder react (rally end, "3, 2, 1", next Feed), update debug mode,
 * then draw from whichever camera is active.
 */
import { launchBall, stepBall, type BallEvent, type BallState } from './game/ball.ts';
import { BALL_RADIUS, MAX_FRAME_DT, PHYSICS_DT, SHOW_IDEAL_TIME_MARKER, TABLE_TOP_Y, TIME_SCALE } from './game/constants.ts';
import { DEBUG_THROWS } from './game/debugThrows.ts';
import { createFeeder } from './game/feeder.ts';
import { knobs } from './game/knobs.ts';
import { createSimClock } from './game/simClock.ts';
import { installPoseInput } from './input/installPoseInput.ts';
import { createBallStatusReadout } from './render/ballStatusReadout.ts';
import { installCameraOverlay } from './render/cameraOverlay.ts';
import { createDebugMode } from './render/debugMode.ts';
import { createHud } from './render/hud.ts';
import { createTableScene } from './render/scene.ts';

const canvas = document.querySelector<HTMLCanvasElement>('#scene');
if (!canvas) throw new Error('index.html must contain <canvas id="scene">');

const tableScene = createTableScene(canvas);
const debug = createDebugMode({ renderer: tableScene.renderer, playCamera: tableScene.playCamera, registry: knobs });
knobs.button({ name: 'Reset all knobs', group: 'Debug', onPress: () => knobs.resetAll() });
installCameraOverlay(knobs); // camera + pose debug overlay: D → "Camera overlay", or ?overlay
installPoseInput(knobs); // pose Swing detector; returns the SwingSource the shot resolver (#13) will consume
const hud = createHud();

/**
 * The one ball in play: at rest on the player's half until something launches
 * it. Anything that launches a ball (a Feed, a Return, a debug throw) replaces
 * it; the Feeder watches whichever ball is here to tell when the rally ends.
 */
let ball: BallState = launchBall({ x: 0, y: TABLE_TOP_Y + BALL_RADIUS, z: 0.7 }, { x: 0, y: 0, z: 0 });
const simClock = createSimClock();
const ballStatus = createBallStatusReadout();

const feeder = createFeeder();
feeder.onFeed((feed) => (ball = feed.ball));

knobs.button({ name: 'Drop ball (30 cm)', group: 'Ball', onPress: () => (ball = DEBUG_THROWS.drop()) });
knobs.button({ name: 'Throw into net', group: 'Ball', onPress: () => (ball = DEBUG_THROWS.intoNet()) });
knobs.button({ name: 'Throw off table', group: 'Ball', onPress: () => (ball = DEBUG_THROWS.offTable()) });

/** Simulated seconds the Ideal Time marker stays lit after the Feed reaches it. */
const IDEAL_MARKER_HOLD_S = 0.3;

/** The debug Ideal Time marker for the current Feed, or null while there is nothing to show. */
function idealTimeMarker() {
  const ideal = feeder.currentFeed?.idealTime;
  if (!SHOW_IDEAL_TIME_MARKER.value || !ideal) return null;
  const sinceFeed = feeder.simSecondsSinceFeed;
  if (sinceFeed > ideal.simSeconds + IDEAL_MARKER_HOLD_S) return null;
  return { position: ideal.position, reached: sinceFeed >= ideal.simSeconds };
}

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

  // Fixed 240 Hz substeps, slowed by TIME_SCALE. This frame's ball events
  // (bounces for the sound, net and out for the rally) are collected for the
  // bounce sound and the shot resolver to consume.
  const steps = simClock.advance(elapsedSeconds, TIME_SCALE.value);
  const ballEvents: BallEvent[] = [];
  for (let i = 0; i < steps; i++) {
    const step = stepBall(ball);
    ball = step.state;
    ballEvents.push(...step.events);
  }

  // The pause and "3, 2, 1" run on real time, capped like the simulation so a
  // background tab doesn't fire a Feed the moment it comes back.
  feeder.update({ realSeconds: Math.min(elapsedSeconds, MAX_FRAME_DT), simSeconds: steps * PHYSICS_DT, nowMs: now }, ball);
  hud.showCountdown(feeder.countdown);

  debug.update(elapsedSeconds);
  ballStatus.update(ball, debug.active);
  tableScene.syncBall(ball.position);
  tableScene.syncIdealTimeMarker(idealTimeMarker());
  tableScene.render(debug.camera);
}

tableScene.renderer.setAnimationLoop(frame);
