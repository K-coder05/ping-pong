/**
 * The start and Game-over screens (spec P2-h2), drawn as one full-screen
 * panel over the game, like the onboarding screens.
 *
 * - **Start screen**: Return Drill or Match. Match asks Difficulty (Novice,
 *   Intermediate, Expert) and length (1 Game or best of 3), then Start. It
 *   also shows the Input (Camera or Phone, spec P3-e) with a button to change
 *   it in the Input picker (`render/inputPicker.ts`).
 * - **Game over**: the winner, the final score, the longest Rally, the
 *   player's Returns and failed Shots, then Rematch, Change Difficulty or
 *   Back to start.
 *
 * The first part of this module is pure (no DOM, so tests drive it in Node):
 * the screens' state machine (`nextScreen`), what a choice makes of the
 * `GameCore`'s options (`coreOptionsFromChoice`), the Match's tally for the
 * Game-over screen (`createMatchStats`) and its wording (`gameOverModel`).
 * `createScreens` draws whichever screen the state names; `main.ts` holds the
 * state, starts play and runs Timing calibration first when a Match needs it.
 */

import { DEFAULT_MATCH_CONFIG, gameModeFromSearch, type GameCore, type GameCoreOptions, type MatchEvent } from '../game/core.ts';
import type { MatchConfig } from '../game/match.ts';
import type { Input } from '../game/onboarding.ts';
import type { Opponent, RallyEvent } from '../game/rally.ts';
import type { ShotEvent } from '../game/shotResolver.ts';
import type { Side } from '../game/side.ts';
import { createBrain } from '../opponent/brain.ts';
import { INPUT_LABEL } from './inputPicker.ts';
import {
  DEFAULT_DIFFICULTY,
  DIFFICULTIES,
  DIFFICULTY_ORDER,
  difficultyFromSearch,
  type Difficulty,
  type DifficultyParams,
} from '../opponent/difficulty.ts';

// ---------------------------------------------------------------------------
// Choices and the screens' state machine (pure)
// ---------------------------------------------------------------------------

/** A Match's length: one Game, or the best of three Games. */
export type MatchLength = 1 | 3;

/** What the player chose to play. */
export type StartChoice =
  | { readonly mode: 'drill' }
  | { readonly mode: 'match'; readonly difficulty: Difficulty; readonly bestOf: MatchLength };

/** The Match settings as picked on the start screen; kept between Matches so Rematch and Change Difficulty start from them. */
export interface MatchDraft {
  readonly difficulty: Difficulty;
  readonly bestOf: MatchLength;
}

export type ScreenState =
  /** Return Drill or Match? */
  | { readonly screen: 'start'; readonly draft: MatchDraft }
  /** Match: Difficulty and length, then Start. */
  | { readonly screen: 'match-setup'; readonly draft: MatchDraft }
  /** No screen: the game is on (or Timing calibration runs before a Match). */
  | { readonly screen: 'playing'; readonly draft: MatchDraft; readonly choice: StartChoice }
  /** The Match is over: its result. */
  | { readonly screen: 'game-over'; readonly draft: MatchDraft; readonly choice: StartChoice & { mode: 'match' }; readonly result: MatchResult };

export type ScreenAction =
  | { readonly type: 'return-drill' }
  | { readonly type: 'match' }
  | { readonly type: 'difficulty'; readonly difficulty: Difficulty }
  | { readonly type: 'length'; readonly bestOf: MatchLength }
  | { readonly type: 'start' }
  | { readonly type: 'back' }
  | { readonly type: 'match-over'; readonly result: MatchResult }
  | { readonly type: 'rematch' }
  | { readonly type: 'change-difficulty' }
  | { readonly type: 'back-to-start' };

/** The start screen, with the Match settings at their defaults. */
export const START_SCREEN: ScreenState = Object.freeze({ screen: 'start', draft: Object.freeze({ difficulty: DEFAULT_DIFFICULTY, bestOf: 1 }) });

/**
 * The screen after `action`. An action the current screen doesn't offer
 * leaves the state as it is (the same object), so a stale click is harmless.
 */
