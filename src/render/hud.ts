/**
 * The player's heads-up display, drawn as HTML over the canvas. For now it
 * shows the "3, 2, 1" cue before each Feed; the Streak and the Early! / Late! /
 * Miss feedback join it later. Sized to be read from 1.5–2 m away.
 */
export interface Hud {
  /** Show 3, 2 or 1 big in the middle of the screen; null hides it. Cheap to call every frame. */
  showCountdown(count: number | null): void;
}

export function createHud(): Hud {
  const countdown = document.createElement('div');
  countdown.setAttribute('aria-live', 'assertive');
  Object.assign(countdown.style, {
    position: 'fixed',
    inset: '0',
    display: 'none', // 'grid' while showing; an inline display would beat the `hidden` attribute

    placeItems: 'center',
    pointerEvents: 'none',
    zIndex: '5',
    color: '#ffffff',
    font: '700 22vmin/1 system-ui, -apple-system, "Segoe UI", sans-serif',
    textShadow: '0 0.04em 0.12em rgba(0, 0, 0, 0.6)',
  });
  document.body.append(countdown);

  let shown: number | null = null;
  return {
    showCountdown(count) {
      if (count === shown) return;
      shown = count;
      countdown.style.display = count === null ? 'none' : 'grid';
      countdown.textContent = count === null ? '' : String(count);
    },
  };
}
