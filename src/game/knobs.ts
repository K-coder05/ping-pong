/**
 * Knob registry: the live store behind every tuning knob.
 *
 * Game code registers knobs (usually in `constants.ts`) and reads `.value`
 * whenever it needs the number, so a change made in the debug panel takes
 * effect on the next read, without reloading. The panel enumerates
 * `entries()` and subscribes to `onRegister` / `onChange` to stay in sync.
 */

const DEFAULT_GROUP = 'General';

export interface NumberKnobSpec {
  name: string;
  min: number;
  max: number;
  step: number;
  default: number;
  group?: string;
}

export interface ToggleKnobSpec {
  name: string;
  default: boolean;
  group?: string;
}

export interface ButtonSpec {
  name: string;
  onPress: () => void;
  group?: string;
}

export interface NumberKnob {
  readonly kind: 'number';
  readonly name: string;
  readonly group: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly default: number;
  readonly value: number;
  /** Clamps to [min, max] and snaps to the step grid. */
  set(value: number): void;
  reset(): void;
}

export interface ToggleKnob {
  readonly kind: 'toggle';
  readonly name: string;
  readonly group: string;
  readonly default: boolean;
  readonly value: boolean;
  set(value: boolean): void;
  reset(): void;
}

/** A debug action shown as a button in the panel, e.g. "Drop ball". */
export interface Button {
  readonly kind: 'button';
  readonly name: string;
  readonly group: string;
  press(): void;
}

export type Knob = NumberKnob | ToggleKnob;
export type RegistryEntry = Knob | Button;

export interface KnobRegistry {
  number(spec: NumberKnobSpec): NumberKnob;
  toggle(spec: ToggleKnobSpec): ToggleKnob;
  button(spec: ButtonSpec): Button;
  /** Every registered entry, in registration order. */
  entries(): readonly RegistryEntry[];
  /** Called for each entry registered after subscribing. Returns an unsubscribe function. */
  onRegister(listener: (entry: RegistryEntry) => void): () => void;
  /** Called whenever a knob's value actually changes. Returns an unsubscribe function. */
  onChange(listener: (knob: Knob) => void): () => void;
  resetAll(): void;
}

function clampToGrid(value: number, { min, max, step }: NumberKnobSpec): number {
  const clamped = Math.min(max, Math.max(min, value));
  const snapped = min + Math.round((clamped - min) / step) * step;
  // toPrecision strips binary float noise such as 0.6000000000000001.
  return Number(Math.min(max, snapped).toPrecision(12));
}

function validate(spec: NumberKnobSpec): void {
  const { name, min, max, step } = spec;
  const fail = (why: string) => {
    throw new Error(`Knob ${name}: ${why}`);
  };
  if (!(step > 0)) fail(`step must be positive, got ${step}`);
  if (!(min < max)) fail(`min (${min}) must be below max (${max})`);
  if (spec.default < min || spec.default > max) fail(`default ${spec.default} is outside [${min}, ${max}]`);
  if (clampToGrid(spec.default, spec) !== spec.default) fail(`default ${spec.default} is not on the step grid (step ${step} from ${min})`);
}

function subscribable<T>() {
  const listeners = new Set<(value: T) => void>();
  return {
    subscribe(listener: (value: T) => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    emit(value: T) {
      for (const listener of listeners) listener(value);
    },
  };
}

export function createKnobRegistry(): KnobRegistry {
  const registeredEntries: RegistryEntry[] = [];
  const registered = subscribable<RegistryEntry>();
  const changed = subscribable<Knob>();

  function add<E extends RegistryEntry>(entry: E): E {
    if (registeredEntries.some((e) => e.name === entry.name)) throw new Error(`Knob ${entry.name} is already registered`);
    registeredEntries.push(entry);
    registered.emit(entry);
    return entry;
  }

  return {
    number(spec) {
      validate(spec);
      let value = spec.default;
      const knob: NumberKnob = {
        kind: 'number',
        name: spec.name,
        group: spec.group ?? DEFAULT_GROUP,
        min: spec.min,
        max: spec.max,
        step: spec.step,
        default: spec.default,
        get value() {
          return value;
        },
        set(next) {
          const snapped = clampToGrid(next, spec);
          if (snapped === value) return;
          value = snapped;
          changed.emit(knob);
        },
        reset() {
          knob.set(knob.default);
        },
      };
      return add(knob);
    },

    toggle(spec) {
      let value = spec.default;
      const knob: ToggleKnob = {
        kind: 'toggle',
        name: spec.name,
        group: spec.group ?? DEFAULT_GROUP,
        default: spec.default,
        get value() {
          return value;
        },
        set(next) {
          if (next === value) return;
          value = next;
          changed.emit(knob);
        },
        reset() {
          knob.set(knob.default);
        },
      };
      return add(knob);
    },

    button(spec) {
      return add<Button>({
        kind: 'button',
        name: spec.name,
        group: spec.group ?? DEFAULT_GROUP,
        press: () => spec.onPress(),
      });
    },

    entries: () => registeredEntries,
    onRegister: registered.subscribe,
    onChange: changed.subscribe,

    resetAll() {
      for (const entry of registeredEntries) {
        if (entry.kind !== 'button') entry.reset();
      }
    },
  };
}

/** The app-wide registry. Tests create their own with `createKnobRegistry()`. */
export const knobs = createKnobRegistry();
