/**
 * Boot and game loop for Return Drill.
 *
 * Each animation frame: measure real elapsed time, advance the simulation,
 * let the shot resolver strike a due Return and judge its flight, let the
 * Feeder react (rally end, "3, 2, 1", next Feed), update debug mode, then
 * draw from whichever camera is active. Swings arrive between frames from the
 * active `SwingSource`; the game never knows whether that is pose or mouse.
 *
 * Without a URL flag, play is with your hand: onboarding starts the camera
 * (asking first, for a first-time player), then asks for the hitting hand and
 * runs Timing calibration if they aren't saved. Swings come only from pose,
 * the Paddle follows the tracked wrist, and the Feeder pauses (with a "Can't
 * see your hand" banner) while the hitting wrist can't be seen.
 *
 * `?input=mouse` swaps in the developer mouse for both and skips onboarding:
 * there is no camera to start and no pose latency to calibrate. The mouse
 * also neither reads nor saves the player's Timing Offset (it would shift the
 * mouse's near-zero-latency Swings); TIMING_OFFSET_MS starts at 0 there.
 */
import { createSounds, unlockAudioOnGesture } from './audio/sounds.ts';
import { launchBall, simulate, stepBall, type BallEvent, type BallState } from './game/ball.ts';
import {
  BALL_DRAW_SCALE,
  BALL_RADIUS,
  CONTACT_ASSIST,
  LATENCY_EXTRAPOLATION,
  LATENCY_EXTRAPOLATION_MS,
  MAX_FRAME_DT,
  MOUSE_SHOULDER_WIDTH,
  PADDLE_MAPPING_RANGE,
  PADDLE_REST_PY,
  PHYSICS_DT,
  SHOW_IDEAL_TIME_MARKER,
  TABLE_TOP_Y,
  TIME_SCALE,
  TIMING_OFFSET_MS,
} from './game/constants.ts';
import { DEBUG_THROWS } from './game/debugThrows.ts';
import { createFeeder } from './game/feeder.ts';
import { handedness } from './game/handedness.ts';
import { knobs } from './game/knobs.ts';
import { createListeners } from './game/listeners.ts';
import { onboardingSteps, runOnboarding } from './game/onboarding.ts';
import { createScore } from './game/score.ts';
import { contactPoint, createShotResolver, feedResult, knobResolverParams, type ShotEvent } from './game/shotResolver.ts';
import { createSimClock } from './game/simClock.ts';
import { timingOffsetStore } from './game/timingOffsetStore.ts';
import type { HandPositionSource } from './input/handPosition.ts';
import { installPoseInput, startCamera } from './input/installPoseInput.ts';
import { installMouseInput, swingInputMode, type MouseInput } from './input/mouseInput.ts';
import { knobSwingParams } from './input/poseInput.ts';
import type { SwingSource } from './input/types.ts';
import { createBallStatusReadout } from './render/ballStatusReadout.ts';
import { installCameraOverlay } from './render/cameraOverlay.ts';
import { createDebugMode } from './render/debugMode.ts';
import { askHandedness } from './render/handednessPrompt.ts';
import { createHud } from './render/hud.ts';
import { createOnboardingScreens } from './render/onboardingScreens.ts';
import { createPaddle } from './render/paddle.ts';
import { createTableScene } from './render/scene.ts';
import { sharedSensing } from './sensing/shared.ts';

const canvas = document.querySelector<HTMLCanvasElement>('#scene');
if (!canvas) throw new Error('index.html must contain <canvas id="scene">');

const tableScene = createTableScene(canvas);
const debug = createDebugMode({ renderer: tableScene.renderer, playCamera: tableScene.playCamera, registry: knobs });
knobs.button({ name: 'Reset all knobs', group: 'Debug', onPress: () => knobs.resetAll() });
installCameraOverlay(knobs); // camera + pose debug overlay: D → "Camera overlay", or ?overlay
const hud = createHud();

/** Developer mouse mode (`?input=mouse`), never offered to players. */
const mouseMode = swingInputMode(window.location.search) === 'mouse';

