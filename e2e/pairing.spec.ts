import { expect, test, type Page } from '@playwright/test';
import type { ControlMessage, MotionPacket } from '../src/phone/types.ts';

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
  // The laptop's clock sync pings and the Phone's answers share the channel, so each side keeps only these:
  // haptics to the Phone, and pongs to the laptop marked by a negative t0 (no ping of the clock sync has one).
  const haptics: ControlMessage[] = Array.from({ length: 10 }, (_, i) => ({ type: 'haptic', ms: i }));
  const pongs: ControlMessage[] = Array.from({ length: 10 }, (_, i) => ({ type: 'pong', t0: -1 - i, t1: i + 0.5, t2: i + 0.75 }));
  await sendControl(laptop, haptics);
  await sendControl(phone, pongs);

  await expect.poll(async () => (await phoneGot()).filter((m) => m.type === 'haptic')).toEqual(haptics);
  await expect.poll(async () => (await laptopGot()).filter((m) => m.type === 'pong' && m.t0 < 0)).toEqual(pongs);
});

test("the Phone answers the laptop's clock sync, which finds the offset between the two pages' clocks", async ({ context }) => {
  const laptop = await context.newPage();
  const phone = await context.newPage();
  const room = await openLaptop(laptop);
  await phone.goto(`/phone.html?room=${room}`);
  await expect(laptop.getByTestId('status')).toHaveText('Connected');

  // Each page's performance.now() counts from its own time origin, so the Phone's clock minus the laptop's is
  // the laptop's origin minus the Phone's.
  const origin = (p: Page) => p.evaluate(() => performance.timeOrigin);
  const trueOffset = (await origin(laptop)) - (await origin(phone));
  const sync = () =>
    laptop.evaluate(() => {
      const s = (window as unknown as { __clockSync: { isSynced(): boolean; offsetMs(): number; rttMs(): number } }).__clockSync;
      return { synced: s.isSynced(), offset: s.offsetMs(), rtt: s.rttMs() };
    });
  await expect.poll(async () => (await sync()).synced, { timeout: 10_000 }).toBe(true);
  const { offset, rtt } = await sync();
  expect(Math.abs(offset - trueOffset)).toBeLessThan(5);
  expect(rtt).toBeGreaterThanOrEqual(0);

  // The link overlay shows the offset and round trip; L hides and shows it.
  const overlay = laptop.getByTestId('link-overlay');
  await expect(overlay).toContainText(/Offset\s+-?\d+\.\d ms/);
  await expect(overlay).toContainText(/Round trip\s+\d+\.\d ms/);
  await laptop.keyboard.press('l');
  await expect(overlay).toBeHidden();
  await laptop.keyboard.press('l');
  await expect(overlay).toBeVisible();
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

test('1,000 motion packets stream from the Phone page to the laptop with fewer than 1% lost', async ({ context }) => {
  const laptop = await context.newPage();
  const phone = await context.newPage();
  const room = await openLaptop(laptop);
  await phone.goto(`/phone.html?room=${room}`);
  await expect(phone.getByTestId('status')).toHaveText('Connected');
  await expect(laptop.getByTestId('status')).toHaveText('Connected');

  await laptop.evaluate(() => {
    const w = window as unknown as {
      __packets: MotionPacket[];
      __phoneLink: { onPacket(cb: (p: MotionPacket) => void): void };
    };
    w.__packets = [];
    w.__phoneLink.onPacket((p) => w.__packets.push(p));
  });

  // Chrome has `requestPermission` too; headless answers 'prompt' unless the sensors are granted.
  await context.grantPermissions(['accelerometer', 'gyroscope']);
  await phone.getByRole('button', { name: 'Tap to start' }).click();
  await expect(phone.getByTestId('rate')).toBeVisible();

  // Synthetic sensor events through the real page: sensors.ts builds each packet, link.ts sends it.
  // Paced like a fast Phone (2 every 5 ms), since a real one never sends 1,000 at once.
  const N = 1000;
  const MARK = 7777; // rotationRate beta: tells our events from any the browser fires itself
  await phone.evaluate(
    ({ n, mark }) =>
      new Promise<void>((done) => {
        window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 10, beta: -20, gamma: 30 }));
        let i = 0;
        const tick = setInterval(() => {
          for (let k = 0; k < 2 && i < n; k++, i++) {
            window.dispatchEvent(
              new DeviceMotionEvent('devicemotion', {
                rotationRate: { alpha: i, beta: mark, gamma: -i },
                accelerationIncludingGravity: { x: -1.5, y: 9.75, z: i / 4 },
              }),
            );
          }
          if (i >= n) {
            clearInterval(tick);
            done();
          }
        }, 5);
      }),
    { n: N, mark: MARK },
  );

  const received = () =>
    laptop.evaluate((mark) => {
      const w = window as unknown as { __packets: MotionPacket[] };
      return w.__packets.filter((p) => p.rot[1] === mark);
    }, MARK);
  // Wait for the stream to drain, then count what arrived.
  await expect.poll(async () => new Set((await received()).map((p) => p.rot[0])).size, { timeout: 10_000 }).toBeGreaterThanOrEqual(N * 0.99);
  const got = await received();
  const unique = new Set(got.map((p) => p.rot[0]));
  expect(unique.size).toBeGreaterThanOrEqual(N * 0.99);
  expect(unique.size).toBeLessThanOrEqual(N);

  // Packets carry the right fields: the event's values, the cached orientation, seq and Phone time.
  const first = got.find((p) => p.rot[0] === 1)!;
  expect(first.rot).toEqual([1, MARK, -1]);
  expect(first.acc).toEqual([-1.5, 9.75, 0.25]);
  expect(first.ori).toEqual([10, -20, 30]);
  expect(first.tPhone).toBeGreaterThan(0);
  const seqs = got.map((p) => p.seq);
  expect(new Set(seqs).size).toBe(seqs.length);

  // Both screens show the live numbers.
  await expect(laptop.getByTestId('packets')).toHaveText(/\d+ Hz · \d+ motion packets/);
  await expect(phone.getByTestId('rate')).toHaveText(/\d+ Hz/);
});

test('a denied motion prompt shows how to re-enable it, and Try again asks again', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __asks: number };
    w.__asks = 0;
    const deny = () => {
      w.__asks++;
      return Promise.resolve('denied');
    };
    Object.assign(DeviceMotionEvent, { requestPermission: deny });
    Object.assign(DeviceOrientationEvent, { requestPermission: deny });
  });
  await page.goto('/phone.html');
  await page.getByRole('button', { name: 'Tap to start' }).click();
  await expect(page.getByTestId('denied')).toBeVisible();
  await expect(page.getByTestId('denied')).toContainText('Motion access is blocked');
  await expect(page.getByTestId('rate')).toBeHidden();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __asks: number }).__asks)).toBe(4);
});
