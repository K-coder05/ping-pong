import type { Hand } from '../sensing/landmarks.ts';

/**
 * "Which hand holds the paddle?": a small modal with Left / Right buttons.
 * Resolves with the answer; it doesn't save it (see `game/handedness.ts`).
 * While it is open, further calls return the same answer.
 */

const STYLE = `
.handedness-prompt {
  position: fixed; inset: 0; z-index: 20;
  display: grid; place-items: center; padding: 16px;
  background: rgba(0, 0, 0, 0.55);
  font: 16px/1.4 system-ui, sans-serif; color: #e6e9ef;
}
.handedness-prompt .card {
  max-width: 360px; padding: 20px 24px; border-radius: 10px;
  background: #161a24; text-align: center;
}
.handedness-prompt h2 { margin: 0 0 16px; font-size: 20px; }
.handedness-prompt .choices { display: flex; gap: 12px; justify-content: center; }
.handedness-prompt button { font: inherit; padding: 10px 18px; border-radius: 6px; cursor: pointer; }
`;

let open: Promise<Hand> | null = null;

export function askHandedness(): Promise<Hand> {
  open ??= new Promise<Hand>((resolve) => {
    const style = document.createElement('style');
    style.textContent = STYLE;
    const root = document.createElement('div');
    root.className = 'handedness-prompt';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'handedness-prompt-title');

    const card = document.createElement('div');
    card.className = 'card';
    const title = document.createElement('h2');
    title.id = 'handedness-prompt-title';
    title.textContent = 'Which hand holds the paddle?';
    const choices = document.createElement('div');
    choices.className = 'choices';

    const choose = (hand: Hand) => {
      root.remove();
      style.remove();
      open = null;
      resolve(hand);
    };
    for (const [hand, label] of [['left', 'Left hand'], ['right', 'Right hand']] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', () => choose(hand));
      choices.append(button);
    }

    card.append(title, choices);
    root.append(card);
    document.head.append(style);
    document.body.append(root);
    choices.querySelector('button')?.focus();
  });
  return open;
}
