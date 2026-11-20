/**
 * Game dimensions and physics live here as plain constants, and every tuning
 * knob (a starting guess, per SPEC "Tuning knobs") is registered in the knob
 * registry so it shows in the debug panel (`D`). Purely cosmetic sizes (table
 * legs, net posts) stay next to the drawing code in `render/`.
 *
 * Read a knob's live value with `.value` at the point of use; never copy it
 * into a module-level variable, or panel changes won't take effect.
 *
 * World frame, in metres: x and z are centred on the table, y is up from the
 * floor (so the table top is at y = TABLE_TOP_Y). z runs from the Opponent's
 * end (negative; the Feeder stands there in Return Drill) to the player's
 * (positive); the net is at z = 0.
 */

import { knobs } from './knobs.ts';

// ---------------------------------------------------------------------------
// Table, net and ball (ITTF rules)
// ---------------------------------------------------------------------------

export const TABLE_LENGTH = 2.74; // along z
export const TABLE_WIDTH = 1.525; // along x
export const TABLE_TOP_Y = 0.76;
export const TABLE_THICKNESS = 0.03;
/** Distance from the net (z = 0) to either end of the table. */
export const TABLE_HALF_LENGTH = TABLE_LENGTH / 2;
/** z of the player's end of the table. */
export const PLAYER_END_Z = TABLE_HALF_LENGTH;
/** z of the Opponent's end of the table (where the Feeder stands in Return Drill). */
export const OPPONENT_END_Z = -TABLE_HALF_LENGTH;

export const NET_HEIGHT = 0.1525;
/** How far the net reaches past each side line. */
export const NET_OVERHANG = 0.1525;
export const NET_LENGTH = TABLE_WIDTH + 2 * NET_OVERHANG;

export const BALL_RADIUS = 0.02; // physics radius; see BALL_DRAW_SCALE
export const BALL_MASS = 0.0027;

// ---------------------------------------------------------------------------
// Target solver (shared by Feeds and Returns)
// ---------------------------------------------------------------------------

/** Minimum gap between the ball's bottom and the net top as it crosses z = 0, metres. */
export const NET_CLEARANCE = 0.05;
/** When a shot won't clear the net, its flight time is lengthened by this factor (a higher arc) and solved again. */
export const ARC_RAISE_FACTOR = 1.1;
/** Most refinement passes (simulate, then correct) the solver makes for one flight time. */
export const SOLVER_MAX_PASSES = 4;
/** Most times the solver raises the arc to clear the net before it gives up. */
export const SOLVER_MAX_RAISES = 5;
/** Refinement stops once the landing is this close to the target, metres ... */
export const SOLVER_STOP_MISS_M = 0.01;
/** ... and the flight time this close to the asked one, seconds. */
export const SOLVER_STOP_TIME_S = 0.01;
/** A solution landing further than this from its target is a failure, metres. */
export const SOLVER_MAX_MISS_M = 0.02;
/**
 * A Feed whose solve fails, or that would have no Ideal Time, is a failed
 * draw; after this many failed draws in a row, the Feeder sends a zero-spin
 * Feed to the centre of its target area instead.
 */
export const FEED_MAX_DRAWS = 5;

// ---------------------------------------------------------------------------
// Feeder (fixed rules; its timing guesses are knobs below)
// ---------------------------------------------------------------------------

/** Where the Feeder launches each Feed: its far end line, about 0.3 m above the table. */
export const FEEDER_MOUTH = { x: 0, y: TABLE_TOP_Y + 0.3, z: OPPONENT_END_Z } as const;
/** Feed landing targets: x within ±this, metres. */
export const FEED_TARGET_HALF_WIDTH = 0.5;
/**
 * Feed landing targets: z from this ... Not shorter: with the spin-aware table
 * bounce (spec P1-b), a steep, short Feed leaves the bounce rolling and would
 * bounce twice on the player half before the end line, so it would have no
 * Ideal Time (at the slowest FEED_FLIGHT_TIME_S, targets up to z ≈ 0.66 do).
 */
export const FEED_TARGET_Z_MIN = 0.7;
/** ... to this, on the player's half. */
export const FEED_TARGET_Z_MAX = 1.0;
/** Every this many Returns in the Streak, Feeds get faster ... */
export const FEED_SPEEDUP_EVERY = 10;
/** ... by multiplying the flight time by this. */
export const FEED_SPEEDUP_FACTOR = 0.95;
/** The "3, 2, 1" cue before each Feed counts down from this. */
export const FEED_COUNTDOWN_FROM = 3;

