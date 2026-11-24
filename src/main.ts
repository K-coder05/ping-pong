/**
 * Boot and game loop for Return Drill and Matches.
 *
 * The game itself (ball physics, the Feeder, the shot resolver, the Streak)
 * runs in the headless `GameCore` (`game/core.ts`). Each animation frame:
 * measure real elapsed time, tell the core whether it is paused, advance it
 * one frame, update debug mode, then draw from whichever camera is active.
 * Swings arrive between frames from the active `SwingSource` and go straight
 * to the core; the game never knows whether they come from pose or mouse. The
 * Paddle, sounds and HUD follow the core's Shot and bounce events.
 *
 * The Input (spec P3-e): a `?input=` developer flag, else the player's
 * remembered choice, else the Input picker (`render/inputPicker.ts`) asks,
 * Camera or Phone, before anything else. The start screen shows the Input,
 * and changing it there saves the new choice and reloads the page.
 *
 * With the Camera, onboarding starts the camera (asking first, for a
 * first-time player), then asks for the hitting hand and runs Timing
 * calibration if they aren't saved. Swings come only from pose, the Paddle
 * follows the tracked wrist, and the Feeder pauses (with a "Can't see your
 * hand" banner) while the hitting wrist can't be seen.
 *
 * With the Phone, onboarding shows the safety prompt (first time only), the
 * pairing QR code and room code until the Phone connects, the hand if not
 * saved, Zeroing, Timing calibration if the Phone has no Timing Offset, and
 * Continue once it is connected and Zeroed. Swings and the Paddle come from
 * the Phone Input; play waits while it isn't sending. If it goes away after
 * setup (its page locked, hid or reloaded: `phone/presence.ts`), play pauses
 * the same way as a lost hand (`game/handPause.ts`), with "Phone
 * disconnected: unlock your phone"; the Phone page rejoins the same room on
 * its own, and play resumes after the usual wait and "3, 2, 1". Away for
 * PHONE_PAIRING_AGAIN_MS, the pairing QR code shows again, in case its page
 * was closed for good. In debug mode the Phone log is recorded for fixtures
 * (debug panel, Phone group).
 *
 * Each Input reads and saves its own Timing Offset (`timingOffsetStore`).
 *
 * After onboarding, the start screen (`render/screens.ts`, spec P2-h2)
 * offers Return Drill or a Match (Difficulty, 1 Game or best of 3); a Match
 * with no saved Timing Offset runs Timing calibration first. Each choice
 * plays a fresh `GameCore` (a session); the last one's listeners are dropped.
 * When a Match ends, the Game-over screen offers Rematch, Change Difficulty
 * and Back to start; Esc during play goes back to the start screen. The
 * developer URL flags (`?mode=`, `?difficulty=`, `?input=mouse`, `?seed=`)
 * skip the start screen and play as they ask straight after onboarding.
 *
 * `?input=mouse` swaps in the developer mouse for both and skips onboarding:
 * there is no camera to start and no pose latency to calibrate. The mouse
 * also neither reads nor saves the player's Timing Offset (it would shift the
 * mouse's near-zero-latency Swings); TIMING_OFFSET_MS starts at 0 there. The
 * mouse is never offered to players.
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
import { createGameCore, DEFAULT_MATCH_CONFIG, type GameCore } from './game/core.ts';
import type { MatchConfig } from './game/match.ts';
import { DEBUG_THROWS } from './game/debugThrows.ts';
import { makeRng, seedFromSearch } from './util/rng.ts';
import { DEFAULT_DIFFICULTY } from './opponent/difficulty.ts';
import { BODY_PARAMS, READY_POSE, followOpponentPlan, planBody, type BodyParams, type BodyPlan, type BodyPose } from './opponent/motion.ts';
import { handedness } from './game/handedness.ts';
import { knobs } from './game/knobs.ts';
import { matchStartSteps, onboardingSteps, phoneSafetyStore, runOnboarding, type Input, type InputMode } from './game/onboarding.ts';
import { createPlayLogRecorder, type PlayLogRecorder } from './game/playLog.ts';
import { contactPoint, feedResult, knobResolverParams, type ShotEvent } from './game/shotResolver.ts';
import { timingOffsetStore } from './game/timingOffsetStore.ts';
import type { HandPositionSource } from './input/handPosition.ts';
import { installPoseInput, startCamera } from './input/installPoseInput.ts';
import { installMouseInput, type MouseInput } from './input/mouseInput.ts';
import { createPhoneInput, type PhoneInput } from './input/phoneInput.ts';
import { knobSwingParams } from './input/poseInput.ts';
import type { SwingEvent, SwingSource } from './input/types.ts';
import { createBallStatusReadout } from './render/ballStatusReadout.ts';
import { installCameraOverlay } from './render/cameraOverlay.ts';
import { createDebugMode, installPhoneLogDownload } from './render/debugMode.ts';
import { askHandedness } from './render/handednessPrompt.ts';
import { inputChoice, inputFromSearch, phoneReadiness, pickInput, type PhoneReadiness } from './render/inputPicker.ts';
import { createHud } from './render/hud.ts';
import { matchHud, type HudEvent } from './render/hudModel.ts';
import { createOnboardingScreens } from './render/onboardingScreens.ts';
import { createPaddle } from './render/paddle.ts';
import {
  coreOptionsFromChoice,
  createScreens,
  nextScreen,
  playingFromSearch,
  skipsStartScreen,
  START_SCREEN,
  watchMatch,
  type ScreenAction,
  type ScreenState,
  type StartChoice,
} from './render/screens.ts';
import { createTableScene } from './render/scene.ts';
import { sharedSensing } from './sensing/shared.ts';
import { openLaptopLink, type SignalingLink } from './phone/link.ts';
import { mountPairing } from './phone/pairing.ts';
import { signalUrl } from './phone/signalUrl.ts';
import { ClockSync } from './phone/clock.ts';
import { mountLatencyOverlay } from './phone/latencyOverlay.ts';
import type { LinkStatus } from './phone/types.ts';
import { hapticFor } from './phone/haptics.ts';
import { watchPhonePresence } from './phone/presence.ts';
import { handPause, type HandPause } from './game/handPause.ts';

const canvas = document.querySelector<HTMLCanvasElement>('#scene');
if (!canvas) throw new Error('index.html must contain <canvas id="scene">');

const tableScene = createTableScene(canvas);
const debug = createDebugMode({ renderer: tableScene.renderer, playCamera: tableScene.playCamera, registry: knobs });
installCameraOverlay(knobs); // camera + pose debug overlay: D → "Camera overlay", or ?overlay
const hud = createHud();

/** The developer `?input=` flag (`mouse`, `phone`, `camera`), which overrides the Input picker. */
const flagInput = inputFromSearch(window.location.search);
/** Developer mouse mode (`?input=mouse`), never offered to players. */
const mouseMode = flagInput === 'mouse';
/** What play swings with: decided by `boot` (the flag, the remembered choice or the Input picker); null until then. */
let inputMode: InputMode | null = mouseMode ? 'mouse' : null;
/** Whether the Camera's pose drives play. */
const poseMode = (): boolean => inputMode === 'camera';
/** The Input whose Timing Offset play reads and saves: none with the developer mouse. */
const timingInput = (): Input | null => (inputMode === 'camera' || inputMode === 'phone' ? inputMode : null);

