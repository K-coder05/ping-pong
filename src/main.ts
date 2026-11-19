/**
 * Boot and game loop for Return Drill.
 *
 * Each animation frame: measure real elapsed time, advance the simulation,
 * let the shot resolver strike a due Return and judge its flight, let the
 * Feeder react (rally end, "3, 2, 1", next Feed), update debug mode, then
 * draw from whichever camera is active. Swings arrive between frames from the
 * active `SwingSource`; the game never knows whether that is pose or mouse.
 */
import { launchBall, stepBall, type BallEvent, type BallState } from './game/ball.ts';
import {
  BALL_RADIUS,
  MAX_FRAME_DT,
  MOUSE_SHOULDER_WIDTH,
  PHYSICS_DT,
  SHOW_IDEAL_TIME_MARKER,
  SWING_COOLDOWN_MS,
  SWING_OFF,
  SWING_ON,
  TABLE_TOP_Y,
  TIME_SCALE,
} from './game/constants.ts';
import { DEBUG_THROWS } from './game/debugThrows.ts';
import { createFeeder } from './game/feeder.ts';
import { handedness } from './game/handedness.ts';
import { knobs } from './game/knobs.ts';
import { createListeners } from './game/listeners.ts';
import { createScore } from './game/score.ts';
import { createShotResolver, feedResult, knobResolverParams, type ShotEvent } from './game/shotResolver.ts';
import { createSimClock } from './game/simClock.ts';
import { installPoseInput } from './input/installPoseInput.ts';
import { installMouseInput, swingInputMode } from './input/mouseInput.ts';
import type { SwingSource } from './input/types.ts';
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
const poseSwings = installPoseInput(knobs); // pose Swing detector (the camera starts from the overlay for now)
const hud = createHud();

/** The hitting hand: as saved, or right until the player is asked. */
const hittingHand = () => handedness.hand ?? 'right';

/**
 * The one SwingSource the game listens to: the developer mouse with
 * `?input=mouse` (never offered to players), otherwise pose.
 */
const swings: SwingSource =
  swingInputMode(window.location.search) === 'mouse'
    ? installMouseInput(canvas, {
        params: () => ({ swingOn: SWING_ON.value, swingOff: SWING_OFF.value, cooldownMs: SWING_COOLDOWN_MS.value }),
        hand: hittingHand,
        shoulderWidth: () => MOUSE_SHOULDER_WIDTH.value,
        enabled: () => !debug.active, // in debug mode, drags orbit the camera
      })
    : poseSwings;

/**
 * The one ball in play: at rest on the player's half until something launches
 * it. Anything that launches a ball (a Feed, a Return, a debug throw) replaces
 * it; the Feeder watches whichever ball is here to tell when the rally ends.
 */
let ball: BallState = launchBall({ x: 0, y: TABLE_TOP_Y + BALL_RADIUS, z: 0.7 }, { x: 0, y: 0, z: 0 });
const simClock = createSimClock();
const ballStatus = createBallStatusReadout();

const feeder = createFeeder();
const resolver = createShotResolver({ params: knobResolverParams, hand: hittingHand });
const score = createScore();

/**
 * Hooks for the Paddle and sounds (#6). `shotEvents` carries every resolver
 * event: `accepted` (Paddle animation from Swing Onset, contact due at
 * `contactAtMs`), `contact` (time, position, side, Swing, delta: the contact
 * sound), and the Feed's outcome. `bounces` carries every table bounce.
 */
const shotEvents = createListeners<ShotEvent>();
const bounces = createListeners<Extract<BallEvent, { type: 'bounce' }>>();

const FEEDBACK: Partial<Record<ShotEvent['type'], string>> = { early: 'Early!', late: 'Late!', miss: 'Miss' };

function handleShot(event: ShotEvent): void {
  if (event.type === 'contact') ball = event.ball;
  const text = event.type === 'off-target' ? (event.reason === 'net' ? 'Net' : 'Out') : FEEDBACK[event.type];
  if (text) hud.showFeedback(text);
  const result = feedResult(event);
  if (result === 'returned') score.addReturn();
  else if (result === 'failed') score.breakStreak();
  shotEvents.emit(event);
}

feeder.onFeed((feed) => {
  ball = feed.ball;
  resolver.startFeed(feed);
});
swings.subscribe((swing) => resolver.swing(swing, performance.now()).forEach(handleShot));
score.subscribe(({ streak, best }) => {
  feeder.setStreak(streak); // faster Feeds every FEED_SPEEDUP_EVERY Returns
  hud.showStreak(streak, best);
});
hud.showStreak(score.streak, score.best);

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
  for (const event of ballEvents) if (event.type === 'bounce') bounces.emit(event);

  // Judge the Return in flight, strike a due contact (replacing the ball),
  // or call a Miss, before the Feeder looks at the ball.
  resolver.update(now, ball, ballEvents).forEach(handleShot);

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
