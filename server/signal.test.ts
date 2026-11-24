import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { PACKET_BYTES } from '../src/phone/packet.ts';
import { RELAY_MAX_PER_S, RELAY_MOTION_MAX_PER_S, type ServerMessage } from '../src/phone/signalProtocol.ts';
import { CLOSE_ROOM_EXPIRED, ROOM_IDLE_MS, admitRelay, createSignalServer, newRelayWindow, type SignalServer } from './signal.ts';

/** A test client that queues what the server sends, in order. */
interface Client {
  ws: WebSocket;
  send(m: unknown): void;
  next(): Promise<ServerMessage>;
  /** Binary frames received (relayed motion packets), in order. */
  frames: Buffer[];
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
  const frames: Buffer[] = [];
  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      frames.push(raw as Buffer);
      return;
    }
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
    frames,
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

/** A laptop and a Phone paired in one room, with the join notices read. */
async function pair(): Promise<{ laptop: Client; phone: Client; room: string }> {
  const { laptop, room } = await createRoom();
  const phone = await connect();
  phone.send({ type: 'join', room });
  await phone.next();
  await laptop.next();
  return { laptop, phone, room };
}

/** A 48-byte motion packet whose first 4 bytes are `n`. */
function packet(n: number): Buffer {
  const b = Buffer.alloc(PACKET_BYTES);
  b.writeUInt32LE(n, 0);
  return b;
}

/**
 * Wait until `to` has seen everything `from` sent so far: messages from one
 * socket are handled in order, so once a `signal` sent after them arrives,
 * each earlier one has been forwarded or dropped.
 */
async function fence(from: Client, to: Client, tag: string): Promise<ServerMessage[]> {
  from.send({ type: 'signal', data: tag });
  const got: ServerMessage[] = [];
  for (;;) {
    const m = await to.next();
    if (m.type === 'signal' && m.data === tag) return got;
    got.push(m);
  }
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

  it('relays motion packets as binary frames and control messages both ways, unchanged', async () => {
    const { laptop, phone } = await pair();
    phone.ws.send(packet(7));
    phone.send({ type: 'relay', data: { type: 'zero' } });
    expect(await fence(phone, laptop, 'f1')).toEqual([{ type: 'relay', data: { type: 'zero' } }]);
    expect(laptop.frames).toEqual([packet(7)]);

    laptop.send({ type: 'relay', data: { type: 'haptic', ms: 30 } });
    expect(await fence(laptop, phone, 'f2')).toEqual([{ type: 'relay', data: { type: 'haptic', ms: 30 } }]);
  });

  it('drops relay traffic above 120 messages per second per room, and never sends it later', async () => {
    const { laptop, phone } = await pair();
    const other = await pair();

    // All at one instant: 150 motion packets, then 30 control messages, then one from the laptop.
    for (let i = 0; i < 150; i++) phone.ws.send(packet(i));
    for (let i = 0; i < 30; i++) phone.send({ type: 'relay', data: { type: 'pong', t0: i, t1: 0, t2: 0 } });
    const control = await fence(phone, laptop, 'f1');
    expect(laptop.frames).toHaveLength(RELAY_MOTION_MAX_PER_S);
    expect(laptop.frames.map((b) => b.readUInt32LE(0))).toEqual([...Array(RELAY_MOTION_MAX_PER_S).keys()]);
    // Control messages fill the rest of the 120, however much motion came first.
    expect(control).toHaveLength(RELAY_MAX_PER_S - RELAY_MOTION_MAX_PER_S);
    laptop.send({ type: 'relay', data: { type: 'haptic', ms: 30 } });
    expect(await fence(laptop, phone, 'f2')).toEqual([]);

    // Another room has its own cap.
    other.phone.ws.send(packet(1));
    await fence(other.phone, other.laptop, 'f3');
    expect(other.laptop.frames).toHaveLength(1);

    // Still within the second: dropped.
    t += 999;
    phone.ws.send(packet(1000));
    await fence(phone, laptop, 'f4');
    expect(laptop.frames).toHaveLength(RELAY_MOTION_MAX_PER_S);

    // A second later traffic flows again, and only the new packets arrive: nothing was queued.
    t += 1;
    for (let i = 2000; i < 2005; i++) phone.ws.send(packet(i));
    await fence(phone, laptop, 'f5');
    expect(laptop.frames.slice(RELAY_MOTION_MAX_PER_S).map((b) => b.readUInt32LE(0))).toEqual([2000, 2001, 2002, 2003, 2004]);
  });

  it('lets 120 control messages a second through when no motion is relayed', async () => {
    const { laptop, phone } = await pair();
    for (let i = 0; i < RELAY_MAX_PER_S + 10; i++) phone.send({ type: 'relay', data: { type: 'pong', t0: i, t1: 0, t2: 0 } });
    expect(await fence(phone, laptop, 'f')).toHaveLength(RELAY_MAX_PER_S);
  });

  it('drops relay traffic silently with nobody else in the room, and answers a wrong-sized frame with an error', async () => {
    const { laptop } = await createRoom();
    laptop.ws.send(packet(1));
    laptop.send({ type: 'relay', data: { type: 'ping', t0: 1 } });
    laptop.ws.send(Buffer.alloc(PACKET_BYTES + 1));
    expect(await laptop.next()).toEqual({ type: 'error', code: 'bad-message' });
  });

  it('counts relay traffic and keepalives as activity', async () => {
    const { laptop, phone } = await pair();
    t += ROOM_IDLE_MS - 1;
    phone.ws.send(packet(1));
    await fence(phone, laptop, 'f1');
    t += ROOM_IDLE_MS - 1;
    laptop.send({ type: 'keepalive' });
    await fence(laptop, phone, 'f2');
    t += ROOM_IDLE_MS - 1;
    expect(server.sweep()).toBe(0);
  });

  it('answers GET /health with 200', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect((await fetch(`http://127.0.0.1:${port}/nope`)).status).toBe(404);
  });
});

describe('admitRelay', () => {
  it('counts a sliding second: a message leaves the window exactly 1 s after it came', () => {
    const w = newRelayWindow();
    for (let i = 0; i < RELAY_MAX_PER_S; i++) expect(admitRelay(w, false, i)).toBe(true);
    expect(admitRelay(w, false, 999)).toBe(false);
    expect(admitRelay(w, false, 1000)).toBe(true); // the one at 0 has left
    expect(admitRelay(w, false, 1000)).toBe(false);
  });

  it('keeps room for control when motion is at its share', () => {
    const w = newRelayWindow();
    for (let i = 0; i < RELAY_MOTION_MAX_PER_S; i++) expect(admitRelay(w, true, 0)).toBe(true);
    expect(admitRelay(w, true, 0)).toBe(false);
    expect(admitRelay(w, false, 0)).toBe(true);
  });
});