// Pose Swings, wrist and tracking, once the camera is on and the hand is
// known. With the Camera, the hand comes from onboarding's handedness step
// (asked after the framing instruction), not from a prompt when the camera
// starts; otherwise (the debug overlay) the saved hand, or ask then.
const pose = installPoseInput(knobs, {
  hand: async () => (poseMode() ? handedness.chosen() : (handedness.hand ?? (await askHandedness()))),
});

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

/** The Phone, once it is the Input: paired by QR code in onboarding. */
let phone: PhoneInput | null = null;
/** The Phone's link, for pairing and setup. */
let phoneLink: SignalingLink | null = null;
/** Whether the paired Phone is away (its page locked, hid or reloaded), for the disconnect pause. */
let phonePresence: { readonly away: boolean; readonly awayMs: number } | null = null;
/** ms the Phone is away after setup before the pairing QR code shows again, in case its page was closed for good. */
const PHONE_PAIRING_AGAIN_MS = 20_000;
/** Show or hide the pairing QR code after setup; returns whether it shows. Called every frame. */
let syncPairingAgain: () => boolean = () => false;

function installPhone(): PhoneInput {
  const now = () => performance.now();
  const link = openLaptopLink({ signalUrl: signalUrl(), now });
  phoneLink = link;
  phonePresence = watchPhonePresence(link, now);
  // After setup: shown again once the Phone has been away a while (onboarding pairs it the first time).
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:5;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(12,14,20,0.92);color:#e6e9ef;font-family:system-ui,sans-serif';
  document.body.append(overlay);
  mountPairing(overlay, link);
  const hint = document.createElement('p');
  hint.textContent = 'Scan the code with your Phone and tap “Tap to start” on it. Then hold it like the handle of a bat and tap Zero.';
  overlay.append(hint);
  let shown = true;
  syncPairingAgain = () => {
    const show = onboarded && phonePresence!.awayMs > PHONE_PAIRING_AGAIN_MS;
    if (show !== shown) overlay.style.display = (shown = show) ? 'flex' : 'none';
    return show;
  };
  syncPairingAgain();
  installPhoneLogDownload({ registry: knobs, link, recording: () => debug.active });
  // Phone time onto the laptop's clock (P3-d): one ClockSync per link, running while the Phone is connected.
  // Swings before its first full round use the provisional estimate (the best answer so far, within half a
  // round trip): it is in place within one round trip of connecting, long before the player can Zero and swing.
  const sync = new ClockSync(link, now);
  const followLink = (s: LinkStatus) => (s === 'connected' || s === 'relay' ? sync.start() : sync.stop());
  link.onStatus(followLink);
  followLink(link.status());
  mountLatencyOverlay(document.body, link, sync, now); // hidden; L shows it
  return createPhoneInput(link, now, sync, hittingHand);
}