// ---------------------------------------------------------------------------
// Physics (fixed facts; tuning guesses are knobs below)
// ---------------------------------------------------------------------------

export const GRAVITY = -9.81; // m/s², along y
/** Table restitution: √(23/30), a 30 cm drop bounces about 23 cm. */
export const TABLE_RESTITUTION = 0.88;
export const AIR_DENSITY = 1.2; // kg/m³
/** Drag coefficient of a smooth sphere. */
export const DRAG_COEFFICIENT = 0.5;
/** Drag constant k = ½·ρ·C_D·A / m ≈ 0.14 /m: about 1.4 g of drag at 10 m/s. */
export const DRAG_K = (0.5 * AIR_DENSITY * DRAG_COEFFICIENT * Math.PI * BALL_RADIUS ** 2) / BALL_MASS;
/** Fixed physics substep, so a fast ball can't skip through the net or table. */
export const PHYSICS_DT = 1 / 240;
/** Longest frame the game loop will catch up on (e.g. after a background tab). */
export const MAX_FRAME_DT = 0.1;
/**
 * Below this downward speed (m/s, about a 3 mm drop) a surface contact is not a
 * bounce: the ball settles. Otherwise a resting ball would "bounce" every
 * substep, buzzing the bounce sound and tripping the double-bounce rule.
 */
export const SETTLE_SPEED = 0.25;
/** Share of its speed toward the net a ball keeps, dropping back off it after hitting the net (not a Net-cord). */
export const NET_REBOUND = 0.1;
/** κ = mr²/I in the table bounce: 3/2 for a thin spherical shell (spec P1-b). */
export const TABLE_KAPPA = 1.5;
/**
 * Horizontal speed kept by a table contact too slow to bounce (a settle), so a
 * ball rolling or resting on the table comes to a stop.
 */
export const TABLE_SETTLE_FRICTION = 0.9;
/** The floor is scenery: it only stops a ball that left the table from falling forever. */
export const FLOOR_RESTITUTION = 0.6;
export const FLOOR_FRICTION = 0.8;

// ---------------------------------------------------------------------------
// Play camera: about eye height behind the player's end, looking at the Feeder
// ---------------------------------------------------------------------------

export const PLAY_CAMERA_FOV = 55; // vertical, degrees
export const PLAY_CAMERA_POSITION = { x: 0, y: 1.5, z: PLAYER_END_Z + 1.5 } as const;
export const PLAY_CAMERA_TARGET = { x: 0, y: TABLE_TOP_Y, z: -0.3 } as const;

// ---------------------------------------------------------------------------
// Tuning knobs (SPEC "Tuning knobs and open questions"; all starting guesses)
// ---------------------------------------------------------------------------

/**
 * Stroke speed that starts a Swing, in shoulder widths per second. Tuned from
 * logs (#12): Backswings re-smoothed at `ONE_EURO_BETA` 10 reached about 4.4;
 * the softest real Swing was 5.5.
 */
export const SWING_ON = knobs.number({ name: 'SWING_ON', min: 0.5, max: 10, step: 0.1, default: 5.2, group: 'Swing' });
/** Total wrist speed that counts as a full-power Swing, shoulder widths/s. */
export const SWING_FAST = knobs.number({ name: 'SWING_FAST', min: 2, max: 20, step: 0.5, default: 8, group: 'Swing' });
/**
 * Speed along the body axis below which the wrist counts as stopped, shoulder
 * widths/s: a stop or turn back ends a stroke and re-arms the detector. A
 * resting wrist logged under 0.05.
 */
export const SWING_OFF = knobs.number({ name: 'SWING_OFF', min: 0.1, max: 5, step: 0.1, default: 0.5, group: 'Swing' });
/** Time after a Swing Onset during which new Onsets are ignored; 700 ms covers the follow-through's return (#12). */
export const SWING_COOLDOWN_MS = knobs.number({ name: 'SWING_COOLDOWN_MS', min: 100, max: 1000, step: 10, default: 700, group: 'Swing' });
/**
 * Upward wrist speed needed at Onset, shoulder widths/s (pose only). Tuned from
 * logs (#12): real Swings rose at 0.6 or more (nearly all above 1.6), while the
 * return to ready position and sliding across between Forehand and Backhand
 * ready were flat or falling (at most 0.9, mostly below 0). Most of those logs
 * were recorded at the old `ONE_EURO_BETA` 0.01; recheck on new recordings.
 */
