/**
 * The Input picker (docs/specs/p3.md, P3-e): the player chooses how they
 * swing, the Camera or their Phone. The developer mouse (`?input=mouse`) is
 * never offered; it stays a URL flag, and any `?input=` flag overrides the
 * picker's choice.
 *
 * The choice is remembered, so a returning player goes straight to that
 * Input's setup; the start screen shows the Input and lets them change it.
 *
 * The first part of this module is pure (tests drive it in Node): the
 * options, the `?input=` flag, the remembered choice, and whether the Phone
 * is ready for Continue. `pickInput` is the thin DOM picker.
 */
import type { KeyValueStorage } from '../game/handedness.ts';
import type { Input, InputMode } from '../game/onboarding.ts';
import { statusLabel } from '../phone/link.ts';
import type { LinkStatus } from '../phone/types.ts';

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

export interface InputOption {
  readonly input: Input;
  readonly label: string;
  readonly detail: string;
}

/** What the picker offers players, in order: the Camera or the Phone, never the mouse. */
export const INPUT_OPTIONS: readonly InputOption[] = Object.freeze([
  Object.freeze({ input: 'camera', label: 'Camera', detail: 'Swing at the laptop’s camera' }),
  Object.freeze({ input: 'phone', label: 'Phone', detail: 'Hold your Phone like the handle of a bat' }),
] as const);

export const INPUT_LABEL: Readonly<Record<Input, string>> = Object.freeze({ camera: 'Camera', phone: 'Phone' });

/**
 * The developer `?input=` flag, which overrides the picker: `mouse`, `phone`,
 * or `camera` (`pose` too, its older name). Null without one, or for anything else.
 */
export function inputFromSearch(search: string): InputMode | null {
  const input = new URLSearchParams(search).get('input');
  if (input === 'mouse' || input === 'phone' || input === 'camera') return input;
  if (input === 'pose') return 'camera';
  return null;
}

/** The player's chosen Input, remembered in `localStorage`. */
export interface InputChoiceStore {
  /** The remembered Input, or null if the player hasn't picked one yet. */
  readonly input: Input | null;
  /** Remember `input`. */
  save(input: Input): void;
}

const INPUT_KEY = 'returnDrill.input';

/** `storage` is a getter because merely reading `window.localStorage` can throw. Every access is guarded. */
export function createInputChoiceStore(storage: () => KeyValueStorage | null): InputChoiceStore {
  let input = load();

  function load(): Input | null {
    try {
      const saved = storage()?.getItem(INPUT_KEY);
      return saved === 'camera' || saved === 'phone' ? saved : null;
    } catch {
      return null;
    }
  }

  return {
    get input() {
      return input;
    },
    save(next) {
      input = next;
      try {
        storage()?.setItem(INPUT_KEY, next);
      } catch {
        // Not saved; the picker shows again next visit.
      }
    },
  };
}

/** The page's chosen Input, in `localStorage`. */
export const inputChoice: InputChoiceStore = createInputChoiceStore(() => (typeof window === 'undefined' ? null : window.localStorage));

/** Where the Phone is in setup, for the Zeroing and Continue steps. */
export interface PhoneReadiness {
  /** Paired, directly or through the relay. */
  readonly connected: boolean;
  readonly zeroed: boolean;
  /** Continue unlocks only once the Phone is connected and Zeroed. */
  readonly canContinue: boolean;
  /** The connection status, as the pairing screen words it. */
  readonly connection: string;
  /** "Zeroed", or what to do to Zero it. */
  readonly zeroing: string;
}

export function phoneReadiness({ status, zeroed }: { status: LinkStatus; zeroed: boolean }): PhoneReadiness {
  const connected = status === 'connected' || status === 'relay';
  return {
    connected,
    zeroed,
    canContinue: connected && zeroed,
    connection: statusLabel(status),
    zeroing: zeroed ? 'Zeroed' : 'Not Zeroed yet: tap Zero on the Phone',
  };
}

// ---------------------------------------------------------------------------
// The picker (DOM)
// ---------------------------------------------------------------------------

const STYLE = `
.input-picker {
  position: fixed; inset: 0; z-index: 9;
  display: grid; place-items: center; padding: 16px; box-sizing: border-box; overflow: auto;
  background: rgba(12, 14, 20, 0.94);
  font: 18px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: #e6e9ef;
}
.input-picker .card { width: 100%; max-width: 760px; text-align: center; }
.input-picker h1 { margin: 0 0 6px; font-size: 44px; line-height: 1.1; }
.input-picker p { margin: 0 0 12px; color: #9aa4b5; font-size: 16px; }
.input-picker .options { display: flex; gap: 16px; justify-content: center; flex-wrap: wrap; margin-top: 18px; }
.input-picker button { font: inherit; font-weight: 600; width: min(100%, 300px); padding: 18px 22px; border-radius: 8px; cursor: pointer; }
.input-picker button span { display: block; font-size: 15px; font-weight: 400; opacity: 0.8; }
.input-picker button[aria-pressed="true"] { background: #ffd84a; color: #1d2230; border-color: #ffd84a; }
`;

/**
 * Ask how the player will swing: the Camera or the Phone. `current` (if any)
 * is shown as chosen. Resolves with the pick; it doesn't save it.
 */
export function pickInput(current: Input | null = null): Promise<Input> {
  return new Promise<Input>((resolve) => {
    const style = Object.assign(document.createElement('style'), { textContent: STYLE });
    const root = Object.assign(document.createElement('div'), { className: 'input-picker' });
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    const card = Object.assign(document.createElement('div'), { className: 'card' });
    const options = Object.assign(document.createElement('div'), { className: 'options' });
    for (const option of INPUT_OPTIONS) {
      const button = Object.assign(document.createElement('button'), { type: 'button', textContent: option.label });
      button.dataset.input = option.input;
      if (current) button.setAttribute('aria-pressed', String(option.input === current));
      button.append(Object.assign(document.createElement('span'), { textContent: option.detail }));
      button.addEventListener('click', () => {
        root.remove();
        style.remove();
        resolve(option.input);
      });
      options.append(button);
    }
    card.append(
      Object.assign(document.createElement('h1'), { textContent: 'Ping Pong' }),
      Object.assign(document.createElement('p'), { textContent: 'How will you swing?' }),
      options,
    );
    root.append(card);
    document.head.append(style);
    document.body.append(root);
    (options.querySelector<HTMLElement>('[aria-pressed="true"]') ?? options.querySelector('button'))?.focus();
  });
}
