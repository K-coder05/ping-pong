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
 * floor (so the table top is at y = TABLE_TOP_Y). z runs from the Feeder
 * (negative) to the player (positive); the net is at z = 0.
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
/** z of the Feeder's end of the table. */
export const FEEDER_END_Z = -TABLE_HALF_LENGTH;

export const NET_HEIGHT = 0.1525;
/** How far the net reaches past each side line. */
export const NET_OVERHANG = 0.1525;
export const NET_LENGTH = TABLE_WIDTH + 2 * NET_OVERHANG;

export const BALL_RADIUS = 0.02; // physics radius; see BALL_DRAW_SCALE
export const BALL_MASS = 0.0027;

// ---------------------------------------------------------------------------
// Feeder (fixed rules; its timing guesses are knobs below)
// ---------------------------------------------------------------------------

/** Where the Feeder launches each Feed: its far end line, about 0.3 m above the table. */
export const FEEDER_MOUTH = { x: 0, y: TABLE_TOP_Y + 0.3, z: FEEDER_END_Z } as const;
/** Feed landing targets: x within ±this, metres. */
export const FEED_TARGET_HALF_WIDTH = 0.5;
/** Feed landing targets: z from this ... */
export const FEED_TARGET_Z_MIN = 0.5;
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
/** Share of its speed toward the net a ball keeps, dropping back off it (no net-cord physics). */
export const NET_REBOUND = 0.1;
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

/** Stroke speed that starts a Swing, in shoulder widths per second. */
export const SWING_ON = knobs.number({ name: 'SWING_ON', min: 0.5, max: 10, step: 0.1, default: 3, group: 'Swing' });
/** Total wrist speed that counts as a full-power Swing, shoulder widths/s. */
export const SWING_FAST = knobs.number({ name: 'SWING_FAST', min: 2, max: 20, step: 0.5, default: 8, group: 'Swing' });
/** Wrist speed below which a new Swing is re-armed, shoulder widths/s. */
export const SWING_OFF = knobs.number({ name: 'SWING_OFF', min: 0.1, max: 5, step: 0.1, default: 1, group: 'Swing' });
/** Time after a Swing Onset during which new Onsets are ignored. */
export const SWING_COOLDOWN_MS = knobs.number({ name: 'SWING_COOLDOWN_MS', min: 100, max: 1000, step: 10, default: 400, group: 'Swing' });

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

/** Horizontal speed kept by a table bounce (friction). */
export const BOUNCE_FRICTION = knobs.number({ name: 'BOUNCE_FRICTION', min: 0.5, max: 1, step: 0.01, default: 0.9, group: 'Physics' });

/** Return direction spread: how far timing can push a Return sideways, metres. */
export const DIRECTION_SPREAD_M = knobs.number({ name: 'DIRECTION_SPREAD_M', min: 0, max: 0.75, step: 0.05, default: 0.6, group: 'Return' });

/** One Euro filter cutoff at rest, Hz. */
export const ONE_EURO_MIN_CUTOFF = knobs.number({ name: 'ONE_EURO_MIN_CUTOFF', min: 0.1, max: 5, step: 0.1, default: 1, group: 'Smoothing' });
/** One Euro filter speed coefficient. */
export const ONE_EURO_BETA = knobs.number({ name: 'ONE_EURO_BETA', min: 0, max: 0.1, step: 0.001, default: 0.01, group: 'Smoothing' });

/** Ball drawn this many times its physics radius, so it's readable from 2 m. */
export const BALL_DRAW_SCALE = knobs.number({ name: 'BALL_DRAW_SCALE', min: 1, max: 4, step: 0.1, default: 2, group: 'Render' });
/** Debug marker where (and, by lighting up, when) each Feed reaches its Ideal Time. */
export const SHOW_IDEAL_TIME_MARKER = knobs.toggle({ name: 'SHOW_IDEAL_TIME_MARKER', default: true, group: 'Render' });

/** Shoulder widths of wrist travel that span the table's width. */
export const PADDLE_MAPPING_RANGE = knobs.number({ name: 'PADDLE_MAPPING_RANGE', min: 0.5, max: 4, step: 0.1, default: 2, group: 'Paddle' });
/** Ease the Paddle toward the ball's contact point once a Swing is accepted. */
export const CONTACT_ASSIST = knobs.toggle({ name: 'CONTACT_ASSIST', default: true, group: 'Paddle' });
/** Draw the Paddle ahead of the wrist by the measured latency. */
export const LATENCY_EXTRAPOLATION = knobs.toggle({ name: 'LATENCY_EXTRAPOLATION', default: false, group: 'Paddle' });