export const SWING_MIN_RISE = knobs.number({ name: 'SWING_MIN_RISE', min: -5, max: 5, step: 0.1, default: 0.5, group: 'Swing' });

/** Half-width W of the Hit Window around the Ideal Time. */
export const HIT_WINDOW_MS = knobs.number({ name: 'HIT_WINDOW_MS', min: 50, max: 400, step: 10, default: 200, group: 'Timing' });
/** A Swing more than W early uses up the Feed's one try. */
export const EARLY_SWING_USES_TRY = knobs.toggle({ name: 'EARLY_SWING_USES_TRY', default: true, group: 'Timing' });
/** Global slow-motion factor for the whole simulation. */
export const TIME_SCALE = knobs.number({ name: 'TIME_SCALE', min: 0.2, max: 1.5, step: 0.05, default: 0.8, group: 'Timing' });

/**
 * Flight time T of a Feed, before the Streak speed-up. Capped at 1.1 s: from
 * 0.3 m up, a slower Feed is such a high lob that a short one bounces twice
 * on the player's half. To slow play further, lower TIME_SCALE.
 */
export const FEED_FLIGHT_TIME_S = knobs.number({ name: 'FEED_FLIGHT_TIME_S', min: 0.4, max: 1.1, step: 0.05, default: 1, group: 'Feeder' });
/** Real seconds between a rally ending and the "3, 2, 1" cue starting. */
export const FEED_PAUSE_S = knobs.number({ name: 'FEED_PAUSE_S', min: 0, max: 5, step: 0.1, default: 1.5, group: 'Feeder' });
/** Real seconds each number of the "3, 2, 1" cue stays up. */
export const FEED_COUNTDOWN_STEP_S = knobs.number({ name: 'FEED_COUNTDOWN_STEP_S', min: 0.2, max: 1.5, step: 0.05, default: 0.5, group: 'Feeder' });

/**
 * A Feed's Topspin (or Backspin) grows by this many rev/s with each Streak
 * speed-up (every FEED_SPEEDUP_EVERY Returns), up to FEED_SPIN_MAX_REVS. Each
 * Feed draws its spin uniformly from ± that; 0 means Feeds never spin.
 */
export const FEED_SPIN_STEP_REVS = knobs.number({ name: 'FEED_SPIN_STEP_REVS', min: 0, max: 40, step: 1, default: 10, group: 'Feeder' });
/** The most Topspin or Backspin (rev/s) any Feed carries, however long the Streak. */
export const FEED_SPIN_MAX_REVS = knobs.number({ name: 'FEED_SPIN_MAX_REVS', min: 0, max: 80, step: 1, default: 40, group: 'Feeder' });

/**
 * Ball–table friction coefficient µ in the spin-aware table bounce
 * (`physics/bounce.ts`): how much of the contact point's slip a bounce trades
 * between speed and Spin. 0.25 from Sony AI's 2026 table tennis physics paper
 * (spec P1-b). Tuned in the physics view (P1-d).
 */
export const TABLE_MU = knobs.number({ name: 'TABLE_MU', min: 0, max: 0.6, step: 0.01, default: 0.25, group: 'Physics' });
/**
 * Magnus constant kM: the ball's sideways push is kM·(ω × v). 0.003 gives
 * 7.5 m/s² for 50 rev/s at 8 m/s, comparable to gravity: a game-feel guess,
 * not a measured value (spec P1-a). Tuned in the physics view (P1-d).
 */
export const MAGNUS_K = knobs.number({ name: 'MAGNUS_K', min: 0, max: 0.01, step: 0.0001, default: 0.003, group: 'Physics' });
/** Spin decay time constant: Spin falls to 1/e after this many simulated seconds. */
export const SPIN_TAU_S = knobs.number({ name: 'SPIN_TAU_S', min: 0.5, max: 20, step: 0.5, default: 4, group: 'Physics' });

/**
 * The player's Timing Offset: how much later the game sees a Swing Onset than
 * the player means it, subtracted from every Swing before judging it. Starts
 * from the offset Timing calibration saved (`timingOffsetStore`): 0 until the
 * player has calibrated, and with the developer mouse (which ignores the
 * saved offset). Calibration sets it and, except with the mouse, saves it;
 * moving the knob only changes the current page.
 */