export function nextScreen(state: ScreenState, action: ScreenAction): ScreenState {
  const { draft } = state;
  switch (action.type) {
    case 'return-drill':
      return state.screen === 'start' ? { screen: 'playing', draft, choice: { mode: 'drill' } } : state;
    case 'match':
      return state.screen === 'start' ? { screen: 'match-setup', draft } : state;
    case 'difficulty':
      return state.screen === 'match-setup' ? { screen: 'match-setup', draft: { ...draft, difficulty: action.difficulty } } : state;
    case 'length':
      return state.screen === 'match-setup' ? { screen: 'match-setup', draft: { ...draft, bestOf: action.bestOf } } : state;
    case 'start':
      return state.screen === 'match-setup' ? { screen: 'playing', draft, choice: { mode: 'match', ...draft } } : state;
    case 'back':
      return state.screen === 'match-setup' ? { screen: 'start', draft } : state;
    case 'match-over':
      return state.screen === 'playing' && state.choice.mode === 'match'
        ? { screen: 'game-over', draft, choice: state.choice, result: action.result }
        : state;
    case 'rematch':
      return state.screen === 'game-over' ? { screen: 'playing', draft, choice: state.choice } : state;
    case 'change-difficulty':
      return state.screen === 'game-over' ? { screen: 'match-setup', draft } : state;
    case 'back-to-start':
      return state.screen === 'game-over' || state.screen === 'playing' ? { screen: 'start', draft } : state;
  }
}

/** The developer URL flags that skip the start screen and go straight to play. */
const DEVELOPER_FLAGS = ['mode', 'difficulty', 'input', 'seed'] as const;

/** Whether the page URL has a developer flag (`?mode=`, `?difficulty=`, `?input=mouse`, `?seed=`), which skips the start screen. */
export function skipsStartScreen(search: string): boolean {
  const params = new URLSearchParams(search);
  return DEVELOPER_FLAGS.some((flag) => params.has(flag));
}

/**
 * Play as the developer URL flags ask: `?mode=match` is a one-Game Match at
 * the `?difficulty=` asked for (Intermediate otherwise); anything else is
 * Return Drill.
 */
export function playingFromSearch(search: string): ScreenState & { screen: 'playing' } {
  const draft: MatchDraft = { difficulty: difficultyFromSearch(search), bestOf: 1 };
  const choice: StartChoice = gameModeFromSearch(search) === 'match' ? { mode: 'match', ...draft } : { mode: 'drill' };
  return { screen: 'playing', draft, choice };
}

/** A Match's rules for a length: Games to 11, win by 2, the best of `bestOf`. */
export function matchConfigFor(bestOf: MatchLength): MatchConfig {
  return { ...DEFAULT_MATCH_CONFIG, bestOf };
}

/**
 * The `GameCore` options a choice makes: its mode and, for a Match, the
 * Opponent's brain at the chosen Difficulty and the chosen length.
 * `makeOpponent` is `createBrain` unless a test stands one in.
 */
export function coreOptionsFromChoice(
  choice: StartChoice,
  makeOpponent: (params: Readonly<DifficultyParams>) => Opponent = createBrain,
): Pick<GameCoreOptions, 'mode' | 'opponent' | 'match'> {
  if (choice.mode === 'drill') return { mode: 'drill' };
  return { mode: 'match', opponent: makeOpponent(DIFFICULTIES[choice.difficulty]), match: matchConfigFor(choice.bestOf) };
}

// ---------------------------------------------------------------------------
// The Match's tally for the Game-over screen (pure)
// ---------------------------------------------------------------------------

/** What the Game-over screen reports about a finished Match. */
export interface MatchResult {
  readonly winner: Side;
  /** Games won by each side. */
  readonly games: Readonly<Record<Side, number>>;
  /** Each Game's final Points, in order. */
  readonly gameScores: readonly Readonly<Record<Side, number>>[];
  /** The most Shots in one Rally, its Serve included. */
  readonly longestRally: number;
  /** The player's Returns. */
  readonly returns: number;
  /**
   * The player's failed Shots: Early, Late or Miss at a Shot coming to them,
   * or a struck Shot that wasn't a Return (into the net, out, or on their own
   * half). A missed Serve toss isn't one: it is simply tossed again.
   */
  readonly failed: Readonly<{ early: number; late: number; miss: number; offTarget: number }>;
}

/** Tallies a Match from the core's events, for the Game-over screen. */
export interface MatchStats {
  /** A Shot (or, with `toss`, the player's Serve toss) is coming to `receiver`. */
  incoming(receiver: Side, toss: boolean): void;
  /** A resolver event (the player's Swings). */
  shot(event: ShotEvent): void;
  /** A Rally event: Shots, bounces, the Serve's result, the Rally End. */
  rally(event: RallyEvent): void;
  /** A change to the score. */
  match(event: MatchEvent): void;
  /** The result once the Match is over, else null. */
  readonly result: MatchResult | null;
}

