import { cameraErrorMessage } from '../game/onboarding.ts';
import { CALIBRATION_TICKS, runTimingCalibration } from '../game/timingCalibration.ts';
import type { SwingSource } from '../input/types.ts';
import { parkVideo } from '../sensing/camera.ts';
import { createMetronomePresentation } from '../tools/metronomePresentation.ts';

/**
 * The onboarding screens (SPEC "Onboarding for the prototype"), drawn as one
 * full-screen panel over the game. Each method shows one step and resolves
 * when the player is through it; the order is decided by `game/onboarding.ts`.
 * "Which hand holds the paddle?" is the existing `askHandedness` prompt.
 *
 * The panel sits below the debug panel and camera overlay, so debug mode
 * still works during onboarding.
 */
export interface OnboardingScreens {
  /** Step 1 for a first-time player: explain, then start the camera on a click. Retries until it starts. */
  askCamera(startCamera: () => Promise<void>): Promise<void>;
  /** A returning player: start the camera straight away, asking only if it fails. */
  startCamera(startCamera: () => Promise<void>): Promise<void>;
  /** Step 2: the mirrored video with "Stand back until your whole swing fits in the picture." */
  framing(video: HTMLVideoElement): Promise<void>;
  /**
   * Step 4, Timing calibration: tick the metronome, collect Swings, and
   * resolve with the measured Timing Offset (ms). Offers a retry when too few
   * Swings were seen. With `cancellable`, a Cancel button resolves null.
   */
  calibrate(options: { video: HTMLVideoElement | null; swings: SwingSource; cancellable: boolean }): Promise<number | null>;
}

const STYLE = `
.onboarding {
  position: fixed; inset: 0; z-index: 8;
  display: grid; place-items: center; padding: 16px; box-sizing: border-box; overflow: auto;
  background: rgba(12, 14, 20, 0.94);
  font: 18px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: #e6e9ef;
}
.onboarding[hidden] { display: none; }
/* While the metronome ticks, drags reach the canvas (the developer mouse swings there). */
.onboarding.ticking { pointer-events: none; }
.onboarding.ticking button { pointer-events: auto; }
.onboarding .card { width: 100%; max-width: 760px; text-align: center; }
.onboarding h2 { margin: 0 0 12px; font-size: 28px; line-height: 1.2; }
.onboarding p { margin: 0 0 12px; }
.onboarding .muted { color: #9aa4b5; font-size: 16px; }
.onboarding .error { color: #ffb4a8; }
.onboarding .stage {
  position: relative; margin: 0 auto 14px; width: min(100%, calc(62vh * 4 / 3));
  aspect-ratio: 4 / 3; background: #000; border-radius: 10px; overflow: hidden;
}
.onboarding .stage video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; transform: scaleX(-1); }
.onboarding .stage .flash { position: absolute; inset: 0; background: #fff; opacity: 0; pointer-events: none; transition: opacity 60ms; }
.onboarding .stage .flash[data-tick] { opacity: 0.8; }
.onboarding .stage .banner {
  position: absolute; left: 0; right: 0; top: 0; padding: 10px 12px;
  background: rgba(0, 0, 0, 0.6); font-size: 26px; font-weight: 700;
}
.onboarding .stage .banner:empty { display: none; }
.onboarding .actions { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
.onboarding button { font: inherit; font-weight: 600; padding: 10px 22px; border-radius: 8px; cursor: pointer; }
`;

