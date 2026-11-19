import { MAX_FRAME_DT, PHYSICS_DT } from './constants.ts';

/**
 * Turns real frame time into whole PHYSICS_DT substeps (SPEC: "run physics
 * from an accumulator in the render loop"). Leftover time carries to the next
 * frame, so the simulation runs at `timeScale` × real time on average.
 */
export interface SimClock {
  /** Add one frame's real elapsed seconds; returns how many substeps to run now. */
  advance(frameSeconds: number, timeScale: number): number;
}

/**
 * Real milliseconds that `simSeconds` of simulation take at `timeScale`: how to
 * put a simulated moment (e.g. a Feed's Ideal Time) on the performance.now() clock.
 */
export function simSecondsToRealMs(simSeconds: number, timeScale: number): number {
  return (simSeconds / timeScale) * 1000;
}

/** Tolerance so float noise (1/60 − 3·(1/240) ≈ 1/240 − ε) doesn't drop a substep. */
const EPSILON = 1e-9;

export function createSimClock(): SimClock {
  let accumulator = 0;
  return {
    advance(frameSeconds, timeScale) {
      accumulator += Math.min(frameSeconds, MAX_FRAME_DT) * timeScale;
      let steps = 0;
      while (accumulator >= PHYSICS_DT - EPSILON) {
        accumulator -= PHYSICS_DT;
        steps++;
      }
      return steps;
    },
  };
}
