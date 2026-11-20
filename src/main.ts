/**
 * Boot and game loop for Return Drill.
 *
 * The game itself (ball physics, the Feeder, the shot resolver, the Streak)
 * runs in the headless `GameCore` (`game/core.ts`). Each animation frame:
 * measure real elapsed time, tell the core whether it is paused, advance it
 * one frame, update debug mode, then draw from whichever camera is active.
 * Swings arrive between frames from the active `SwingSource` and go straight
 * to the core; the game never knows whether they come from pose or mouse. The
 * Paddle, sounds and HUD follow the core's Shot and bounce events.
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
import { simulate } from './game/ball.ts';
import {
  BALL_DRAW_SCALE,
  CONTACT_ASSIST,
  LATENCY_EXTRAPOLATION,
  LATENCY_EXTRAPOLATION_MS,
  MAX_FRAME_DT,
  MOUSE_SHOULDER_WIDTH,
  PADDLE_MAPPING_RANGE,
  PADDLE_REST_PY,
  SHOW_IDEAL_TIME_MARKER,
  TIME_SCALE,
  TIMING_OFFSET_MS,
} from './game/constants.ts';
import { createGameCore, gameModeFromSearch } from './game/core.ts';
import { DEBUG_THROWS } from './game/debugThrows.ts';
import { makeRng, seedFromSearch } from './util/rng.ts';
import { createBrain } from './opponent/brain.ts';
import { DIFFICULTIES, difficultyFromSearch } from './opponent/difficulty.ts';
import { BODY_PARAMS, READY_POSE, followOpponentPlan, planBody, type BodyPlan, type BodyPose } from './opponent/motion.ts';
import { handedness } from './game/handedness.ts';
import { knobs } from './game/knobs.ts';
import { onboardingSteps, runOnboarding } from './game/onboarding.ts';
import { createPlayLogRecorder } from './game/playLog.ts';
import { contactPoint, knobResolverParams, type ShotEvent } from './game/shotResolver.ts';
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
 * The saved Timing Offset becomes the TIMING_OFFSET_MS knob's starting value
 * (and what "Reset all knobs" returns it to); the resolver (and the Feeder's
 * wait for a late Swing) read the knob. Only calibration saves: dragging the
 * knob changes this page's play but not what is saved, so a returning
 * player's next visit still uses their measured offset. Redo calibration to
 * replace it.
 */
function applySavedTimingOffset(): void {
  if (!mouse && timingOffsetStore.offsetMs !== null) TIMING_OFFSET_MS.set(timingOffsetStore.offsetMs);
}
applySavedTimingOffset();
knobs.button({
  name: 'Reset all knobs',
  group: 'Debug',
  onPress: () => {
    knobs.resetAll();
    applySavedTimingOffset(); // the player's measurement, not a tuning default
  },
});

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
const onboardingPlan = onboardingSteps({
  input: mouseMode ? 'mouse' : 'pose',
  handSaved: handedness.hand !== null,
  timingOffsetSaved: timingOffsetStore.offsetMs !== null,
});
void runOnboarding(onboardingPlan, {
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
/**
 * Whether to show "Can't see your hand": once pose is running, until the wrist
 * is first seen and whenever it is lost, during the drill and calibration
 * (whose Swings also need the wrist tracked).
 */
const handLost = (): boolean => !mouse && pose.tracking === 'lost';
/** Whether the drill is on: onboarding done and not recalibrating. */
const drilling = (): boolean => drillStarted && !calibrating;

/**
 * Whether the core is paused: no new Feed and no Swings before onboarding
 * finishes, while recalibrating (its Swings are not for the resolver), or
 * while the hand can't be seen; a Feed in flight plays out.
 */
const corePaused = (): boolean => !drilling() || waitingForHand();

const ballStatus = createBallStatusReadout();

/** Every random draw in the game comes from this one seeded source: `?seed=<n>` replays a session. */
const seed = seedFromSearch(window.location.search);
console.log(`[seed] ${seed} (reload with ?seed=${seed} to replay)`);

/**
 * The game: the ball in play, the Feeder, the shot resolver and the Streak.
 * `?mode=match` plays Rallies against the Opponent instead of Return Drill, at
 * the Difficulty `?difficulty=novice|intermediate|expert` asks for
 * (Intermediate otherwise); it never changes during the Match.
 */
const mode = gameModeFromSearch(window.location.search);
const difficulty = difficultyFromSearch(window.location.search);
if (mode === 'match') console.log(`[match] Difficulty: ${difficulty} (?difficulty=novice|intermediate|expert)`);
const core = createGameCore({
  random: makeRng(seed),
  resolverParams: knobResolverParams,
  hand: hittingHand,
  mode,
  opponent: createBrain(DIFFICULTIES[difficulty]),
});
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
    return contactPoint(simulate(core.ball, { maxTime: simSeconds }).state.position);
  },
});

const FEEDBACK: Partial<Record<ShotEvent['type'], string>> = { early: 'Early!', late: 'Late!', miss: 'Miss' };