export const TIMING_OFFSET_MS = knobs.number({ name: 'TIMING_OFFSET_MS', min: -100, max: 400, step: 5, default: 0, group: 'Timing' });
/** After the Hit Window closes, a Swing within this long still shows "Late!"; after it, the Feed is a Miss. */
export const LATE_GRACE_MS = knobs.number({ name: 'LATE_GRACE_MS', min: 0, max: 1000, step: 10, default: 300, group: 'Timing' });

/** Return direction spread: how far timing can push a Return sideways, metres. */
export const DIRECTION_SPREAD_M = knobs.number({ name: 'DIRECTION_SPREAD_M', min: 0, max: 0.75, step: 0.05, default: 0.6, group: 'Return' });
/** Share of the Hit Window, around the Ideal Time, whose Returns always land in. */
export const RETURN_SAFE_FRACTION = knobs.number({ name: 'RETURN_SAFE_FRACTION', min: 0, max: 1, step: 0.05, default: 0.7, group: 'Return' });
/** How far a Return at the very edge of the Hit Window is pushed long, metres. */
export const RETURN_LONG_PUSH_M = knobs.number({ name: 'RETURN_LONG_PUSH_M', min: 0, max: 1, step: 0.05, default: 0.4, group: 'Return' });
/** Flight time of the softest Return (peak speed at SWING_ON), simulated seconds. */
export const RETURN_FLIGHT_SOFT_S = knobs.number({ name: 'RETURN_FLIGHT_SOFT_S', min: 0.3, max: 1.5, step: 0.05, default: 1, group: 'Return' });
/** Flight time of a full-power Return (peak speed at SWING_FAST), simulated seconds. */
export const RETURN_FLIGHT_HARD_S = knobs.number({ name: 'RETURN_FLIGHT_HARD_S', min: 0.3, max: 1.5, step: 0.05, default: 0.55, group: 'Return' });
/** How far past the net the softest Return lands, metres. */
export const RETURN_DEPTH_SOFT_M = knobs.number({ name: 'RETURN_DEPTH_SOFT_M', min: 0.2, max: 1.3, step: 0.05, default: 0.6, group: 'Return' });
/** How far past the net a full-power Return lands, metres. */
export const RETURN_DEPTH_HARD_M = knobs.number({ name: 'RETURN_DEPTH_HARD_M', min: 0.2, max: 1.3, step: 0.05, default: 1.2, group: 'Return' });
/** Most random scatter of a Return's landing spot on x and z (scaled by 1 − timing quality), metres. */
export const RETURN_SCATTER_M = knobs.number({ name: 'RETURN_SCATTER_M', min: 0, max: 0.3, step: 0.01, default: 0.1, group: 'Return' });
/** Vertical wrist speed at Swing Onset that gives a Return full Lift (Lift 1), shoulder widths/s; Lift is 0 at SWING_MIN_RISE. */
export const LIFT_FULL = knobs.number({ name: 'LIFT_FULL', min: 1, max: 10, step: 0.1, default: 4, group: 'Return' });
/** Topspin of a Return with full Lift, revolutions/s. */
export const RETURN_TOPSPIN_MAX_REVS = knobs.number({ name: 'RETURN_TOPSPIN_MAX_REVS', min: 0, max: 80, step: 1, default: 40, group: 'Return' });
/**
 * How far (metres) a Return's landing spot moves when the Swing's Lift doesn't answer a Feed's
 * spin at full strength: shorter against Backspin with too little Lift, longer against Topspin
 * with too much. Starting guess; tuned by feel.
 */
export const SPIN_ANSWER_M = knobs.number({ name: 'SPIN_ANSWER_M', min: 0, max: 1, step: 0.05, default: 0.3, group: 'Return' });
/** Backspin never moves a Return's landing spot closer than this to the net, metres (fixed). */
export const RETURN_MIN_DEPTH_M = 0.2;

/** Developer mouse mode: shoulder width as a share of the canvas width (SPEC: the screen width). */
export const MOUSE_SHOULDER_WIDTH = knobs.number({ name: 'MOUSE_SHOULDER_WIDTH', min: 0.1, max: 2, step: 0.05, default: 1, group: 'Swing' });