export function createMatchStats(): MatchStats {
  let games: Record<Side, number> = { player: 0, opponent: 0 };
  const gameScores: Record<Side, number>[] = [];
  let winner: Side | null = null;
  let rallyShots = 0;
  let longestRally = 0;
  let returns = 0;
  const failed = { early: 0, late: 0, miss: 0, offTarget: 0 };
  /** The player's latest Return attempt is in flight, not yet a Return. */
  let returnInFlight = false;
  /** The player's next chance is a Serve toss, not a Shot to return. */
  let atToss = false;

  return {
    incoming(receiver, toss) {
      if (receiver === 'player') atToss = toss;
    },
    shot(event) {
      if (atToss) return;
      if (event.type === 'miss') failed.miss++;
      else if (event.type === 'late') failed.late++;
      else if (event.type === 'early' && event.final) failed.early++;
    },
    rally(event) {
      switch (event.type) {
        case 'shot':
          // A Serve starts a Rally (a replayed one starts over).
          rallyShots = event.shotIndex === 0 ? 1 : rallyShots + 1;
          returnInFlight = event.by === 'player' && event.shotIndex > 0;
          break;
        case 'bounce':
          // A Return's first bounce is on the other half (after a Net-cord too).
          if (returnInFlight && event.half === 'opponent') returns++;
          returnInFlight = false;
          break;
        case 'serve':
          if (event.result === 'let') rallyShots = 0; // void: served again
          break;
        case 'end':
          longestRally = Math.max(longestRally, rallyShots);
          if (returnInFlight && event.loser === 'player') failed.offTarget++;
          returnInFlight = false;
          rallyShots = 0;
          break;
      }
    },
    match(event) {
      if (event.type !== 'point') return;
      const { phase } = event.match;
      if (phase !== 'game-over' && phase !== 'match-over') return;
      games = { ...event.match.games };
      gameScores.push({ ...event.match.points });
      if (phase === 'match-over') winner = event.match.winner ?? event.to;
    },
    get result() {
      if (winner === null) return null;
      return { winner, games, gameScores: [...gameScores], longestRally, returns, failed: { ...failed } };
    },
  };
}

/** Tally `core`'s Match. Returns the stats and a function that stops listening. */
export function watchMatch(core: GameCore): { stats: MatchStats; unsubscribe: () => void } {
  const stats = createMatchStats();
  const unsubscribers = [
    // The core sets `toss` before it announces a toss.
    core.onIncoming((incoming) => stats.incoming(incoming.receiver, core.toss === incoming)),
    core.onShot((event) => stats.shot(event)),
    core.onRally((event) => stats.rally(event)),
    core.onMatch((event) => stats.match(event)),
  ];
  return { stats, unsubscribe: () => unsubscribers.forEach((off) => off()) };
}

// ---------------------------------------------------------------------------
// Wording (pure)
// ---------------------------------------------------------------------------

export const DIFFICULTY_LABEL: Readonly<Record<Difficulty, string>> = Object.freeze({
  novice: 'Novice',
  intermediate: 'Intermediate',
  expert: 'Expert',
});

export const LENGTH_LABEL: Readonly<Record<MatchLength, string>> = Object.freeze({ 1: '1 Game', 3: 'Best of 3' });

