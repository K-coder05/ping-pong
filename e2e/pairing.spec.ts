import { expect, test, type Page } from '@playwright/test';
import type { ControlMessage } from '../src/phone/types.ts';

/** Pairing through the signaling server (docs/specs/p3.md, P3-a; #37). */

const ROOM = /^[2-9A-HJKMNP-Z]{5}$/;

async function openLaptop(page: Page): Promise<string> {
  await page.goto('/pairing.html');
  const roomEl = page.getByTestId('room-code');
  await expect(roomEl).toHaveText(ROOM);
  const room = (await roomEl.textContent())!;
  await expect(page.getByTestId('status')).toHaveText('Waiting for Phone');
  await expect(page.getByTestId('phone-url')).toHaveText(new RegExp(`/phone\\.html\\?room=${room}$`));
  // The QR code is drawn: the canvas has dark modules.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const c = document.querySelector<HTMLCanvasElement>('.pairing canvas')!;
        const px = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
        let dark = 0;
        for (let i = 0; i < px.length; i += 4) if (px[i]! < 64 && px[i + 3]! > 0) dark++;
        return dark;
      }),
    )
    .toBeGreaterThan(1000);
  return room;
}

/** Collect the control messages a page's link receives, in order. */
async function collectControl(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __got: unknown[]; __phoneLink: { onControl(cb: (m: unknown) => void): void } };
    w.__got = [];
    w.__phoneLink.onControl((m) => w.__got.push(m));
  });
  return () => page.evaluate(() => (window as unknown as { __got: ControlMessage[] }).__got);
}

function sendControl(page: Page, msgs: ControlMessage[]) {
  return page.evaluate((list) => {
    const link = (window as unknown as { __phoneLink: { sendControl(m: unknown): void } }).__phoneLink;
    for (const m of list) link.sendControl(m);
  }, msgs);
}

test('a Phone pairs from the QR link and 10 control messages pass each way, none lost', async ({ context }) => {
  const laptop = await context.newPage();
  const phone = await context.newPage();
  const room = await openLaptop(laptop);

  await phone.goto(`/phone.html?room=${room}`);
  await expect(phone.getByTestId('status')).toHaveText('Connected');
  await expect(laptop.getByTestId('status')).toHaveText('Connected');

  const laptopGot = await collectControl(laptop);
  const phoneGot = await collectControl(phone);
  const pings: ControlMessage[] = Array.from({ length: 10 }, (_, i) => ({ type: 'ping', t0: i }));
  const pongs: ControlMessage[] = Array.from({ length: 10 }, (_, i) => ({ type: 'pong', t0: i, t1: i + 0.5, t2: i + 0.75 }));
  await sendControl(laptop, pings);
  await sendControl(phone, pongs);

  await expect.poll(phoneGot).toEqual(pings);
  await expect.poll(laptopGot).toEqual(pongs);
});

test('a Phone pairs by typing the room code', async ({ context }) => {
  const laptop = await context.newPage();
  const phone = await context.newPage();
  const room = await openLaptop(laptop);

  await phone.goto('/phone.html');
  await phone.getByLabel('Room code').fill(room.toLowerCase());
  await phone.getByRole('button', { name: 'Join' }).click();
  await expect(phone.getByTestId('status')).toHaveText('Connected');
  await expect(laptop.getByTestId('status')).toHaveText('Connected');
});

test('an unknown room code fails cleanly and the box comes back', async ({ page }) => {
  await page.goto('/phone.html?room=ZZZZZ');
  await expect(page.getByTestId('error')).toHaveText(/No room with that code/);
  await expect(page.getByTestId('status')).toHaveText('Disconnected');
  await expect(page.getByLabel('Room code')).toBeVisible();
});

test('the laptop shows Disconnected when the Phone page closes', async ({ context }) => {
  const laptop = await context.newPage();
  const phone = await context.newPage();
  const room = await openLaptop(laptop);
  await phone.goto(`/phone.html?room=${room}`);
  await expect(laptop.getByTestId('status')).toHaveText('Connected');

  await phone.close();
  await expect(laptop.getByTestId('status')).toHaveText('Disconnected');
});
