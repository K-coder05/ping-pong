import { PerspectiveCamera, type WebGLRenderer } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { PLAY_CAMERA_TARGET } from '../game/constants.ts';
import type { KnobRegistry } from '../game/knobs.ts';
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