/** The one SwingSource the game listens to: the mouse or Phone if on, otherwise pose. */
const swings = (): SwingSource => mouse ?? phone ?? pose;

/** Where the hitting wrist is, for the Paddle to follow: the mouse or Phone if on, otherwise the tracked wrist. */
const handPositions = (): HandPositionSource => mouse ?? phone ?? pose;

/** The Phone's setup state: connected (directly or by relay) and Zeroed. */
function phoneState(): PhoneReadiness {
  return phoneReadiness({ status: phoneLink?.status() ?? 'idle', zeroed: phone?.zeroed ?? false });
}

/**
 * The saved Timing Offset becomes the TIMING_OFFSET_MS knob's starting value
 * (and what "Reset all knobs" returns it to); the resolver (and the Feeder's
 * wait for a late Swing) read the knob. Only calibration saves: dragging the
 * knob changes this page's play but not what is saved, so a returning
 * player's next visit still uses their measured offset. Redo calibration to
 * replace it.
 */
function applySavedTimingOffset(): void {
  const input = timingInput();
  const saved = input ? timingOffsetStore.offsetMsFor(input) : null;
  if (saved !== null) TIMING_OFFSET_MS.set(saved);
}
knobs.button({
  name: 'Reset all knobs',
  group: 'Debug',
  onPress: () => {
    knobs.resetAll();
    applySavedTimingOffset(); // the player's measurement, not a tuning default
  },
});

const onboardingScreens = createOnboardingScreens();
/** Whether onboarding has finished. */
let onboarded = false;
/** Whether Timing calibration is running: its Swings are not for the resolver, and the game waits. */
let calibrating = false;
/** Whether the current session is being played: no screen up, and not calibrating before a Match. */
let playing = false;

/**
 * Run Timing calibration and use (and, in play, save) the Timing Offset it
 * measures. Resolves true once measured, false if the player cancelled.
 */
async function calibrate(cancellable: boolean): Promise<boolean> {
  calibrating = true;
  try {
    const video = poseMode() ? (await sharedSensing()).video : null;
    const offsetMs = await onboardingScreens.calibrate({ video, swings: swings(), cancellable });
    if (offsetMs === null) return false;
    TIMING_OFFSET_MS.set(offsetMs); // snapped to the knob's 5 ms grid and clamped to its range
    const input = timingInput();
    if (input) timingOffsetStore.save(input, TIMING_OFFSET_MS.value);
    console.info(`Timing Offset: measured ${offsetMs} ms, using ${TIMING_OFFSET_MS.value} ms`);
    return true;
  } finally {
    calibrating = false;
  }
}

