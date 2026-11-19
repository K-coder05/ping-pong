import type { Knob, KnobRegistry, NumberKnob, RegistryEntry } from '../game/knobs.ts';

/**
 * The on-screen slider panel shown in debug mode. It mirrors a knob registry:
 * one row per knob, grouped by `group`, including knobs registered after the
 * panel was built. Moving a slider sets the knob; game code sees the new
 * value on its next read.
 */
export interface DebugPanel {
  setVisible(visible: boolean): void;
  setFps(fps: number): void;
}

const STYLE = `
.debug-panel {
  position: fixed; top: 8px; right: 8px; z-index: 10;
  width: 300px; max-width: calc(100vw - 16px); max-height: calc(100vh - 16px); overflow-y: auto;
  padding: 8px 10px; box-sizing: border-box;
  background: rgba(12, 14, 20, 0.85); color: #e6e9ef;
  font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  border-radius: 6px;
}
.debug-panel[hidden] { display: none; }
.debug-panel header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.debug-panel fieldset { border: 1px solid #3a4050; border-radius: 4px; margin: 0 0 8px; padding: 4px 8px 6px; }
.debug-panel legend { color: #9fb3d9; padding: 0 4px; }
.debug-panel .row { display: grid; grid-template-columns: 1fr auto; gap: 0 8px; margin: 4px 0; }
.debug-panel .row input[type=range] { grid-column: 1 / -1; width: 100%; margin: 0; }
.debug-panel .row output { color: #ffd27a; }
.debug-panel label.toggle { display: flex; gap: 6px; align-items: center; margin: 4px 0; }
.debug-panel button { font: inherit; margin: 2px 4px 2px 0; }
`;

export function createDebugPanel(registry: KnobRegistry): DebugPanel {
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.append(style);

  const element = document.createElement('aside');
  element.className = 'debug-panel';
  element.hidden = true;

  const header = document.createElement('header');
  const title = document.createElement('strong');
  title.textContent = 'Debug (D)';
  const fpsReadout = document.createElement('span');
  fpsReadout.textContent = 'FPS –';
  header.append(title, fpsReadout);

  element.append(header);
  document.body.append(element);

  const groups = new Map<string, HTMLFieldSetElement>();
  const refreshers = new Map<string, () => void>();

  function groupFor(name: string): HTMLFieldSetElement {
    let fieldset = groups.get(name);
    if (!fieldset) {
      fieldset = document.createElement('fieldset');
      const legend = document.createElement('legend');
      legend.textContent = name;
      fieldset.append(legend);
      element.append(fieldset);
      groups.set(name, fieldset);
    }
    return fieldset;
  }

  function addEntry(entry: RegistryEntry): void {
    const fieldset = groupFor(entry.group);
    switch (entry.kind) {
      case 'number':
        fieldset.append(numberRow(entry));
        break;
      case 'toggle': {
        const label = document.createElement('label');
        label.className = 'toggle';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = entry.value;
        checkbox.addEventListener('change', () => entry.set(checkbox.checked));
        label.append(checkbox, entry.name);
        refreshers.set(entry.name, () => (checkbox.checked = entry.value));
        fieldset.append(label);
        break;
      }
      case 'button': {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = entry.name;
        button.addEventListener('click', () => entry.press());
        fieldset.append(button);
        break;
      }
    }
  }

  function numberRow(knob: NumberKnob): HTMLElement {
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('label');
    label.textContent = knob.name;
    const output = document.createElement('output');
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(knob.min);
    slider.max = String(knob.max);
    slider.step = String(knob.step);
    slider.id = `knob-${knob.name}`;
    label.htmlFor = slider.id;
    const decimals = decimalsOf(knob.step);
    const refresh = () => {
      slider.value = String(knob.value);
      output.textContent = knob.value.toFixed(decimals);
    };
    slider.addEventListener('input', () => {
      knob.set(Number(slider.value));
      refresh(); // shows the snapped value even if set() did not change anything
    });
    refresh();
    refreshers.set(knob.name, refresh);
    row.append(label, output, slider);
    return row;
  }

  registry.entries().forEach(addEntry);
  registry.onRegister(addEntry);
  registry.onChange((knob: Knob) => refreshers.get(knob.name)?.());

  return {
    setVisible(visible) {
      element.hidden = !visible;
    },
    setFps(fps) {
      fpsReadout.textContent = `FPS ${Math.round(fps)}`;
    },
  };
}

function decimalsOf(step: number): number {
  const text = String(step);
  if (text.includes('e-')) return Number(text.split('e-')[1]);
  return text.split('.')[1]?.length ?? 0;
}