/**
 * Every resolver event, after the core has acted on it (the Return made the
 * ball in play, the Streak updated): the HUD shows the feedback and Streak;
 * `accepted` starts the Paddle's Swing animation and schedules the contact
 * tock for `contactAtMs`; `contact` (the frame the Return launches) pins the
 * Paddle's contact frame and point. Every table bounce is a bounce tock.
 */
core.onShot((event) => {
  const text = event.type === 'off-target' ? (event.reason === 'net' ? 'Net' : 'Out') : FEEDBACK[event.type];
  if (text) hud.showFeedback(text);
  hud.showStreak(core.streak.streak, core.streak.best);
  if (event.type === 'accepted') {
    paddle.swing({ onsetMs: event.swing.t, contactAtMs: event.contactAtMs, side: event.swing.side });
    // Scheduled now, so it is heard exactly at the contact moment.
    sounds.contact(event.contactAtMs);
  } else if (event.type === 'contact') {
    paddle.contact(event.atMs, event.position);
  }
});
core.onBounce(() => sounds.bounce());

/** The play log: one entry per Shot coming to the player (fit with `npm run fit-player`). */
const playLog = createPlayLogRecorder({ mode: core.mode });
core.onIncoming((incoming) => {
  if (incoming.receiver === 'player') playLog.startFeed(incoming.idealAtMs);
});
core.onShot((event) => playLog.shot(event));
knobs.button({
  name: 'Download play log',
  group: 'Debug',
  onPress: () => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([playLog.toText()], { type: 'application/x-ndjson' }));
    link.download = `play-log-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
    link.click();
    URL.revokeObjectURL(link.href);
  },
});

swings.subscribe((swing) => {
  // Pose emits Swings only while the wrist is tracked, which may be newer
  // than the last frame's pause: refresh it first, so the Swing is judged
  // exactly when the drill is on.
  core.setPaused(corePaused());
  core.swing(swing, performance.now());
});
hud.showStreak(core.streak.streak, core.streak.best);

knobs.button({ name: 'Drop ball (30 cm)', group: 'Ball', onPress: () => core.setBall(DEBUG_THROWS.drop()) });
knobs.button({ name: 'Throw into net', group: 'Ball', onPress: () => core.setBall(DEBUG_THROWS.intoNet()) });
knobs.button({ name: 'Throw off table', group: 'Ball', onPress: () => core.setBall(DEBUG_THROWS.offTable()) });

/** Simulated seconds the Ideal Time marker stays lit after the Feed reaches it. */
const IDEAL_MARKER_HOLD_S = 0.3;

/** The debug Ideal Time marker for the current Feed, or null while there is nothing to show. */
function idealTimeMarker() {
  const ideal = core.feeder.currentFeed?.idealTime;
  if (!SHOW_IDEAL_TIME_MARKER.value || !ideal) return null;
  const sinceFeed = core.feeder.simSecondsSinceFeed;
  if (sinceFeed > ideal.simSeconds + IDEAL_MARKER_HOLD_S) return null;
  return { position: ideal.position, reached: sinceFeed >= ideal.simSeconds };
}

/**
 * The Opponent's body (Match only): it plays the core's `opponentPlan`, held
 * through the follow-through after the core clears it at the strike. Purely
 * cosmetic (ADR 0002): nothing here feeds back into the core.
 */
let opponentBodyPlan: BodyPlan | null = null;
let opponentPose: BodyPose = READY_POSE;

/** One frame of the Opponent's body: simulated time runs at TIME_SCALE, capped like the core's. */
function updateOpponentBody(nowMs: number, elapsedSeconds: number): BodyPose {
  const timeScale = TIME_SCALE.value;
  opponentBodyPlan = followOpponentPlan(core.opponentPlan, opponentBodyPlan, (incoming) => ((nowMs - incoming.launchedAtMs) / 1000) * timeScale);
  opponentPose = planBody(opponentPose, opponentBodyPlan, Math.min(elapsedSeconds, MAX_FRAME_DT) * timeScale, BODY_PARAMS[difficulty]);
  return opponentPose;
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

  // Physics, the shot resolver, then the Feeder (see `game/core.ts`). The
  // pause only stops new Feeds and Swings, so setting it first is the same as
  // setting it between the resolver and the Feeder.
  core.setPaused(corePaused());
  hud.showHandLost((drilling() || calibrating) && handLost());
  core.frame({ nowMs: now, elapsedSeconds });
  hud.showCountdown(core.feeder.countdown);

  debug.update(elapsedSeconds);
  ballStatus.update(core.ball, debug.active);
  tableScene.syncBall(core.ball.position, core.ball.spin);
  tableScene.syncPaddle(paddle.update(now, handPositions.latest));
  tableScene.syncIdealTimeMarker(idealTimeMarker());
  tableScene.syncOpponent(core.mode === 'match' ? updateOpponentBody(now, elapsedSeconds) : null);
  tableScene.render(debug.camera);
}

tableScene.renderer.setAnimationLoop(frame);