/**
 * Whether the game must wait for the player's hand, and the banner to show
 * (during play and calibration, whose Swings also need the hand): never with
 * the mouse; with the Camera, until the wrist is tracked ("Can't see your
 * hand" once it is lost); with the Phone, until it is Zeroed and sending, and
 * while it is away ("Phone disconnected: unlock your phone").
 */
const handSignal = (): HandPause =>
  handPause(
    phone
      ? { input: 'phone', sending: phone.latest !== null, away: phonePresence!.away }
      : poseMode()
        ? { input: 'camera', tracking: pose.tracking }
        : { input: 'mouse' },
  );
const waitingForHand = (): boolean => handSignal().waiting;

/**
 * Whether the core is paused: no new Feed or Serve and no Swings outside play
 * (onboarding, a screen up, calibration: its Swings are not for the resolver)
 * or while the hand can't be seen; a Feed in flight plays out, and a Rally in
 * a Match is replayed.
 */
const corePaused = (): boolean => !playing || calibrating || waitingForHand();

const ballStatus = createBallStatusReadout();

/**
 * Every random draw in the game comes from one seeded source: `?seed=<n>`
 * replays a session. The first session's core draws from `makeRng(seed)`
 * itself; each later one (a Rematch, a new choice) from its own seed, drawn
 * in turn from a stream derived from `seed`, and logged so that session can
 * be replayed as the first one.
 */
const seed = seedFromSearch(window.location.search);
console.log(`[seed] ${seed} (reload with ?seed=${seed} to replay)`);
const sessionSeeds = makeRng(seed ^ 0x9e3779b9);
let sessionCount = 0;
function nextSessionSeed(): number {
  return sessionCount++ === 0 ? seed : Math.floor(sessionSeeds() * 2 ** 32);
}

const sounds = createSounds();
unlockAudioOnGesture(sounds);

/**
 * The game: the ball in play, the Feeder, the shot resolver and the Streak,
 * or a Match against the Opponent at the chosen Difficulty (it never changes
 * during the Match). A new one for each session (`startSession`).
 */
let core: GameCore;

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

/**
 * Whether a Rally is in progress, for holding a Phone Zeroing back (see
 * `PhoneInput.setZeroHold`). In a Match: from a Shot (the Serve) to the Rally
 * End or a Let. In Return Drill: from a Feed coming to the player to its result.
 */
let rallyOn = false;

const FEEDBACK: Partial<Record<ShotEvent['type'], string>> = { early: 'Early!', late: 'Late!', miss: 'Miss' };

/** The current session's Match rules (for the HUD) and the Opponent body's Difficulty. */
let matchConfig: Readonly<MatchConfig> = DEFAULT_MATCH_CONFIG;
let bodyParams: Readonly<BodyParams> = BODY_PARAMS[DEFAULT_DIFFICULTY];
/** The latest Match event, for the HUD's banner. */
let lastMatchEvent: HudEvent | null = null;
/** Every session's play log, oldest first: one download holds them all. */
const playLogs: PlayLogRecorder[] = [];
/** Stops listening to the current session's core. */
let endSession: () => void = () => {};

/**
 * The Opponent's body (Match only): it plays the core's `opponentPlan`, held
 * through the follow-through after the core clears it at the strike. Purely
 * cosmetic (ADR 0002): nothing here feeds back into the core.
 */
let opponentBodyPlan: BodyPlan | null = null;
let opponentPose: BodyPose = READY_POSE;

/** How long the last Point's banner shows before the Game-over screen, ms. */
const GAME_OVER_DELAY_MS = 1800;

/**
 * Start a session: a fresh core for `choice`, with the Paddle, sounds, HUD,
 * play log and (in a Match) the Game-over tally following its events. The
 * last session's listeners are dropped first.
 */
