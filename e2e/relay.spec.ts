import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { MotionPacket } from '../src/phone/types.ts';

/** Relay when peer-to-peer is blocked (docs/specs/p3.md, P3-e §1; #43). */

const ROOM = /^[2-9A-HJKMNP-Z]{5}$/;

/**
 * Block peer to peer the way a network that blocks device-to-device traffic
 * does: every RTCPeerConnection may only use TURN relay candidates, and there
 * is no TURN server (ADR 0004), so ICE never finds a path and the data
 * channels never open. Test-only; the pages' code is untouched.
 */
async function blockPeerToPeer(context: BrowserContext) {
  await context.addInitScript(() => {
    const Real = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Real {
      constructor(config?: RTCConfiguration) {
        super({ ...config, iceTransportPolicy: 'relay' });
      }
    };
  });
}

type LinkHandle = {
  onStatus(cb: (s: string) => void): void;
  onPacket(cb: (p: MotionPacket) => void): void;
  onControl(cb: (m: { type: string }) => void): void;
  sendControl(m: unknown): void;
};

async function openLaptop(page: Page): Promise<string> {
  await page.goto('/pairing.html');
  const roomEl = page.getByTestId('room-code');
  await expect(roomEl).toHaveText(ROOM);
  await expect(page.getByTestId('status')).toHaveText('Waiting for Phone');
  // When the laptop's statuses change, on its own clock: `connecting` is when signaling with the Phone starts.
  await page.evaluate(() => {
    const w = window as unknown as { __phoneLink: LinkHandle; __statusAt: Record<string, number> };
    w.__statusAt = {};
    w.__phoneLink.onStatus((s) => (w.__statusAt[s] ??= performance.now()));
  });
  return (await roomEl.textContent())!;
}

test('with peer to peer blocked, the pages switch to relay within 6 s and packets and control messages keep flowing', async ({ context }) => {
  await blockPeerToPeer(context);
  const laptop = await context.newPage();
  const phone = await context.newPage();
  const room = await openLaptop(laptop);
  await phone.goto(`/phone.html?room=${room}`);

  await expect(phone.getByTestId('status')).toHaveText('Connected (relay)', { timeout: 10_000 });
  await expect(laptop.getByTestId('status')).toHaveText('Connected (relay)');
  const at = await laptop.evaluate(() => (window as unknown as { __statusAt: Record<string, number> }).__statusAt);
  expect(at.connected).toBeUndefined(); // it really was blocked
  expect(at.relay! - at.connecting!).toBeLessThan(6000);

  // The link overlay shows relay.
  const overlay = laptop.getByTestId('link-overlay');
  await expect(overlay).toContainText(/Phone\s+Connected \(relay\)/);
  await expect(overlay).toContainText(/Path\s+relay through the server/);

  // Control messages go through the relay too: the laptop's clock sync gets its answers, Zero reaches the
  // laptop, and a haptic reaches the Phone.
  await expect
    .poll(() => laptop.evaluate(() => (window as unknown as { __clockSync: { isSynced(): boolean } }).__clockSync.isSynced()), {
      timeout: 10_000,
    })
    .toBe(true);
  await laptop.evaluate(() => {
    const w = window as unknown as { __phoneLink: LinkHandle; __packets: MotionPacket[]; __zeros: number };
    w.__packets = [];
    w.__zeros = 0;
    w.__phoneLink.onPacket((p) => w.__packets.push(p));
    w.__phoneLink.onControl((m) => m.type === 'zero' && w.__zeros++);
  });
  await phone.evaluate(() => {
    const w = window as unknown as { __phoneLink: LinkHandle; __haptics: number };
    w.__haptics = 0;
    w.__phoneLink.onControl((m) => m.type === 'haptic' && w.__haptics++);
  });
  await phone.getByTestId('zero').click();
  await expect.poll(() => laptop.evaluate(() => (window as unknown as { __zeros: number }).__zeros)).toBe(1);
  await laptop.evaluate(() => (window as unknown as { __phoneLink: LinkHandle }).__phoneLink.sendControl({ type: 'haptic', ms: 30 }));
  await expect.poll(() => phone.evaluate(() => (window as unknown as { __haptics: number }).__haptics)).toBe(1);

  // Motion packets: synthetic sensor events through the real page at a Phone's 60 Hz for 2 s.
  await context.grantPermissions(['accelerometer', 'gyroscope']);
  await phone.bringToFront(); // a background tab's timers are throttled, which would slow the synthetic stream
  await phone.getByRole('button', { name: 'Tap to start' }).click();
  await expect(phone.getByTestId('rate')).toBeVisible();
  const N = 120;
  const MARK = 4242; // rotationRate beta: tells our events from any the browser fires itself
  await phone.evaluate(
    ({ n, mark }) =>
      new Promise<void>((done) => {
        let i = 0;
        const tick = setInterval(() => {
          window.dispatchEvent(
            new DeviceMotionEvent('devicemotion', {
              rotationRate: { alpha: i, beta: mark, gamma: 0 },
              accelerationIncludingGravity: { x: 0, y: 9.8, z: 0 },
            }),
          );
          if (++i >= n) {
            clearInterval(tick);
            done();
          }
        }, 1000 / 60);
      }),
    { n: N, mark: MARK },
  );
  const received = () =>
    laptop.evaluate((mark) => {
      const w = window as unknown as { __packets: MotionPacket[] };
      return new Set(w.__packets.filter((p) => p.rot[1] === mark).map((p) => p.rot[0])).size;
    }, MARK);
  // The relay may drop a few while a clock sync round shares the room's cap; most arrive.
  await expect.poll(received, { timeout: 5000 }).toBeGreaterThanOrEqual(N * 0.8);
  expect(await received()).toBeLessThanOrEqual(N);
  await expect(laptop.getByTestId('packets')).toHaveText(/\d+ Hz · \d+ motion packets/);
  await expect(overlay).toContainText(/Rate\s+[1-9]\d* Hz/);
});

test('the laptop shows Disconnected when the Phone page closes during relay', async ({ context }) => {
  await blockPeerToPeer(context);
  const laptop = await context.newPage();
  const phone = await context.newPage();
  const room = await openLaptop(laptop);
  await phone.goto(`/phone.html?room=${room}`);
  await expect(laptop.getByTestId('status')).toHaveText('Connected (relay)', { timeout: 10_000 });

  await phone.close();
  await expect(laptop.getByTestId('status')).toHaveText('Disconnected');
});
