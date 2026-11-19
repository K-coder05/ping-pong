import { contextTimeAt } from '../audio/audioClock.ts';
import type { MetronomeOptions } from './metronome.ts';

/**
 * Audio + visual presentation for a `Metronome`, kept apart from its
 * scheduling. Returns `onSchedule` / `onTick` callbacks to pass to
 * `createMetronome`, so the logic stays testable without audio or DOM.
 *
 * Sync approach: the Web Audio click is scheduled at the exact context time
 * matching the tick's `performance.now()` time (`contextTimeAt`), so it
 * already accounts for output latency where the browser reports it. The
 * flash is toggled from `onTick`, which fires within a few ms of the tick
 * time (screen refresh adds up to ~16 ms).
 */

const CLICK_HZ = 1000;
const CLICK_SECONDS = 0.06;

export interface MetronomePresentation {
  /** Pass as `onSchedule` (and `onTick`) to `createMetronome`. */
  readonly callbacks: Required<Pick<MetronomeOptions, 'onSchedule' | 'onTick'>>;
  /** Create/resume the AudioContext; call from a user gesture (e.g. the Start click). */
  unlock(): Promise<void>;
  dispose(): void;
}

export interface PresentationOptions {
  /** Element that flashes on each tick; gets the `data-tick` attribute set to "1" briefly. */
  flashElement: HTMLElement;
  flashMs?: number;
}

export function createMetronomePresentation({ flashElement, flashMs = 150 }: PresentationOptions): MetronomePresentation {
  let ctx: AudioContext | null = null;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;

  return {
    callbacks: {
      onSchedule(_index, time) {
        if (!ctx) return;
        const at = Math.max(contextTimeAt(ctx, time), ctx.currentTime);
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = CLICK_HZ;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.8, at + 0.003);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + CLICK_SECONDS);
        osc.connect(gain).connect(ctx.destination);
        osc.start(at);
        osc.stop(at + CLICK_SECONDS + 0.01);
      },
      onTick() {
        flashElement.dataset.tick = '1';
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => delete flashElement.dataset.tick, flashMs);
      },
    },
    async unlock() {
      ctx ??= new AudioContext({ latencyHint: 'interactive' });
      if (ctx.state === 'suspended') await ctx.resume();
    },
    dispose() {
      clearTimeout(flashTimer);
      void ctx?.close();
      ctx = null;
    },
  };
}
