import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/** The Phone page coming back to its room (docs/specs/p3.md, P3-e §2; #45). */

const ROOM = /^[2-9A-HJKMNP-Z]{5}$/;

async function openLaptop(page: Page): Promise<string> {
  await page.goto('/pairing.html');
  const roomEl = page.getByTestId('room-code');
  await expect(roomEl).toHaveText(ROOM);
  await expect(page.getByTestId('status')).toHaveText('Waiting for Phone');
  return (await roomEl.textContent())!;
}

/** The Phone's clock minus the laptop's, from the two pages' time origins. */
async function trueOffset(laptop: Page, phone: Page): Promise<number> {
  const origin = (p: Page) => p.evaluate(() => performance.timeOrigin);
  return (await origin(laptop)) - (await origin(phone));
}

function clockOffset(laptop: Page): Promise<number> {
  return laptop.evaluate(() => (window as unknown as { __clockSync: { offsetMs(): number } }).__clockSync.offsetMs());
}

/** Make the page look hidden or shown, as when the Phone locks and unlocks. */
function setVisibility(page: Page, state: 'hidden' | 'visible') {
  return page.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => s === 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

test('closing and reopening the Phone page restores the connection with the same room code, and the clock re-syncs', async ({ context }) => {
  const laptop = await context.newPage();
  const room = await openLaptop(laptop);
  const phone = await context.newPage();
  await phone.goto(`/phone.html?room=${room}`);
  await expect(laptop.getByTestId('status')).toHaveText('Connected');
  await expect.poll(async () => Math.abs((await clockOffset(laptop)) - (await trueOffset(laptop, phone))), { timeout: 10_000 }).toBeLessThan(5);

  await phone.close();
  await expect(laptop.getByTestId('status')).toHaveText('Disconnected');

  // Reopened from its link (history, or the QR code again): the same room, and a Phone clock that starts over.
  const again = await context.newPage();
  await again.goto(`/phone.html?room=${room}`);
  await expect(again.getByTestId('room-code')).toHaveText(room);
  await expect(again.getByTestId('status')).toHaveText('Connected');
  await expect(laptop.getByTestId('status')).toHaveText('Connected');
  await expect(laptop.getByTestId('room-code')).toHaveText(room);
  const offset = await trueOffset(laptop, again);
  await expect.poll(async () => Math.abs((await clockOffset(laptop)) - offset), { timeout: 3000 }).toBeLessThan(5);
});

test('a Phone that joined by typing the code rejoins the same room after a reload', async ({ context }) => {
  const laptop = await context.newPage();
  const room = await openLaptop(laptop);
  const phone = await context.newPage();
  await phone.goto('/phone.html');
  await phone.getByLabel('Room code').fill(room);
  await phone.getByRole('button', { name: 'Join' }).click();
  await expect(phone.getByTestId('status')).toHaveText('Connected');
  expect(new URL(phone.url()).searchParams.get('room')).toBe(room);

  await phone.reload();
  await expect(phone.getByTestId('room-code')).toHaveText(room);
  await expect(phone.getByTestId('status')).toHaveText('Connected');
  await expect(laptop.getByTestId('status')).toHaveText('Connected');
});

test('a Phone page that hides leaves the room at once, and rejoins it when shown again', async ({ context }) => {
  const laptop = await context.newPage();
  const room = await openLaptop(laptop);
  const phone = await context.newPage();
  await phone.goto(`/phone.html?room=${room}`);
  await expect(laptop.getByTestId('status')).toHaveText('Connected');

  await setVisibility(phone, 'hidden'); // the Phone locks
  await expect(laptop.getByTestId('status')).toHaveText('Disconnected');
  await expect(phone.getByTestId('status')).toHaveText('Disconnected');
  await phone.waitForTimeout(1500);
  await expect(phone.getByTestId('status')).toHaveText('Disconnected'); // no rejoin while hidden

  await setVisibility(phone, 'visible'); // and unlocks
  await expect(phone.getByTestId('status')).toHaveText('Connected');
  await expect(laptop.getByTestId('status')).toHaveText('Connected');
  await expect(phone.getByTestId('room-code')).toHaveText(room);
});

test('a Phone page whose link drops while showing rejoins the same room by itself', async ({ context }) => {
  const laptop = await context.newPage();
  const room = await openLaptop(laptop);
  const phone = await context.newPage();
  await phone.goto(`/phone.html?room=${room}`);
  await expect(laptop.getByTestId('status')).toHaveText('Connected');

  // The connection goes away under the page (e.g. Wi-Fi dropped), the page itself stays.
  await phone.evaluate(() => (window as unknown as { __phoneLink: { close(): void } }).__phoneLink.close());
  await expect(laptop.getByTestId('status')).toHaveText('Disconnected');
  await expect(phone.getByTestId('status')).toHaveText('Connected', { timeout: 10_000 });
  await expect(laptop.getByTestId('status')).toHaveText('Connected');
});

/** As in `relay.spec.ts`: no peer-to-peer path, so the pages relay through the server. */
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

test('in relay, a reopened Phone page goes straight back to relay in the same room', async ({ context }) => {
  await blockPeerToPeer(context);
  const laptop = await context.newPage();
  const room = await openLaptop(laptop);
  const phone = await context.newPage();
  await phone.goto(`/phone.html?room=${room}`);
  await expect(laptop.getByTestId('status')).toHaveText('Connected (relay)', { timeout: 10_000 });

  await phone.close();
  await expect(laptop.getByTestId('status')).toHaveText('Disconnected');
  const again = await context.newPage();
  const t0 = Date.now();
  await again.goto(`/phone.html?room=${room}`);
  await expect(again.getByTestId('status')).toHaveText('Connected (relay)');
  await expect(laptop.getByTestId('status')).toHaveText('Connected (relay)');
  expect(Date.now() - t0).toBeLessThan(4000); // no second 5 s wait for peer to peer
  await expect
    .poll(() => laptop.evaluate(() => (window as unknown as { __clockSync: { isSynced(): boolean } }).__clockSync.isSynced()), {
      timeout: 10_000,
    })
    .toBe(true);
});
