import { PerspectiveCamera, type WebGLRenderer } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { PLAY_CAMERA_TARGET } from '../game/constants.ts';
import type { KnobRegistry } from '../game/knobs.ts';
import { createPhoneLogRecorder, type PhoneLogRecorder } from '../phone/phoneLog.ts';
import type { PhoneLink } from '../phone/types.ts';
import { createDebugPanel } from './debugPanel.ts';

/**
 * Debug mode, toggled with `D`: swaps the fixed play camera for an orbit
 * camera and shows the knob slider panel with an FPS readout. Turning it off
 * restores the play camera; the orbit camera keeps its pose for next time.
 */
export interface DebugMode {
  readonly active: boolean;
  /** The camera to render with this frame. */
  readonly camera: PerspectiveCamera;
  setActive(active: boolean): void;
  /** Call once per rendered frame with the real seconds since the last frame. */
  update(elapsedSeconds: number): void;
  /** Keep the orbit camera's aspect ratio in step with the canvas size. */
  resize(width: number, height: number): void;
}

const FPS_SAMPLE_SECONDS = 0.5;

export function createDebugMode(options: {
  renderer: WebGLRenderer;
  playCamera: PerspectiveCamera;
  registry: KnobRegistry;
}): DebugMode {
  const { renderer, playCamera, registry } = options;
  const panel = createDebugPanel(registry);

  const orbitCamera = playCamera.clone();
  const controls = new OrbitControls(orbitCamera, renderer.domElement);
  controls.target.set(PLAY_CAMERA_TARGET.x, PLAY_CAMERA_TARGET.y, PLAY_CAMERA_TARGET.z);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI / 2 - 0.05; // stay above the floor
  controls.enabled = false;
  controls.update();

  let active = false;
  let fpsFrames = 0;
  let fpsSeconds = 0;

  const mode: DebugMode = {
    get active() {
      return active;
    },
    get camera() {
      return active ? orbitCamera : playCamera;
    },
    setActive(next) {
      active = next;
      controls.enabled = next;
      panel.setVisible(next);
    },
    update(elapsedSeconds) {
      if (!active) return;
      controls.update();
      fpsFrames++;
      fpsSeconds += elapsedSeconds;
      if (fpsSeconds >= FPS_SAMPLE_SECONDS) {
        panel.setFps(fpsFrames / fpsSeconds);
        fpsFrames = 0;
        fpsSeconds = 0;
      }
    },
    resize(width, height) {
      orbitCamera.aspect = width / height;
      orbitCamera.updateProjectionMatrix();
    },
  };

  window.addEventListener('keydown', (event) => {
    // Match the letter, not the physical key, so it works on any layout.
    if (event.key.toLowerCase() !== 'd' || event.repeat) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isTextEntry(event.target)) return;
    mode.setActive(!active);
  });

  return mode;
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  return target instanceof HTMLInputElement && !['range', 'checkbox', 'button'].includes(target.type);
}

/**
 * The name to suggest for the next Phone log clip: the last name with its
 * trailing number one higher, keeping its zero padding
 * (`phone-fore-top-03` → `phone-fore-top-04`), or the first Forehand topspin
 * clip's name if there was none.
 */
export function nextClipName(last: string | null): string {
  if (!last) return 'phone-fore-top-01';
  const m = /^(.*?)(\d+)$/.exec(last);
  if (!m) return `${last}-01`;
  const next = String(Number(m[2]) + 1).padStart(m[2]!.length, '0');
  return `${m[1]}${next}`;
}

/**
 * Phone log recording for fixtures (docs/specs/p3.md, P3-c; see
 * fixtures/phone/README.md): while `recording()` (debug mode is on), every
 * packet and Zeroing the laptop receives goes into the Phone log. The debug
 * panel's Phone group gets "Download Phone log", which asks for the clip's
 * name (suggesting the next one), downloads it as `<name>.jsonl` and starts
 * a fresh log, and "Discard Phone log".
 */
export function installPhoneLogDownload(options: {
  registry: KnobRegistry;
  link: Pick<PhoneLink, 'onPacket' | 'onControl'>;
  recording: () => boolean;
}): void {
  const { registry, link, recording } = options;
  let log: PhoneLogRecorder = createPhoneLogRecorder();
  let packets = 0;
  let zeroings = 0;
  let firstRecv: number | null = null;
  let lastRecv = 0;
  let lastName: string | null = null;

  const restart = () => {
    log = createPhoneLogRecorder();
    packets = 0;
    zeroings = 0;
    firstRecv = null;
  };
  link.onPacket((p, tRecv) => {
    if (!recording()) return;
    log.record(p, tRecv);
    packets++;
    firstRecv ??= tRecv;
    lastRecv = tRecv;
  });
  link.onControl((m, tRecv) => {
    if (!recording() || m.type !== 'zero') return;
    log.zero(tRecv);
    zeroings++;
  });

  registry.button({
    name: 'Download Phone log',
    group: 'Phone',
    onPress: () => {
      const seconds = firstRecv === null ? 0 : (lastRecv - firstRecv) / 1000;
      const summary = `Phone log: ${packets} packets, ${zeroings} Zeroing${zeroings === 1 ? '' : 's'}, ${seconds.toFixed(1)} s.`;
      if (packets === 0) {
        window.alert(`${summary} Nothing to download yet: debug mode must be on while the Phone sends.`);
        return;
      }
      const name = window.prompt(`${summary}\nName this clip (it downloads as <name>.jsonl):`, nextClipName(lastName))?.trim();
      if (!name) return; // cancelled: keep recording into the same log
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([log.toJsonl()], { type: 'application/x-ndjson' }));
      a.download = `${name.replace(/\.jsonl$/, '')}.jsonl`;
      a.click();
      URL.revokeObjectURL(a.href);
      lastName = name.replace(/\.jsonl$/, '');
      restart();
    },
  });
  registry.button({ name: 'Discard Phone log', group: 'Phone', onPress: restart });
}
