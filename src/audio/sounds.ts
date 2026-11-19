import { contextTimeAt } from './audioClock.ts';

/**
 * The game's only sounds (SPEC "Scene, Paddle and sound"): one short
 * synthesized *tock* when the Paddle meets the ball, and a lighter one for
 * each table bounce. Nothing else.
 *
 * Browsers start an AudioContext suspended until a user gesture, so nothing
 * plays before `unlock()` has run from one (see `unlockAudioOnGesture`);
 * sounds asked for before then are silently skipped.
 */
export interface Sounds {
  /** The contact tock, heard at `atMs` (`performance.now()` clock); as soon as possible if that has passed. */
  contact(atMs: number): void;
  /** A bounce tock, heard at `atMs`, by default now. */
  bounce(atMs?: number): void;
  /** Create or resume the AudioContext; call from a user gesture. */
  unlock(): Promise<void>;
  /** Whether the AudioContext is running (sounds will play). */
  readonly unlocked: boolean;
}

/** One tock: a pitch-dropping blip with a fast attack and short exponential decay. */
interface Tock {
  type: OscillatorType;
  startHz: number;
  endHz: number;
  peak: number;
  seconds: number;
}

/** Paddle meets ball: lower, fuller, a little longer. */
const CONTACT_TOCK: Tock = { type: 'triangle', startHz: 1150, endHz: 520, peak: 0.7, seconds: 0.07 };
/** Ball on the table: higher, lighter, shorter. */
const BOUNCE_TOCK: Tock = { type: 'sine', startHz: 1900, endHz: 1150, peak: 0.4, seconds: 0.045 };
const ATTACK_SECONDS = 0.002;

export function createSounds(): Sounds {
  let ctx: AudioContext | null = null;

  function play(tock: Tock, atMs: number): void {
    if (!ctx || ctx.state !== 'running') return;
    const at = Math.max(contextTimeAt(ctx, atMs), ctx.currentTime);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = tock.type;
    osc.frequency.setValueAtTime(tock.startHz, at);
    osc.frequency.exponentialRampToValueAtTime(tock.endHz, at + tock.seconds);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(tock.peak, at + ATTACK_SECONDS);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + tock.seconds);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + tock.seconds + 0.01);
  }

  return {
    contact: (atMs) => play(CONTACT_TOCK, atMs),
    bounce: (atMs = performance.now()) => play(BOUNCE_TOCK, atMs),
    async unlock() {
      ctx ??= new AudioContext({ latencyHint: 'interactive' });
      if (ctx.state === 'suspended') await ctx.resume();
    },
    get unlocked() {
      return ctx?.state === 'running';
    },
  };
}

/** Unlock `sounds` on the first pointer press or key press on the page (retrying on later ones until it runs). */
export function unlockAudioOnGesture(sounds: Sounds, target: EventTarget = window): void {
  const events = ['pointerdown', 'keydown'] as const;
  const onGesture = () => {
    sounds.unlock().then(
      () => {
        if (sounds.unlocked) events.forEach((type) => target.removeEventListener(type, onGesture, true));
      },
      (error: unknown) => console.error('Audio unlock failed', error),
    );
  };
  events.forEach((type) => target.addEventListener(type, onGesture, true));
}
