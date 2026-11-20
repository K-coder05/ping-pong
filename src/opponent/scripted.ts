/**
 * The scripted Opponent (spec P2-b): a stand-in until the Opponent's brain
 * (P2-c). It returns every Shot to the middle of the player's half, with no
 * spin and no mistakes, and draws nothing from `random`.
 */

import type { Opponent } from '../game/rally.ts';
import type { ShotIntent } from '../game/solver.ts';

/** Where and how the scripted Opponent returns everything: (x 0, z 0.7), 0.9 s flight, no spin. */
export const SCRIPTED_RETURN: Readonly<ShotIntent> = Object.freeze({
  target: Object.freeze({ x: 0, z: 0.7 }),
  flightTime: 0.9,
  topspin: 0,
  sidespin: 0,
});

export function createScriptedOpponent(): Opponent {
  return {
    chooseShot: () => ({ ...SCRIPTED_RETURN, target: { ...SCRIPTED_RETURN.target } }),
  };
}