function startSession(choice: StartChoice): void {
  endSession();
  const sessionSeed = nextSessionSeed();
  const options = coreOptionsFromChoice(choice);
  core = createGameCore({ random: makeRng(sessionSeed), resolverParams: knobResolverParams, hand: hittingHand, ...options });
  const session = core;
  matchConfig = options.match ?? DEFAULT_MATCH_CONFIG;
  bodyParams = BODY_PARAMS[choice.mode === 'match' ? choice.difficulty : DEFAULT_DIFFICULTY];
  lastMatchEvent = null;
  opponentBodyPlan = null;
  opponentPose = READY_POSE;
  if (choice.mode === 'match') {
    console.log(
      `[match] ${choice.difficulty}, best of ${choice.bestOf}, seed ${sessionSeed}` +
        ` (replay a one-Game Match with ?seed=${sessionSeed}&mode=match&difficulty=${choice.difficulty})`,
    );
  } else if (sessionCount > 1) {
    console.log(`[drill] seed ${sessionSeed} (replay with ?seed=${sessionSeed})`);
  }

  const off: (() => void)[] = [];
  rallyOn = false;
  off.push(
    session.onRally((e) => {
      if (e.type === 'shot') rallyOn = true;
      else if (e.type === 'end' || (e.type === 'serve' && e.result === 'let')) rallyOn = false;
    }),
    session.onIncoming((incoming) => {
      if (session.mode === 'drill' && incoming.receiver === 'player') rallyOn = true;
    }),
    session.onShot((event) => {
      if (session.mode === 'drill' && feedResult(event) !== null) rallyOn = false;
      // An accepted Swing buzzes the Phone; Early, Late and Miss send nothing.
      const ms = phone && !mouse ? hapticFor(event) : null;
      if (ms !== null) phoneLink?.sendControl({ type: 'haptic', ms });
    }),
  );
  /**
   * Every resolver event, after the core has acted on it (the Return made the
   * ball in play, the Streak updated): the HUD shows the feedback and Streak;
   * `accepted` starts the Paddle's Swing animation and schedules the contact
   * tock for `contactAtMs`; `contact` (the frame the Return launches) pins the
   * Paddle's contact frame and point. Every table bounce is a bounce tock.
   */
  off.push(
    session.onShot((event) => {
      const text = event.type === 'off-target' ? (event.reason === 'net' ? 'Net' : 'Out') : FEEDBACK[event.type];
      if (text) hud.showFeedback(text);
      hud.showStreak(session.streak.streak, session.streak.best);
      if (event.type === 'accepted') {
        paddle.swing({ onsetMs: event.swing.t, contactAtMs: event.contactAtMs, side: event.swing.side });
        // Scheduled now, so it is heard exactly at the contact moment.
        sounds.contact(event.contactAtMs);
      } else if (event.type === 'contact') {
        paddle.contact(event.atMs, event.position);
      }
    }),
    session.onBounce(() => sounds.bounce()),
  );

  /** Match HUD: each Point or Let flashes its banner; the score row follows the core's Match state (`showMatchHud`). */
  off.push(
    session.onMatch((e) => {
      lastMatchEvent = e;
      const banner = e.type === 'next-game' ? null : matchHud(e.match, matchConfig, e).banner;
      if (banner) hud.showFeedback(banner);
      if (e.type === 'point' && e.match.phase === 'pre-serve') {
        const status = matchHud(e.match, matchConfig, null).status;
        if (status) setTimeout(() => hud.showFeedback(status), 900);
      }
    }),
  );

  /** The Game-over screen, a moment after the Match's last Point, with this Match's tally. */
  if (choice.mode === 'match') {
    const tally = watchMatch(session);
    off.push(tally.unsubscribe);
    off.push(
      session.onMatch((e) => {
        if (e.type !== 'point' || e.match.phase !== 'match-over') return;
        setTimeout(() => {
          const result = tally.stats.result;
          if (core === session && result) dispatch({ type: 'match-over', result });
        }, GAME_OVER_DELAY_MS);
      }),
    );
  }

  /** The play log: one entry per Shot coming to the player (fit with `npm run fit-player`). */
  const playLog = createPlayLogRecorder({ mode: session.mode });
  playLogs.push(playLog);
  off.push(
    session.onIncoming((incoming) => {
      if (incoming.receiver === 'player') playLog.startFeed(incoming.idealAtMs);
    }),
    session.onShot((event) => playLog.shot(event)),
  );

  hud.showMatch(null);
  hud.showStreak(session.streak.streak, session.streak.best);
  endSession = () => off.forEach((unsubscribe) => unsubscribe());
}

/** Match HUD: the score row follows the current core's Match state, by the session's rules. */
function showMatchHud(): void {
  if (core.match) hud.showMatch(matchHud(core.match, matchConfig, lastMatchEvent));
}