// Pose Swings, wrist and tracking, once the camera is on and the hand is
// known. In play, the hand comes from onboarding's handedness step (asked
// after the framing instruction), not from a prompt when the camera starts.
const pose = installPoseInput(knobs, mouseMode ? {} : { hand: () => handedness.chosen() });

/** The hitting hand: as saved, or right until the player is asked. */
const hittingHand = () => handedness.hand ?? 'right';

/** The developer mouse, with `?input=mouse` only (never offered to players). */
const mouse: MouseInput | null =
  mouseMode
    ? installMouseInput(canvas, {
        params: knobSwingParams,
        hand: hittingHand,
        shoulderWidth: () => MOUSE_SHOULDER_WIDTH.value,
        enabled: () => !debug.active, // in debug mode, drags orbit the camera
        reachSw: () => PADDLE_MAPPING_RANGE.value, // the canvas spans the table
        restPy: PADDLE_REST_PY,
      })
    : null;

/** The one SwingSource the game listens to: the mouse if on, otherwise pose. */
const swings: SwingSource = mouse ?? pose;

/** Where the hitting wrist is, for the Paddle to follow: the mouse if on, otherwise the tracked wrist. */
const handPositions: HandPositionSource = mouse ?? pose;

/**
 * The saved Timing Offset becomes the TIMING_OFFSET_MS knob's starting value;
 * the resolver (and the Feeder's wait for a late Swing) read the knob. Only
 * calibration saves: dragging the knob (or "Reset all knobs") changes this
 * page's play but not what is saved, so a returning player's next visit still
 * uses their measured offset. Redo calibration to replace it.
 */
if (!mouse && timingOffsetStore.offsetMs !== null) TIMING_OFFSET_MS.set(timingOffsetStore.offsetMs);

const onboardingScreens = createOnboardingScreens();
/** Whether onboarding has finished, so the drill may feed. */
let drillStarted = false;
/** Whether Timing calibration is running: its Swings are not for the resolver, and the Feeder waits. */
let calibrating = false;

/** Run Timing calibration and use (and, in play, save) the Timing Offset it measures. */
async function calibrate(cancellable: boolean): Promise<void> {
  calibrating = true;
  try {
    const video = mouse ? null : (await sharedSensing()).video;
    const offsetMs = await onboardingScreens.calibrate({ video, swings, cancellable });
    if (offsetMs === null) return;
    TIMING_OFFSET_MS.set(offsetMs); // snapped to the knob's 5 ms grid and clamped to its range
    if (!mouse) timingOffsetStore.save(TIMING_OFFSET_MS.value);
    console.info(`Timing Offset: measured ${offsetMs} ms, using ${TIMING_OFFSET_MS.value} ms`);
  } finally {
    calibrating = false;
  }
}

/**
 * Onboarding: the steps this player still needs (SPEC "Onboarding for the
 * prototype"), then the drill. Starting the camera lives here, in its first
 * step; if it can't start, the player is told why and can try again.
 */
const steps = onboardingSteps({
  input: mouse ? 'mouse' : 'pose',
  handSaved: handedness.hand !== null,
  timingOffsetSaved: timingOffsetStore.offsetMs !== null,
});
void runOnboarding(steps, {
  'ask-camera': () => onboardingScreens.askCamera(startCamera),
  'start-camera': () => onboardingScreens.startCamera(startCamera),
  framing: async () => onboardingScreens.framing((await sharedSensing()).video),
  handedness: async () => handedness.set(await askHandedness()),
  calibration: () => calibrate(false),
}).then(
  () => (drillStarted = true),
  (error: unknown) => console.error('Onboarding failed', error),
);

knobs.button({
  name: 'Redo calibration',
  group: 'Timing',
  onPress: () => {
    if (!drillStarted || calibrating) return; // onboarding still running, or already calibrating
    calibrate(true).catch((error: unknown) => console.error('Calibration failed', error));
  },
});

