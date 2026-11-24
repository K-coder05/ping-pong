/**
 * The player's heads-up display, drawn as HTML over the canvas: the "3, 2, 1"
 * cue before each Feed, the Streak and best Streak, short feedback such as
 * "Early!", "Late!" and "Miss", and the "Can't see your hand" tracking-loss
 * banner. In a Match, the score, the server and the standing ("Game point",
 * "Deuce") replace the Streak. Sized to be read from 1.5–2 m away.
 */
import { HAND_LOST_TEXT } from '../game/handPause.ts';
import type { MatchHudModel } from './hudModel.ts';

export interface Hud {
  /** Show 3, 2 or 1 big in the middle of the screen; null hides it. Cheap to call every frame. */
  showCountdown(count: number | null): void;
  /** Show the current and best Streak. */
  showStreak(streak: number, best: number): void;
  /** Match: show the score row (score, server with Serves left, Games line, standing); null hides it and shows the Streak again. Cheap to call every frame. */
  showMatch(model: MatchHudModel | null): void;
  /** Flash a short message (e.g. "Early!") for a moment. */
  showFeedback(text: string): void;
  /**
   * Show or hide the "Can't see your hand" banner (SPEC "Tracking loss"), or
   * with the Phone "Phone disconnected: unlock your phone" (`text`; see
   * `game/handPause.ts`). Cheap to call every frame.
   */
  showHandLost(lost: boolean, text?: string): void;
}

/** How long a feedback message stays up, ms. */
const FEEDBACK_MS = 900;

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const SHADOW = '0 0.04em 0.12em rgba(0, 0, 0, 0.6)';

export function createHud(): Hud {
  const countdown = document.createElement('div');
  countdown.setAttribute('aria-live', 'assertive');
  Object.assign(countdown.style, {
    position: 'fixed',
    inset: '0',
    display: 'none', // 'grid' while showing (toggled here, not with `hidden`, which an inline display overrides)
    placeItems: 'center',
    pointerEvents: 'none',
    zIndex: '5',
    color: '#ffffff',
    font: `700 22vmin/1 ${FONT}`,
    textShadow: SHADOW,
  });

  const streak = document.createElement('div');
  streak.setAttribute('aria-live', 'polite');
  Object.assign(streak.style, {
    position: 'fixed',
    top: '2vmin',
    left: '50%',
    transform: 'translateX(-50%)',
    pointerEvents: 'none',
    zIndex: '5',
    color: '#ffffff',
    font: `700 6vmin/1.1 ${FONT}`,
    textShadow: SHADOW,
    textAlign: 'center',
    whiteSpace: 'nowrap',
  });
  const streakCount = document.createElement('div');
  const bestCount = document.createElement('div');
  Object.assign(bestCount.style, { font: `600 3.2vmin/1.2 ${FONT}`, opacity: '0.85' });
  streak.append(streakCount, bestCount);

  const match = document.createElement('div');
  match.setAttribute('aria-live', 'polite');
  Object.assign(match.style, {
    position: 'fixed',
    top: '2vmin',
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'none', // 'block' in a Match
    pointerEvents: 'none',
    zIndex: '5',
    color: '#ffffff',
    textShadow: SHADOW,
    textAlign: 'center',
    whiteSpace: 'nowrap',
  });
  const row = document.createElement('div');
  Object.assign(row.style, { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '3vmin' });
  const slotStyle = { width: '14vmin', font: `700 4vmin/1 ${FONT}`, letterSpacing: '0.1em' };
  const playerSlot = document.createElement('div');
  const opponentSlot = document.createElement('div');
  Object.assign(playerSlot.style, { ...slotStyle, textAlign: 'right' });
  Object.assign(opponentSlot.style, { ...slotStyle, textAlign: 'left' });
  const scoreText = document.createElement('div');
  Object.assign(scoreText.style, { font: `800 10vmin/1 ${FONT}`, fontVariantNumeric: 'tabular-nums' });
  row.append(playerSlot, scoreText, opponentSlot);
  const gamesText = document.createElement('div');
  Object.assign(gamesText.style, { font: `600 3.2vmin/1.3 ${FONT}`, opacity: '0.85' });
  const statusText = document.createElement('div');
  Object.assign(statusText.style, { font: `800 4vmin/1.3 ${FONT}`, color: '#ffd84a' });
  match.append(row, gamesText, statusText);

  const feedback = document.createElement('div');
  feedback.setAttribute('aria-live', 'assertive');
  Object.assign(feedback.style, {
    position: 'fixed',
    left: '0',
    right: '0',
    top: '28%',
    pointerEvents: 'none',
    zIndex: '5',
    color: '#ffd84a',
    font: `800 12vmin/1 ${FONT}`,
    textShadow: SHADOW,
    textAlign: 'center',
    opacity: '0',
    transition: 'opacity 150ms ease-out',
  });

  const handLost = document.createElement('div');
  handLost.setAttribute('role', 'status');
  handLost.textContent = HAND_LOST_TEXT;
  Object.assign(handLost.style, {
    position: 'fixed',
    left: '50%',
    top: '50%',
    transform: 'translate(-50%, -50%)',
    display: 'none', // 'block' while showing
    padding: '0.4em 0.8em',
    borderRadius: '0.4em',
    background: 'rgba(12, 14, 20, 0.75)',
    pointerEvents: 'none',
    zIndex: '9', // above the onboarding panel, so it shows during calibration too
    color: '#ffffff',
    font: `700 7vmin/1.2 ${FONT}`,
    textShadow: SHADOW,
    textAlign: 'center',
    width: 'max-content',
    maxWidth: '90vw', // the Phone's message wraps on a narrow window
  });

  document.body.append(countdown, streak, match, feedback, handLost);

  let shownCount: number | null = null;
  let shownHandLost = false;
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
  return {
    showCountdown(count) {
      if (count === shownCount) return;
      shownCount = count;
      countdown.style.display = count === null ? 'none' : 'grid';
      countdown.textContent = count === null ? '' : String(count);
    },
    showStreak(current, best) {
      streakCount.textContent = `Streak ${current}`;
      bestCount.textContent = `Best ${best}`;
    },
    showMatch(model) {
      match.style.display = model ? 'block' : 'none';
      streak.style.visibility = model ? 'hidden' : 'visible';
      if (!model) return;
      scoreText.textContent = model.score;
      gamesText.textContent = model.gamesLine ?? '';
      statusText.textContent = model.status ?? '';
      // A paddle and a dot per Serve left, by whoever serves.
      const mark = model.serving ? `\u{1F3D3} ${'\u25CF'.repeat(model.serving.servesLeft)}` : '';
      playerSlot.textContent = model.serving?.side === 'player' ? mark : '';
      opponentSlot.textContent = model.serving?.side === 'opponent' ? mark : '';
    },
    showFeedback(text) {
      feedback.textContent = text;
      feedback.style.opacity = '1';
      clearTimeout(feedbackTimer);
      feedbackTimer = setTimeout(() => (feedback.style.opacity = '0'), FEEDBACK_MS);
    },
    showHandLost(lost, text = HAND_LOST_TEXT) {
      if (handLost.textContent !== text) handLost.textContent = text;
      if (lost === shownHandLost) return;
      shownHandLost = lost;
      handLost.style.display = lost ? 'block' : 'none';
    },
  };
}