/**
 * The start and Game-over screens. With a developer URL flag, play starts
 * as the flags ask once onboarding is done; otherwise the start screen
 * shows then (an idle Return Drill core waits behind it, never feeding).
 */
const screens = createScreens({
  input: () => (flagInput ? null : timingInput()),
  onChangeInput: () => void changeInput(),
});
let screen: ScreenState = skipsStartScreen(window.location.search) ? playingFromSearch(window.location.search) : START_SCREEN;
startSession(screen.screen === 'playing' ? screen.choice : { mode: 'drill' });

/** The player chose on a screen: move to the next one, and start or stop play. */
function dispatch(action: ScreenAction): void {
  const previous = screen;
  screen = nextScreen(previous, action);
  if (screen === previous) return;
  screens.show(screen, dispatch);
  if (screen.screen === 'playing') void play(screen.choice);
  else playing = false;
}

/** Bumped by each `play`, so a superseded one (Esc during its calibration) doesn't start. */
let playRequest = 0;

/**
 * Play `choice` in a fresh session. A Match with no saved Timing Offset runs
 * Timing calibration first; cancelling it goes back to the start screen.
 */
async function play(choice: StartChoice): Promise<void> {
  const request = ++playRequest;
  playing = false;
  const input = timingInput();
  const steps =
    choice.mode === 'match'
      ? matchStartSteps({ input: inputMode ?? 'mouse', timingOffsetSaved: input === null || timingOffsetStore.offsetMsFor(input) !== null })
      : [];
  if (steps.includes('calibration') && !(await calibrate(true))) {
    if (request === playRequest) dispatch({ type: 'back-to-start' });
    return;
  }
  if (request !== playRequest || screen.screen !== 'playing') return;
  startSession(choice);
  playing = true;
}

// Esc during play: back to the start screen (the core pauses; a Rally in progress is void).
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.repeat || !onboarded || calibrating || screen.screen !== 'playing') return;
  dispatch({ type: 'back-to-start' });
});

/**
 * The start screen's "Change" next to the Input: pick again; a different
 * Input is remembered and the page reloads to set it up from scratch (the
 * camera, or a fresh pairing room).
 */
async function changeInput(): Promise<void> {
  const current = timingInput();
  const next = await pickInput(current);
  if (next === current) return;
  inputChoice.save(next);
  window.location.reload();
}

/**
 * Boot: decide the Input (the developer flag, the remembered choice, or ask
 * with the Input picker), build it, then onboarding: the steps this player
 * still needs with that Input (SPEC "Onboarding for the prototype"; spec
 * P3-e), then the start screen (or play, with a developer flag). Starting the
 * camera lives here, in its first step; if it can't start, the player is told
 * why and can try again.
 */
async function boot(): Promise<void> {
  if (flagInput) inputMode = flagInput; // a developer flag is never remembered
  else {
    const picked = inputChoice.input ?? (await pickInput());
    inputChoice.save(picked);
    inputMode = picked;
  }
  if (inputMode === 'phone') phone = installPhone();
  swings().subscribe(onSwing);
  applySavedTimingOffset();

  const input = timingInput();
  const onboardingPlan = onboardingSteps({
    input: inputMode,
    handSaved: handedness.hand !== null,
    timingOffsetSaved: input !== null && timingOffsetStore.offsetMsFor(input) !== null,
    phoneSafetySeen: phoneSafetyStore.seen,
  });
  await runOnboarding(onboardingPlan, {
    'ask-camera': () => onboardingScreens.askCamera(startCamera),
    'start-camera': () => onboardingScreens.startCamera(startCamera),
    framing: async () => onboardingScreens.framing((await sharedSensing()).video),
    handedness: async () => handedness.set(await askHandedness()),
    calibration: async () => void (await calibrate(false)),
    'phone-safety': async () => {
      await onboardingScreens.phoneSafety();
      phoneSafetyStore.acknowledge();
    },
    'phone-pairing': () => onboardingScreens.phonePairing(phoneLink!, phoneState),
    'phone-zeroing': () => onboardingScreens.phoneZeroing(phoneState),
    'phone-ready': () => onboardingScreens.phoneReady(phoneState),
  });
  onboarded = true;
  if (screen.screen === 'playing') playing = true; // the developer flags' session, already made
  else screens.show(screen, dispatch);
}