export function createOnboardingScreens(): OnboardingScreens {
  const style = document.createElement('style');
  style.textContent = STYLE;
  const root = document.createElement('div');
  root.className = 'onboarding';
  root.hidden = true;
  const card = document.createElement('div');
  card.className = 'card';
  card.setAttribute('aria-live', 'polite');
  root.append(card);
  document.head.append(style);
  document.body.append(root);

  /** The video currently shown on a stage, to park again when the screen changes. */
  let shownVideo: HTMLVideoElement | null = null;

  function show(...nodes: Node[]): void {
    if (shownVideo) parkVideo(shownVideo);
    shownVideo = null;
    card.replaceChildren(...nodes);
    root.classList.remove('ticking');
    root.hidden = false;
    card.querySelector('button')?.focus();
  }

  function hide(): void {
    show();
    root.hidden = true;
  }

  function heading(text: string): HTMLHeadingElement {
    return Object.assign(document.createElement('h2'), { textContent: text });
  }

  function paragraph(text: string, className = ''): HTMLParagraphElement {
    return Object.assign(document.createElement('p'), { textContent: text, className });
  }

  function button(label: string, onClick: () => void): HTMLButtonElement {
    const element = Object.assign(document.createElement('button'), { type: 'button', textContent: label });
    element.addEventListener('click', onClick, { once: true });
    return element;
  }

  function actions(...buttons: HTMLButtonElement[]): HTMLDivElement {
    const row = Object.assign(document.createElement('div'), { className: 'actions' });
    row.append(...buttons);
    return row;
  }

  /**
   * A stage for the mirrored video (if any), with a flash layer and a banner
   * on top. Call `adopt()` after `show()` (which parks the previous screen's
   * video) to move the video in.
   */
  function stage(video: HTMLVideoElement | null) {
    const element = Object.assign(document.createElement('div'), { className: 'stage' });
    const flash = Object.assign(document.createElement('div'), { className: 'flash' });
    const banner = Object.assign(document.createElement('div'), { className: 'banner' });
    element.append(flash, banner);
    const adopt = () => {
      if (!video) return;
      video.style.cssText = '';
      element.prepend(video);
      shownVideo = video;
    };
    return { element, flash, banner, adopt };
  }

  const PRIVACY = 'Your video stays on this device. Nothing is recorded or uploaded.';

  /** Start the camera, showing progress; resolves true once it is on, false after showing why it failed. */
  async function tryStart(startCamera: () => Promise<void>, retry: () => void): Promise<boolean> {
    show(heading('Starting the camera…'), paragraph('Allow camera access if your browser asks.'), paragraph(PRIVACY, 'muted'));
    try {
      await startCamera();
      return true;
    } catch (error) {
      console.error('Camera failed to start', error);
      show(heading("The camera didn't start"), paragraph(cameraErrorMessage(error), 'error'), paragraph(PRIVACY, 'muted'), actions(button('Try again', retry)));
      return false;
    }
  }

  /** Keep trying to start the camera, the first try either right away or on a click. */
  function startUntilOn(startCamera: () => Promise<void>, firstTry: (attempt: () => void) => void): Promise<void> {
    return new Promise<void>((resolve) => {
      const attempt = () =>
        void tryStart(startCamera, attempt).then((on) => {
          if (on) resolve();
        });
      firstTry(attempt);
    }).finally(hide);
  }

  return {
    askCamera(startCamera) {
      return startUntilOn(startCamera, (attempt) =>
        show(
          heading('Play with your hand'),
          paragraph('Return Drill watches your swing through the camera.'),
          paragraph(PRIVACY),
          actions(button('Turn on camera', attempt)),
        ),
      );
    },

    startCamera(startCamera) {
      return startUntilOn(startCamera, (attempt) => attempt());
    },

    framing(video) {
      return new Promise<void>((resolve) => {
        const view = stage(video);
        show(
          view.element,
          heading('Stand back until your whole swing fits in the picture.'),
          actions(
            button("I'm ready", () => {
              hide();
              resolve();
            }),
          ),
        );
        view.adopt();
      });
    },

    calibrate({ video, swings, cancellable }) {
      return new Promise<number | null>((resolve) => {
        let finished = false;
        const finish = (offset: number | null) => {
          finished = true;
          hide();
          resolve(offset);
        };
        const cancelButton = (onCancel: () => void = () => {}) =>
          button('Cancel', () => {
            onCancel();
            finish(null);
          });

        function intro(note?: string): void {
          const view = stage(video);
          show(
            view.element,
            heading('Timing calibration'),
            ...(note ? [paragraph(note, 'error')] : []),
            paragraph(`The screen flashes and clicks ${CALIBRATION_TICKS} times. Swing on each one, as if hitting the ball right then.`),
            actions(button('Start', () => void begin()), ...(cancellable ? [cancelButton()] : [])),
          );
          view.adopt();
        }

        async function begin(): Promise<void> {
          const view = stage(video);
          const presented = createMetronomePresentation({ flashElement: view.flash });
          // Called from the Start click, so the AudioContext may start. Silent
          // if audio is unavailable; the flash still works.
          await presented.unlock().catch(() => undefined);
          if (finished) {
            // Cancelled while audio was starting.
            presented.dispose();
            return;
          }
          const progress = paragraph('Swings seen: 0', 'muted');
          view.banner.textContent = 'Get ready…';
          const run = runTimingCalibration({
            swings,
            onSchedule: presented.callbacks.onSchedule,
            onTick(index, time) {
              presented.callbacks.onTick(index, time);
              view.banner.textContent = `Swing! ${index + 1} / ${CALIBRATION_TICKS}`;
            },
            onSwing: (count) => (progress.textContent = `Swings seen: ${count}`),
          });
          show(
            view.element,
            heading('Swing on every flash and click'),
            progress,
            ...(cancellable
              ? [
                  actions(
                    cancelButton(() => {
                      run.cancel();
                      presented.dispose();
                    }),
                  ),
                ]
              : []),
          );
          view.adopt();
          root.classList.add('ticking');
          const measurement = await run.result;
          presented.dispose();
          if (!measurement) {
            intro("We didn't see enough swings. Make sure your whole swing is in the picture, then try again.");
            return;
          }
          finish(measurement.offsetMs);
        }

        intro();
      });
    },
  };
}
