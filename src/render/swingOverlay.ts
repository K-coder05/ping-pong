import { SWING_ON } from '../game/constants.ts';
import type { PoseInput } from '../input/poseInput.ts';
import type { SwingEvent } from '../input/types.ts';
import type { OverlayExtension, OverlayView } from './cameraOverlay.ts';

/**
 * The Swing detector's layer on the camera overlay (SPEC "Debug overlay"):
 * a live stroke-speed bar with the `SWING_ON` threshold marked, a flash
 * naming the side on every Swing Onset, and the detector's per-frame values
 * as extra CSV columns.
 */

/** How long the Onset flash stays up, ms of camera time. */
const FLASH_MS = 350;

const COLOR = {
  barBackground: 'rgba(0, 0, 0, 0.55)',
  stroke: '#ffb74d',
  overThreshold: '#66e08a',
  backswing: '#7f8fa6',
  threshold: '#ff5252',
  text: '#e6e9ef',
  forehand: '102, 224, 138',
  backhand: '79, 195, 247',
} as const;

export function createSwingOverlay(input: PoseInput): OverlayExtension & { stop(): void } {
  let lastSwing: SwingEvent | null = null;
  const unsubscribe = input.subscribe((swing) => (lastSwing = swing));

  function drawBar({ ctx, width, frame }: OverlayView): void {
    const reading = input.read(frame);
    const swingOn = SWING_ON.value;
    const max = Math.max(2 * swingOn, 6);
    const min = -max / 3;
    const left = 10;
    const top = 10;
    const barWidth = width - 20;
    const barHeight = 16;
    const xOf = (v: number) => left + ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * barWidth;

    ctx.fillStyle = COLOR.barBackground;
    ctx.fillRect(left, top, barWidth, barHeight);
    const stroke = reading?.sStroke ?? null;
    if (stroke !== null) {
      ctx.fillStyle = stroke < 0 ? COLOR.backswing : stroke > swingOn ? COLOR.overThreshold : COLOR.stroke;
      const x0 = xOf(0);
      const x1 = xOf(stroke);
      ctx.fillRect(Math.min(x0, x1), top + 2, Math.abs(x1 - x0), barHeight - 4);
    }
    // Zero and threshold marks.
    ctx.fillStyle = COLOR.text;
    ctx.fillRect(xOf(0) - 1, top, 2, barHeight);
    ctx.fillStyle = COLOR.threshold;
    ctx.fillRect(xOf(swingOn) - 1.5, top - 3, 3, barHeight + 6);

    ctx.font = '13px ui-monospace, Menlo, monospace';
    ctx.textBaseline = 'top';
    ctx.fillStyle = COLOR.text;
    const fmt = (n: number | null) => (n === null ? '–' : n.toFixed(1));
    const status = reading
      ? `stroke ${fmt(stroke)} / SWING_ON ${swingOn.toFixed(1)} sw/s · total ${fmt(reading.s)} · ${reading.side} · ${reading.armed ? 'armed' : 're-arm: hold still'}`
      : 'no pose';
    ctx.fillText(status, left, top + barHeight + 6);
  }

  function drawFlash({ ctx, width, height, frame }: OverlayView): void {
    if (!lastSwing) return;
    const age = frame.t - lastSwing.t;
    if (age < 0 || age > FLASH_MS) return;
    const alpha = 1 - age / FLASH_MS;
    const rgb = COLOR[lastSwing.side];
    ctx.lineWidth = 12;
    ctx.strokeStyle = `rgba(${rgb}, ${alpha})`;
    ctx.strokeRect(6, 6, width - 12, height - 12);
    ctx.font = 'bold 40px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = `rgba(${rgb}, ${alpha})`;
    ctx.fillText(`${lastSwing.side.toUpperCase()} ${lastSwing.peakSpeed.toFixed(1)}`, width / 2, height / 2);
    ctx.textAlign = 'start';
  }

  return {
    draw(view) {
      drawBar(view);
      drawFlash(view);
    },
    logFields(frame) {
      const reading = input.read(frame);
      return {
        px: reading?.p.x ?? null,
        py: reading?.p.y ?? null,
        u: reading?.u ?? null,
        s: reading?.s ?? null,
        sStroke: reading?.sStroke ?? null,
        vertSpeed: reading?.vertSpeed ?? null,
        side: reading?.side ?? null,
        onset: reading ? (reading.swing ? 1 : 0) : null,
      };
    },
    stop: unsubscribe,
  };
}
