import type { BallState } from '../game/ball.ts';

/**
 * Debug-mode readout of the ball's status (live / dead / out) and the half of
 * its latest bounce, in the bottom-left corner.
 */
export interface BallStatusReadout {
  update(ball: BallState, visible: boolean): void;
}

const STATUS_COLOURS: Record<BallState['status'], string> = { live: '#7ee787', dead: '#ff7b72', out: '#ffd27a' };

export function createBallStatusReadout(): BallStatusReadout {
  const element = document.createElement('div');
  element.hidden = true;
  Object.assign(element.style, {
    position: 'fixed',
    left: '8px',
    bottom: '8px',
    zIndex: '10',
    padding: '4px 8px',
    borderRadius: '4px',
    background: 'rgba(12, 14, 20, 0.85)',
    font: '12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
  });
  document.body.append(element);

  let shown = '';
  return {
    update(ball, visible) {
      element.hidden = !visible;
      if (!visible) return;
      const text = `Ball: ${ball.status} · last bounce: ${ball.lastBounceHalf ?? '–'}`;
      if (text === shown) return;
      shown = text;
      element.textContent = text;
      element.style.color = STATUS_COLOURS[ball.status];
    },
  };
}
