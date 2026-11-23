import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { ServerMessage } from '../src/phone/signalProtocol.ts';
import { CLOSE_ROOM_EXPIRED, ROOM_IDLE_MS, createSignalServer, type SignalServer } from './signal.ts';

/** A test client that queues what the server sends, in order. */
interface Client {
  ws: WebSocket;
  send(m: unknown): void;
  next(): Promise<ServerMessage>;
  closed: Promise<number>;
}

let server: SignalServer;
let port: number;
let t: number;
const clients: Client[] = [];

function connect(path = '/'): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  const inbox: ServerMessage[] = [];
  const waiters: ((m: ServerMessage) => void)[] = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString()) as ServerMessage;
    const w = waiters.shift();
    if (w) w(m);
    else inbox.push(m);
  });
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  const client: Client = {
    ws,
    send: (m) => ws.send(typeof m === 'string' ? m : JSON.stringify(m)),
    next: () => {
      const m = inbox.shift();
      return m ? Promise.resolve(m) : new Promise((resolve) => waiters.push(resolve));
    },
    closed,
  };
  clients.push(client);
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(client));
    ws.once('error', reject);
  });
}

async function createRoom(): Promise<{ laptop: Client; room: string }> {
  const laptop = await connect();
  laptop.send({ type: 'create' });
  const m = await laptop.next();
  if (m.type !== 'created') throw new Error(`expected created, got ${m.type}`);
  return { laptop, room: m.room };
}

beforeEach(async () => {
  t = 1_000;
  server = createSignalServer({ now: () => t, autoSweep: false });
  port = await server.listen(0, '127.0.0.1');
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await server.close();
});

describe('signal server', () => {
  it('creates a room with a 5-character code, and a Phone joins it', async () => {
    const { laptop, room } = await createRoom();
    expect(room).toMatch(/^[2-9A-HJKMNP-Z]{5}$/);

    const phone = await connect('/signal');
    phone.send({ type: 'join', room });
    expect(await phone.next()).toEqual({ type: 'joined', room });
    expect(await laptop.next()).toEqual({ type: 'peer-joined' });
  });

  it('forwards signal data to the other peer only', async () => {
    const { laptop, room } = await createRoom();
    const phone = await connect();
    phone.send({ type: 'join', room });
    await phone.next();
    await laptop.next();

    laptop.send({ type: 'signal', data: { kind: 'offer', sdp: 'x' } });
    expect(await phone.next()).toEqual({ type: 'signal', data: { kind: 'offer', sdp: 'x' } });
    phone.send({ type: 'signal', data: { kind: 'answer', sdp: 'y' } });
    expect(await laptop.next()).toEqual({ type: 'signal', data: { kind: 'answer', sdp: 'y' } });
  });

  it('rejects a third peer', async () => {
    const { room } = await createRoom();
    const phone = await connect();
    phone.send({ type: 'join', room });
    await phone.next();

    const third = await connect();
    third.send({ type: 'join', room });
    expect(await third.next()).toEqual({ type: 'error', code: 'room-full' });
  });

  it('fails cleanly on a bad or unknown room code, and the socket stays usable', async () => {
    const phone = await connect();
    phone.send({ type: 'join', room: 'AB0' });
    expect(await phone.next()).toEqual({ type: 'error', code: 'bad-room' });
    phone.send({ type: 'join' });
    expect(await phone.next()).toEqual({ type: 'error', code: 'bad-room' });
    phone.send({ type: 'join', room: 'ZZZZZ' });
    expect(await phone.next()).toEqual({ type: 'error', code: 'no-room' });

    const { room } = await createRoom();
    phone.send({ type: 'join', room });
    expect(await phone.next()).toEqual({ type: 'joined', room });
  });

  it('answers garbage and out-of-room signals with an error', async () => {
    const c = await connect();
    c.send('not json');
    expect(await c.next()).toEqual({ type: 'error', code: 'bad-message' });
    c.send({ type: 'signal', data: 1 });
    expect(await c.next()).toEqual({ type: 'error', code: 'no-peer' });
    c.send({ type: 'create' });
    await c.next();
    c.send({ type: 'create' });
    expect(await c.next()).toEqual({ type: 'error', code: 'already-in-room' });
  });

  it('tells the remaining peer when the other leaves, and frees the slot', async () => {
    const { laptop, room } = await createRoom();
    const phone = await connect();
    phone.send({ type: 'join', room });
    await phone.next();
    await laptop.next();

    phone.ws.close();
    expect(await laptop.next()).toEqual({ type: 'peer-left' });
    const again = await connect();
    again.send({ type: 'join', room });
    expect(await again.next()).toEqual({ type: 'joined', room });
  });

  it('expires a room after 10 minutes idle, not before', async () => {
    const { laptop, room } = await createRoom();
    t += ROOM_IDLE_MS - 1;
    expect(server.sweep()).toBe(0);
    expect(server.roomCount()).toBe(1);

    t += 1;
    expect(server.sweep()).toBe(1);
    expect(server.roomCount()).toBe(0);
    expect(await laptop.closed).toBe(CLOSE_ROOM_EXPIRED);

    const phone = await connect();
    phone.send({ type: 'join', room });
    expect(await phone.next()).toEqual({ type: 'error', code: 'no-room' });
  });

  it('counts signaling as activity', async () => {
    const { laptop, room } = await createRoom();
    const phone = await connect();
    phone.send({ type: 'join', room });
    await phone.next();
    await laptop.next();

    t += ROOM_IDLE_MS - 1;
    laptop.send({ type: 'signal', data: 'ice' });
    await phone.next();
    t += ROOM_IDLE_MS - 1;
    expect(server.sweep()).toBe(0);
  });

  it('removes a room once everyone has left', async () => {
    const { laptop } = await createRoom();
    expect(server.roomCount()).toBe(1);
    laptop.ws.close();
    await laptop.closed;
    // The server sees the close on its own socket; poll briefly for it.
    for (let i = 0; i < 100 && server.roomCount() > 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(server.roomCount()).toBe(0);
  });

  it('answers GET /health with 200', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect((await fetch(`http://127.0.0.1:${port}/nope`)).status).toBe(404);
  });
});