/** Whether the Feeder must wait for the player's hand: never with the mouse. */
const waitingForHand = (): boolean => !mouse && pose.tracking !== 'tracked';
/** Whether to show "Can't see your hand": once pose is running, until the wrist is first seen and whenever it is lost. */
const handLost = (): boolean => !mouse && pose.tracking === 'lost';
/** Whether the drill is on: onboarding done and not recalibrating. */
const drilling = (): boolean => drillStarted && !calibrating;

/**
 * The one ball in play: at rest on the player's half until something launches
 * it. Anything that launches a ball (a Feed, a Return, a debug throw) replaces
 * it; the Feeder watches whichever ball is here to tell when the rally ends.
 */
let ball: BallState = launchBall({ x: 0, y: TABLE_TOP_Y + BALL_RADIUS, z: 0.7 }, { x: 0, y: 0, z: 0 });
const simClock = createSimClock();
const ballStatus = createBallStatusReadout();

const feeder = createFeeder();
const sounds = createSounds();
unlockAudioOnGesture(sounds);

/**
 * The Paddle: drawn for feel, never deciding a Return (ADR 0001). With
 * contact assist it eases onto the ball where the resolver will strike it:
 * the ball in play, simulated ahead to the contact moment.
 */
const paddle = createPaddle({
  params: () => ({
    rangeSw: PADDLE_MAPPING_RANGE.value,
    contactAssist: CONTACT_ASSIST.value,
    latencyExtrapolation: LATENCY_EXTRAPOLATION.value,
    latencyMs: LATENCY_EXTRAPOLATION_MS.value,
    ballDrawScale: BALL_DRAW_SCALE.value,
  }),
  hand: hittingHand,
  predictContact: (contactAtMs, nowMs) => {
    const simSeconds = (Math.max(0, contactAtMs - nowMs) / 1000) * TIME_SCALE.value;
    return contactPoint(simulate(ball, { maxTime: simSeconds }).state.position);
  },
});

const resolver = createShotResolver({ params: knobResolverParams, hand: hittingHand });
const score = createScore();

/**
 * `shotEvents` carries every resolver event: `accepted` starts the Paddle's
 * Swing animation and schedules the contact tock for `contactAtMs`;
 * `contact` (the frame the Return launches) pins the Paddle's contact frame
 * and point; then the Feed's outcome. `bounces` carries every table bounce,
 * each one a bounce tock.
 */
const shotEvents = createListeners<ShotEvent>();
const bounces = createListeners<Extract<BallEvent, { type: 'bounce' }>>();

shotEvents.subscribe((event) => {
  if (event.type === 'accepted') {
    paddle.swing({ onsetMs: event.swing.t, contactAtMs: event.contactAtMs, side: event.swing.side });
    // Scheduled now, so it is heard exactly at the contact moment.
    sounds.contact(event.contactAtMs);
  } else if (event.type === 'contact') {
    paddle.contact(event.atMs, event.position);
  }
});
bounces.subscribe(() => sounds.bounce());

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
swings.subscribe((swing) => {
  if (drilling()) resolver.swing(swing, performance.now()).forEach(handleShot);
});
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
  // background tab doesn't fire a Feed the moment it comes back. No new Feed
  // before onboarding finishes, while recalibrating, or while the hand can't
  // be seen; a Feed in flight plays out.
  feeder.setPaused(!drilling() || waitingForHand());
  hud.showHandLost(drilling() && handLost());
  feeder.update({ realSeconds: Math.min(elapsedSeconds, MAX_FRAME_DT), simSeconds: steps * PHYSICS_DT, nowMs: now }, ball);
  hud.showCountdown(feeder.countdown);

  debug.update(elapsedSeconds);
  ballStatus.update(ball, debug.active);
  tableScene.syncBall(ball.position);
  tableScene.syncPaddle(paddle.update(now, handPositions.latest));
  tableScene.syncIdealTimeMarker(idealTimeMarker());
  tableScene.render(debug.camera);
}

tableScene.renderer.setAnimationLoop(frame);
