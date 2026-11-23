/**
 * Signaling server (docs/specs/p3.md, P3-a; ADR 0004): pairs the laptop and
 * the Phone by room code and forwards their WebRTC offer, answer and ICE
 * candidates. Once paired, motion goes peer to peer and never passes here.
 * The protocol is in `src/phone/signalProtocol.ts`.
 *
 *   npm run signal                 # PORT (default 8787)
 *
 * In dev, Vite's `/signal` proxy forwards WebSocket upgrades here, so the
 * pages connect to `wss://<dev host>/signal`. Upgrades are accepted on any
 * path. `GET /health` answers 200 for the wake-up request and the host's
 * health check.
 *
 * Run by Node's built-in TypeScript support, outside the browser-typed `src/` build.
 */
import { randomInt } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  isRoomCode,
  makeRoomCode,
  parseClientMessage,
  type ServerMessage,
} from '../src/phone/signalProtocol.ts';

/** A room with no messages for this long is closed. */
export const ROOM_IDLE_MS = 10 * 60 * 1000;
export const MAX_PEERS = 2;
/** How often expired rooms are swept. */
const SWEEP_MS = 30 * 1000;
/** Signaling messages are small; anything bigger is a mistake or abuse. */
const MAX_PAYLOAD_BYTES = 64 * 1024;
/** WebSocket close code sent to peers of an expired room. */
export const CLOSE_ROOM_EXPIRED = 4000;

export interface SignalServerOptions {
  /** ms; injectable so expiry is testable. */
  now?: () => number;
  idleMs?: number;
  /** Integer in [0, n); crypto by default, so room codes can't be guessed. */
  randomInt?: (n: number) => number;
  /** Sweep expired rooms on a timer. Tests turn it off and call `sweep()`. */
  autoSweep?: boolean;
}

export interface SignalServer {
  http: Server;
  listen(port: number, host?: string): Promise<number>;
  /** Close rooms idle for `idleMs` or longer; returns how many closed. */
  sweep(): number;
  roomCount(): number;
  close(): Promise<void>;
}

interface Room {
  code: string;
  peers: Set<WebSocket>;
  lastActive: number;
}

export function createSignalServer(opts: SignalServerOptions = {}): SignalServer {
  const now = opts.now ?? (() => Date.now());
  const idleMs = opts.idleMs ?? ROOM_IDLE_MS;
  const rand = opts.randomInt ?? ((n: number) => randomInt(n));
  const rooms = new Map<string, Room>();
  const roomOf = new Map<WebSocket, Room>();

  const http = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && (path === '/health' || path === '/signal/health')) {
      // Any origin: the deployed game's wake-up request is cross-origin.
      res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
      res.end('ok');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  const wss = new WebSocketServer({ server: http, maxPayload: MAX_PAYLOAD_BYTES });

  const send = (ws: WebSocket, m: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
  };

  const newCode = () => {
    for (;;) {
      const code = makeRoomCode(rand);
      if (!rooms.has(code)) return code;
    }
  };

  const leave = (ws: WebSocket) => {
    const room = roomOf.get(ws);
    if (!room) return;
    roomOf.delete(ws);
    room.peers.delete(ws);
    room.lastActive = now();
    if (room.peers.size === 0) rooms.delete(room.code);
    else for (const p of room.peers) send(p, { type: 'peer-left' });
  };

  wss.on('connection', (ws) => {
    ws.on('message', (raw, isBinary) => {
      const m = isBinary ? null : parseClientMessage(raw.toString());
      if (!m) return send(ws, { type: 'error', code: 'bad-message' });
      const current = roomOf.get(ws);
      switch (m.type) {
        case 'create': {
          if (current) return send(ws, { type: 'error', code: 'already-in-room' });
          const room: Room = { code: newCode(), peers: new Set([ws]), lastActive: now() };
          rooms.set(room.code, room);
          roomOf.set(ws, room);
          return send(ws, { type: 'created', room: room.code });
        }
        case 'join': {
          if (current) return send(ws, { type: 'error', code: 'already-in-room' });
          if (!isRoomCode(m.room)) return send(ws, { type: 'error', code: 'bad-room' });
          const room = rooms.get(m.room);
          if (!room) return send(ws, { type: 'error', code: 'no-room' });
          if (room.peers.size >= MAX_PEERS) return send(ws, { type: 'error', code: 'room-full' });
          for (const p of room.peers) send(p, { type: 'peer-joined' });
          room.peers.add(ws);
          roomOf.set(ws, room);
          room.lastActive = now();
          return send(ws, { type: 'joined', room: room.code });
        }
        case 'signal': {
          const others = current ? [...current.peers].filter((p) => p !== ws) : [];
          if (!current || others.length === 0) return send(ws, { type: 'error', code: 'no-peer' });
          current.lastActive = now();
          for (const p of others) send(p, { type: 'signal', data: m.data });
          return;
        }
      }
    });
    ws.on('close', () => leave(ws));
    ws.on('error', () => leave(ws));
  });

  const sweep = () => {
    const t = now();
    let closed = 0;
    for (const room of [...rooms.values()]) {
      if (t - room.lastActive < idleMs) continue;
      rooms.delete(room.code);
      for (const p of room.peers) {
        roomOf.delete(p);
        p.close(CLOSE_ROOM_EXPIRED, 'room expired');
      }
      closed++;
    }
    return closed;
  };

  const timer = opts.autoSweep === false ? null : setInterval(sweep, SWEEP_MS);
  timer?.unref();

  return {
    http,
    listen: (port, host) =>
      new Promise((resolve, reject) => {
        http.once('error', reject);
        http.listen(port, host, () => resolve((http.address() as AddressInfo).port));
      }),
    sweep,
    roomCount: () => rooms.size,
    close: () =>
      new Promise((resolve) => {
        if (timer) clearInterval(timer);
        for (const ws of wss.clients) ws.terminate();
        wss.close();
        http.close(() => resolve());
      }),
  };
}

// `npm run signal`: run it when executed directly, not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8787);
  const server = createSignalServer();
  const bound = await server.listen(port);
  console.log(`signal: listening on :${bound} (GET /health)`);
  const stop = () => {
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