/** One Euro filter cutoff at rest, Hz. */
export const ONE_EURO_MIN_CUTOFF = knobs.number({ name: 'ONE_EURO_MIN_CUTOFF', min: 0.1, max: 5, step: 0.1, default: 1, group: 'Smoothing' });
/**
 * One Euro filter speed coefficient, Hz per (normalized image unit / s). A Swing
 * moves the wrist about 1–3 image widths/s, so 10 lifts the cutoff to 10–30 Hz
 * mid-Swing; 0.01 left it near 1 Hz and blunted every Swing (#12).
 */
export const ONE_EURO_BETA = knobs.number({ name: 'ONE_EURO_BETA', min: 0, max: 30, step: 0.5, default: 10, group: 'Smoothing' });
/** Hitting-wrist visibility below which the wrist counts as lost (tracking-loss banner). */
export const TRACKING_MIN_VISIBILITY = knobs.number({ name: 'TRACKING_MIN_VISIBILITY', min: 0.1, max: 0.9, step: 0.05, default: 0.5, group: 'Tracking' });
/** The hitting wrist is lost after more than this many camera frames in a row below `TRACKING_MIN_VISIBILITY` (~170 ms at 30 FPS). */
export const TRACKING_LOST_FRAMES = knobs.number({ name: 'TRACKING_LOST_FRAMES', min: 1, max: 30, step: 1, default: 5, group: 'Tracking' });
/** A lost (or never seen) hitting wrist is tracked again after this many camera frames in a row at or above it. */
export const TRACKING_FOUND_FRAMES = knobs.number({ name: 'TRACKING_FOUND_FRAMES', min: 1, max: 30, step: 1, default: 3, group: 'Tracking' });

/** Ball drawn this many times its physics radius, so it's readable from 2 m. */
export const BALL_DRAW_SCALE = knobs.number({ name: 'BALL_DRAW_SCALE', min: 1, max: 4, step: 0.1, default: 2, group: 'Render' });
/**
 * The fastest the ball's stripe turns on screen (rev/s), approached as real
 * spin grows. Real rates (20-80 rev/s) would alias at 60 FPS, so the drawn
 * rate is a slow, monotonic stand-in.
 */
export const SPIN_DRAW_MAX_REVS = knobs.number({ name: 'SPIN_DRAW_MAX_REVS', min: 0, max: 8, step: 0.5, default: 4, group: 'Render' });
/** Debug marker where (and, by lighting up, when) each Feed reaches its Ideal Time. */
export const SHOW_IDEAL_TIME_MARKER = knobs.toggle({ name: 'SHOW_IDEAL_TIME_MARKER', default: true, group: 'Render' });

/** z of the Paddle's centre at rest: just behind the player's end line. */
export const PADDLE_Z = PLAYER_END_Z + 0.1;
/** Paddle centre height above the table top with the wrist at the ready, metres. */
export const PADDLE_REST_HEIGHT_M = 0.25;
/**
 * The wrist's vertical position at the ready (`p.y`), shoulder widths below
 * the shoulder line: elbow bent, forearm forward. The Paddle sits at
 * PADDLE_REST_HEIGHT_M there.
 */
export const PADDLE_REST_PY = 0.75;

/** Shoulder widths of wrist travel that span the table's width. */
export const PADDLE_MAPPING_RANGE = knobs.number({ name: 'PADDLE_MAPPING_RANGE', min: 0.5, max: 4, step: 0.1, default: 2, group: 'Paddle' });
/** Ease the Paddle toward the ball's contact point once a Swing is accepted. */
export const CONTACT_ASSIST = knobs.toggle({ name: 'CONTACT_ASSIST', default: true, group: 'Paddle' });
/** Draw the Paddle ahead of the wrist by the measured latency (LATENCY_EXTRAPOLATION_MS). */
export const LATENCY_EXTRAPOLATION = knobs.toggle({ name: 'LATENCY_EXTRAPOLATION', default: false, group: 'Paddle' });
/**
 * How far ahead latency extrapolation draws the wrist, ms: set it to the
 * motion-to-screen latency measured with the latency harness (SPEC expects
 * roughly 100–230 ms).
 */
export const LATENCY_EXTRAPOLATION_MS = knobs.number({ name: 'LATENCY_EXTRAPOLATION_MS', min: 0, max: 400, step: 5, default: 150, group: 'Paddle' });