export interface GameOverModel {
  /** "You win!" or "The Opponent wins". */
  readonly title: string;
  /** The final score, the player's first: a Game's Points ("11 – 7"), or Games won in a best of 3 ("2 – 1"). */
  readonly score: string;
  /** Each Game's score in a best of 3 ("11–7 · 9–11 · 11–5"), else null. */
  readonly gameScores: string | null;
  /** "Intermediate · 1 Game". */
  readonly setting: string;
  /** The tally, label and value. */
  readonly facts: readonly { readonly label: string; readonly value: string }[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function gameOverModel(result: MatchResult, choice: { readonly difficulty: Difficulty; readonly bestOf: MatchLength }): GameOverModel {
  const last = result.gameScores.at(-1) ?? { player: 0, opponent: 0 };
  const multi = choice.bestOf > 1;
  const { early, late, miss, offTarget } = result.failed;
  const failedTotal = early + late + miss + offTarget;
  const kinds = [
    [early, 'Early'],
    [late, 'Late'],
    [miss, 'Miss'],
    [offTarget, 'Net or out'],
  ] as const;
  const breakdown = kinds.filter(([n]) => n > 0).map(([n, label]) => `${label} ${n}`).join(' · ');
  return {
    title: result.winner === 'player' ? 'You win!' : 'The Opponent wins',
    score: multi ? `${result.games.player} – ${result.games.opponent}` : `${last.player} – ${last.opponent}`,
    gameScores: multi ? result.gameScores.map((g) => `${g.player}–${g.opponent}`).join(' · ') : null,
    setting: `${DIFFICULTY_LABEL[choice.difficulty]} · ${LENGTH_LABEL[choice.bestOf]}`,
    facts: [
      { label: 'Longest Rally', value: plural(result.longestRally, 'Shot') },
      { label: 'Your Returns', value: String(result.returns) },
      { label: 'Failed Shots', value: failedTotal > 0 ? `${failedTotal} (${breakdown})` : '0' },
    ],
  };
}

// ---------------------------------------------------------------------------
// The panel (DOM)
// ---------------------------------------------------------------------------

export interface Screens {
  /** Show the screen `state` names (`playing` hides the panel); its buttons send their action to `dispatch`. */
  show(state: ScreenState, dispatch: (action: ScreenAction) => void): void;
}

const FADE_MS = 200;

const STYLE = `
.screens {
  position: fixed; inset: 0; z-index: 8;
  display: grid; place-items: center; padding: 16px; box-sizing: border-box; overflow: auto;
  background: rgba(12, 14, 20, 0.9);
  font: 18px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: #e6e9ef;
  opacity: 0; transition: opacity ${FADE_MS}ms ease-out;
}
.screens[hidden] { display: none; }
.screens.shown { opacity: 1; }
.screens .card { width: 100%; max-width: 760px; text-align: center; }
.screens h1 { margin: 0 0 6px; font-size: 44px; line-height: 1.1; }
.screens h2 { margin: 0 0 12px; font-size: 28px; line-height: 1.2; }
.screens p { margin: 0 0 12px; }
.screens .muted { color: #9aa4b5; font-size: 16px; }
.screens .score { margin: 4px 0 6px; font-size: 72px; font-weight: 800; line-height: 1; font-variant-numeric: tabular-nums; }
.screens .label { margin: 14px 0 8px; color: #9aa4b5; font-size: 16px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; }
.screens .facts { display: grid; grid-template-columns: auto auto; gap: 6px 18px; justify-content: center; margin: 14px 0 20px; text-align: left; }
.screens .facts dt { color: #9aa4b5; }
.screens .facts dd { margin: 0; font-weight: 700; }
.screens .actions { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
.screens .modes { display: flex; gap: 16px; justify-content: center; flex-wrap: wrap; margin-top: 18px; }
.screens button { font: inherit; font-weight: 600; padding: 10px 22px; border-radius: 8px; cursor: pointer; }
.screens .modes button { width: min(100%, 300px); padding: 18px 22px; }
.screens .modes button span { display: block; font-size: 15px; font-weight: 400; opacity: 0.8; }
.screens button[aria-pressed="true"] { background: #ffd84a; color: #1d2230; border-color: #ffd84a; }
.screens .primary { margin-top: 22px; }
.screens .input { display: flex; gap: 12px; align-items: center; justify-content: center; flex-wrap: wrap; margin-top: 18px; }
.screens .input button { padding: 6px 16px; font-size: 16px; }
`;

export interface ScreensOptions {
  /** The Input in play, shown on the start screen; null (the developer mouse or a `?input=` flag) hides it. */
  input?: () => Input | null;
  /** The player pressed "Change" next to the Input. */
  onChangeInput?: () => void;
}

export function createScreens(options: ScreensOptions = {}): Screens {
  const style = document.createElement('style');
  style.textContent = STYLE;
  const root = document.createElement('div');
  root.className = 'screens';
  root.hidden = true;
  const card = document.createElement('div');
  card.className = 'card';
  card.setAttribute('aria-live', 'polite');
  root.append(card);
  document.head.append(style);
  document.body.append(root);

  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
    return Object.assign(document.createElement(tag), { textContent: text, className });
  }

  /** A button sending `action`; `key` keeps its focus when the screen redraws. */
  function button(label: string, onClick: () => void, key: string, detail?: string): HTMLButtonElement {
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: label });
    b.dataset.key = key;
    if (detail) b.append(element('span', detail));
    b.addEventListener('click', onClick);
    return b;
  }

  function toggle(label: string, pressed: boolean, onClick: () => void, key: string): HTMLButtonElement {
    const b = button(label, onClick, key);
    b.setAttribute('aria-pressed', String(pressed));
    return b;
  }

  function row(className: string, ...children: Node[]): HTMLDivElement {
    const div = element('div', '', className);
    div.append(...children);
    return div;
  }

  function fadeIn(): void {
    clearTimeout(hideTimer);
    if (root.hidden) {
      root.hidden = false;
      void root.offsetWidth; // start the fade from transparent
    }
    root.classList.add('shown');
  }

  function fadeOut(): void {
    root.classList.remove('shown');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      root.hidden = true;
      card.replaceChildren();
    }, FADE_MS);
  }

  /** "Swinging with: Camera  [Change]", when the Input can be changed here. */
  function inputRow(): Node[] {
    const input = options.input?.() ?? null;
    if (!input || !options.onChangeInput) return [];
    const change = options.onChangeInput;
    return [row('input', element('span', `Swinging with: ${INPUT_LABEL[input]}`, 'muted'), button('Change', () => change(), 'change-input'))];
  }

  function startScreen(dispatch: (action: ScreenAction) => void): Node[] {
    return [
      element('h1', 'Ping Pong'),
      element('p', 'How do you want to play?', 'muted'),
      row(
        'modes',
        button('Return Drill', () => dispatch({ type: 'return-drill' }), 'drill', 'Practice: return the Feeder’s balls'),
        button('Match', () => dispatch({ type: 'match' }), 'match', 'Play the Opponent'),
      ),
      element('p', 'Press Esc during play to come back here.', 'muted'),
      ...inputRow(),
    ];
  }

  function matchSetup(draft: MatchDraft, dispatch: (action: ScreenAction) => void): Node[] {
    return [
      element('h2', 'Match'),
      element('div', 'Difficulty', 'label'),
      row(
        'actions',
        ...DIFFICULTY_ORDER.map((d) =>
          toggle(DIFFICULTY_LABEL[d], draft.difficulty === d, () => dispatch({ type: 'difficulty', difficulty: d }), `difficulty-${d}`),
        ),
      ),
      element('div', 'Length', 'label'),
      row(
        'actions',
        ...([1, 3] as const).map((n) => toggle(LENGTH_LABEL[n], draft.bestOf === n, () => dispatch({ type: 'length', bestOf: n }), `length-${n}`)),
      ),
      row('actions primary', button('Start', () => dispatch({ type: 'start' }), 'start'), button('Back', () => dispatch({ type: 'back' }), 'back')),
    ];
  }

  function gameOver(state: ScreenState & { screen: 'game-over' }, dispatch: (action: ScreenAction) => void): Node[] {
    const model = gameOverModel(state.result, state.choice);
    const facts = element('dl', '', 'facts');
    for (const { label, value } of model.facts) facts.append(element('dt', label), element('dd', value));
    return [
      element('h2', model.title),
      element('div', model.score, 'score'),
      ...(model.gameScores ? [element('p', model.gameScores, 'muted')] : []),
      element('p', model.setting, 'muted'),
      facts,
      row(
        'actions',
        button('Rematch', () => dispatch({ type: 'rematch' }), 'rematch'),
        button('Change Difficulty', () => dispatch({ type: 'change-difficulty' }), 'change-difficulty'),
        button('Back to start', () => dispatch({ type: 'back-to-start' }), 'back-to-start'),
      ),
    ];
  }

  return {
    show(state, dispatch) {
      if (state.screen === 'playing') {
        fadeOut();
        return;
      }
      const focused = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement.dataset.key : undefined;
      const nodes =
        state.screen === 'start' ? startScreen(dispatch) : state.screen === 'match-setup' ? matchSetup(state.draft, dispatch) : gameOver(state, dispatch);
      card.replaceChildren(...nodes);
      fadeIn();
      // Keep focus on the button just pressed; else Start on the Match screen, else the first button.
      const key = focused ?? (state.screen === 'match-setup' ? 'start' : undefined);
      const again = key ? card.querySelector<HTMLElement>(`[data-key="${key}"]`) : null;
      (again ?? card.querySelector('button'))?.focus();
    },
  };
}