knobs.button({
  name: 'Redo calibration',
  group: 'Timing',
  onPress: () => {
    if (!onboarded || calibrating) return; // onboarding still running, or already calibrating
    calibrate(true).catch((error: unknown) => console.error('Calibration failed', error));
  },
});

knobs.button({
  name: 'Download play log',
  group: 'Debug',
  onPress: () => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([playLogs.map((log) => log.toText()).join('')], { type: 'application/x-ndjson' }));
    link.download = `play-log-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
    link.click();
    URL.revokeObjectURL(link.href);
  },
});

/** Every Swing from the Input in play goes to the core. */
function onSwing(swing: SwingEvent): void {
  // Pose emits Swings only while the wrist is tracked, which may be newer
  // than the last frame's pause: refresh it first, so the Swing is judged
  // exactly when play is on.
  core.setPaused(corePaused());
  core.swing(swing, performance.now());
}

knobs.button({ name: 'Drop ball (30 cm)', group: 'Ball', onPress: () => core.setBall(DEBUG_THROWS.drop()) });
knobs.button({ name: 'Throw into net', group: 'Ball', onPress: () => core.setBall(DEBUG_THROWS.intoNet()) });
knobs.button({ name: 'Throw off table', group: 'Ball', onPress: () => core.setBall(DEBUG_THROWS.offTable()) });

/** Simulated seconds the Ideal Time marker stays lit after the Feed reaches it. */
const IDEAL_MARKER_HOLD_S = 0.3;

/** The debug Ideal Time marker for the current Feed, or null while there is nothing to show. */
function idealTimeMarker() {
  if (!SHOW_IDEAL_TIME_MARKER.value) return null;
  const toss = core.toss;
  if (toss) {
    // The player's Serve toss, from its launch (the Feeder's clock doesn't run in a Match).
    const sinceToss = ((performance.now() - toss.launchedAtMs) / 1000) * TIME_SCALE.value;
    return { position: toss.ideal.position, reached: sinceToss >= toss.ideal.simSeconds };
  }
  const ideal = core.feeder.currentFeed?.idealTime;
  if (!ideal) return null;
  const sinceFeed = core.feeder.simSecondsSinceFeed;
  if (sinceFeed > ideal.simSeconds + IDEAL_MARKER_HOLD_S) return null;
  return { position: ideal.position, reached: sinceFeed >= ideal.simSeconds };
}

/** One frame of the Opponent's body (see `opponentBodyPlan`): simulated time runs at TIME_SCALE, capped like the core's. */
function updateOpponentBody(nowMs: number, elapsedSeconds: number): BodyPose {
  const timeScale = TIME_SCALE.value;
  opponentBodyPlan = followOpponentPlan(core.opponentPlan, opponentBodyPlan, (incoming) => ((nowMs - incoming.launchedAtMs) / 1000) * timeScale);
  opponentPose = planBody(opponentPose, opponentBodyPlan, Math.min(elapsedSeconds, MAX_FRAME_DT) * timeScale, bodyParams);
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
  // A Zeroing tapped mid-Rally waits for the Rally's end (a paused game has no Rally).
  phone?.setZeroHold(rallyOn && !corePaused());
  const banner = handSignal().banner;
  const pairingAgain = syncPairingAgain(); // the QR code covers the banner's place
  hud.showHandLost((playing || calibrating) && banner !== null && !pairingAgain, banner ?? undefined);
  core.frame({ nowMs: now, elapsedSeconds });
  hud.showCountdown(core.countdown);
  showMatchHud();

  debug.update(elapsedSeconds);
  ballStatus.update(core.ball, debug.active);
  tableScene.syncBall(core.ball.position, core.ball.spin);
  tableScene.syncPaddle(paddle.update(now, handPositions().latest));
  tableScene.syncIdealTimeMarker(idealTimeMarker());
  tableScene.syncOpponent(core.mode === 'match' ? updateOpponentBody(now, elapsedSeconds) : null);
  tableScene.render(debug.camera);
}

tableScene.renderer.setAnimationLoop(frame);

boot().catch((error: unknown) => console.error('Onboarding failed', error));
