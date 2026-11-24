/**
 * The WebRTC PhoneLink (docs/specs/p3.md, P3-a), used by both pages: the
 * laptop creates a room on the signaling server and makes the offer when the
 * Phone joins; the Phone joins by room code and answers. After that the two
 * talk directly over two data channels:
 *
 * - `motion`: unordered, no retransmits, one binary `encodePacket` per message.
 *   A late packet is useless, so never wait for it; packets sent before the
 *   channel opens are dropped.
 * - `control`: reliable and ordered, JSON `ControlMessage`s.
 *
 * Relay (P3-e §1, ADR 0004): if the channels aren't open 5 s after signaling
 * with the other page starts, or they close and don't reopen within 3 s
 * (`fallback.ts`), the link gives up on peer to peer for this pairing. It
 * tells the other page (a `signal` with `{ kind: 'relay' }`), both show
 * `relay`, and everything goes through the signaling socket instead: motion
 * packets as binary frames, paced to `RELAY_MOTION_HZ`, and control messages
 * (clock sync pings and pongs, `zero`, `haptic`) wrapped in `relay`. The
 * server caps relay traffic per room and drops the excess, so in relay a
 * control message can be lost: ClockSync pings again after a second, and the
 * player taps Zero again. When the channels close, the laptop makes one fresh
 * offer straight away, so a short drop can reopen within the 3 s.
 *
 * The signaling socket stays open for the whole pairing, with a keepalive so
 * the room doesn't expire while the Phone plays peer to peer; that keeps
 * relay possible later. Only in relay does losing the socket disconnect.
 *
 * A thin wrapper over `WebSocket` and `RTCPeerConnection`; checked end to end
 * by `e2e/pairing.spec.ts` and `e2e/relay.spec.ts`. ICE servers default to
 * none: on the same network host candidates are enough, and there is no TURN
 * (ADR 0004).
 */
import type { Schedule } from './clock.ts';
import { RELAY_MOTION_HZ, createFallback, createRelayPacer } from './fallback.ts';
import { PACKET_BYTES, decodePacket, encodePacket } from './packet.ts';
import type { SignalErrorCode, ServerMessage } from './signalProtocol.ts';
import type { ControlMessage, LinkStatus, MotionPacket, PhoneLink } from './types.ts';

export interface LinkOptions {
  /** The signaling server's WebSocket URL, e.g. from `devSignalUrl(location)`. */
  signalUrl: string;
  /** Default none. */
  iceServers?: RTCIceServer[];
  /** ms, stamps `tRecv`; default `performance.now`. */
  now?: () => number;
}

/** Why pairing failed: the server's error code, or the signaling socket closed. */
export type LinkError = SignalErrorCode | 'socket-closed';

export interface SignalingLink extends PhoneLink {
  /** The room code: the new room (laptop) or the one joined (Phone). Rejects with a `LinkError` message if pairing fails first. */
  readonly room: Promise<string>;
  onError(cb: (e: LinkError) => void): () => void;
}

/** In dev the signaling server sits behind Vite's `/signal` proxy on the page's own host. */
export function devSignalUrl(loc: { protocol: string; host: string }): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/signal`;
}

/** What each page shows for a status. */
export function statusLabel(s: LinkStatus): string {
  switch (s) {
    case 'idle':
      return 'Starting…';
    case 'waiting':
      return 'Waiting for Phone';
    case 'connecting':
      return 'Connecting…';
    case 'connected':
      return 'Connected';
    case 'relay':
      return 'Connected (relay)';
    case 'disconnected':
      return 'Disconnected';
  }
}

/** Laptop side: create a room, then connect to the Phone that joins it. */
export function openLaptopLink(opts: LinkOptions): SignalingLink {
  return openLink(null, opts);
}

/** Phone side: join the laptop's room by code. */
export function openPhoneLink(room: string, opts: LinkOptions): SignalingLink {
  return openLink(room, opts);
}

type SignalData =
  | { kind: 'description'; description: RTCSessionDescriptionInit }
  | { kind: 'candidate'; candidate: RTCIceCandidateInit }
  /** The sender switched to relay; the receiver follows. */
  | { kind: 'relay' };

/** ms between keepalives while paired: well inside the server's 10-minute room expiry and common proxy idle timeouts. */
const KEEPALIVE_MS = 30_000;
/** In relay, a socket this far behind on sending gets no more motion packets until it catches up: a late packet is useless. */
const RELAY_MAX_BUFFERED_BYTES = 4 * 1024;

const realSchedule: Schedule = (fn, ms) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

function openLink(joinRoom: string | null, opts: LinkOptions): SignalingLink {
  const isLaptop = joinRoom === null;
  const now = opts.now ?? (() => performance.now());
  const statusCbs = new Set<(s: LinkStatus) => void>();
  const controlCbs = new Set<(m: ControlMessage, tRecv: number) => void>();
  const packetCbs = new Set<(p: MotionPacket, tRecv: number) => void>();
  const errorCbs = new Set<(e: LinkError) => void>();

  let status: LinkStatus = 'idle';
  let roomKnown = false;
  let closed = false;
  let pc: RTCPeerConnection | null = null;
  let control: RTCDataChannel | null = null;
  let motion: RTCDataChannel | null = null;
  let pendingCandidates: RTCIceCandidateInit[] = [];
  /** Signal messages are handled one at a time, in order. */
  let signalChain = Promise.resolve();
  /** The other page is in the room. */
  let peerPresent = false;
  /** Peer to peer gave up for this pairing; everything goes through the socket. */
  let relaying = false;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  const pacer = createRelayPacer(RELAY_MOTION_HZ);

  let resolveRoom!: (code: string) => void;
  let rejectRoom!: (e: Error) => void;
  const room = new Promise<string>((res, rej) => {
    resolveRoom = res;
    rejectRoom = rej;
  });
  room.catch(() => {}); // callers that never await `room` still hear about failures via onError

  const setStatus = (s: LinkStatus) => {
    if (s === status) return;
    status = s;
    for (const cb of statusCbs) cb(s);
  };

  let failed = false;
  const fail = (e: LinkError) => {
    failed = true;
    for (const cb of errorCbs) cb(e);
    if (!roomKnown) rejectRoom(new Error(e));
  };

  const ws = new WebSocket(opts.signalUrl);
  ws.binaryType = 'arraybuffer';
  const sendSignal = (data: SignalData) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'signal', data }));
  };

  const startKeepalive = () => {
    keepalive ??= setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'keepalive' }));
    }, KEEPALIVE_MS);
  };
  const stopKeepalive = () => {
    if (keepalive !== null) clearInterval(keepalive);
    keepalive = null;
  };

  const teardownPeer = () => {
    const old = pc;
    pc = null;
    control = null;
    motion = null;
    pendingCandidates = [];
    old?.close();
  };

  /** Give up on peer to peer for this pairing. `tell`: this page decided, so the other page must follow. */
  const startRelay = (tell: boolean) => {
    if (relaying || closed || !peerPresent) return;
    relaying = true;
    fallback.cancel();
    teardownPeer();
    if (tell) sendSignal({ kind: 'relay' });
    setStatus('relay');
  };

  const fallback = createFallback({ now, schedule: realSchedule }, () => startRelay(true));

  /** The peer connection or one of its channels went away. */
  const lost = (from: RTCPeerConnection) => {
    if (from !== pc || closed) return;
    const wasOpen = fallback.state() === 'open';
    teardownPeer();
    if (!peerPresent || ws.readyState !== WebSocket.OPEN) {
      fallback.cancel();
      setStatus('disconnected');
      return;
    }
    // The other page is still there: the fallback's clock runs, and the laptop tries once more straight away.
    fallback.closed();
    setStatus('connecting');
    if (isLaptop && wasOpen) signalChain = signalChain.then(offer).catch(warn);
  };

  const checkOpen = (from: RTCPeerConnection) => {
    if (from === pc && control?.readyState === 'open' && motion?.readyState === 'open') {
      fallback.opened();
      setStatus('connected');
    }
  };

  const attach = (from: RTCPeerConnection, ch: RTCDataChannel) => {
    if (ch.label === 'control') {
      control = ch;
      ch.onmessage = (e) => {
        const tRecv = now();
        const m = parseControl(e.data);
        if (m) for (const cb of controlCbs) cb(m, tRecv);
      };
    } else if (ch.label === 'motion') {
      motion = ch;
      ch.binaryType = 'arraybuffer';
      ch.onmessage = (e) => {
        const tRecv = now();
        if (!(e.data instanceof ArrayBuffer) || e.data.byteLength !== PACKET_BYTES) return;
        const p = decodePacket(e.data);
        for (const cb of packetCbs) cb(p, tRecv);
      };
    } else return;
    ch.onopen = () => checkOpen(from);
    ch.onclose = () => lost(from);
    checkOpen(from);
  };

  const newPeer = () => {
    teardownPeer();
    const p = new RTCPeerConnection({ iceServers: opts.iceServers ?? [] });
    pc = p;
    p.onicecandidate = (e) => {
      if (e.candidate && p === pc) sendSignal({ kind: 'candidate', candidate: e.candidate.toJSON() });
    };
    p.onconnectionstatechange = () => {
      if (p.connectionState === 'failed' || p.connectionState === 'closed') lost(p);
    };
    p.ondatachannel = (e) => attach(p, e.channel);
    return p;
  };

  /** Laptop: the Phone joined (or the channels closed); make the channels and the offer. */
  const offer = async () => {
    if (!peerPresent || relaying || closed) return;
    const p = newPeer();
    attach(p, p.createDataChannel('control'));
    attach(p, p.createDataChannel('motion', { ordered: false, maxRetransmits: 0 }));
    setStatus('connecting');
    await p.setLocalDescription(await p.createOffer());
    if (p === pc && p.localDescription) sendSignal({ kind: 'description', description: p.localDescription.toJSON() });
  };

  const onSignal = async (data: SignalData) => {
    if (data.kind === 'relay') return startRelay(false);
    if (relaying) return; // late offers, answers and candidates for a connection given up on
    if (data.kind === 'description') {
      // The Phone answers each offer with a fresh connection; the laptop takes the answer.
      const p = !isLaptop && data.description.type === 'offer' ? newPeer() : pc;
      if (!p) return;
      await p.setRemoteDescription(data.description);
      for (const c of pendingCandidates.splice(0)) await p.addIceCandidate(c);
      if (data.description.type === 'offer') {
        await p.setLocalDescription(await p.createAnswer());
        if (p === pc && p.localDescription) sendSignal({ kind: 'description', description: p.localDescription.toJSON() });
      }
    } else if (data.kind === 'candidate') {
      if (pc?.remoteDescription) await pc.addIceCandidate(data.candidate);
      else pendingCandidates.push(data.candidate);
    }
  };

  /** The other page is in the room: signaling starts, and with it the 5 s rule. */
  const peerArrived = () => {
    peerPresent = true;
    relaying = false;
    fallback.started();
    startKeepalive();
  };

  ws.onopen = () => {
    ws.send(JSON.stringify(isLaptop ? { type: 'create' } : { type: 'join', room: joinRoom }));
  };
  ws.onmessage = (e) => {
    if (closed) return;
    if (e.data instanceof ArrayBuffer) {
      // Relay: a motion packet through the server.
      const tRecv = now();
      if (e.data.byteLength !== PACKET_BYTES) return;
      const p = decodePacket(e.data);
      for (const cb of packetCbs) cb(p, tRecv);
      return;
    }
    if (typeof e.data !== 'string') return;
    const m = JSON.parse(e.data) as ServerMessage;
    switch (m.type) {
      case 'created':
        roomKnown = true;
        resolveRoom(m.room);
        setStatus('waiting');
        return;
      case 'joined':
        roomKnown = true;
        resolveRoom(m.room);
        peerArrived();
        setStatus('connecting');
        return;
      case 'peer-joined':
        peerArrived();
        if (isLaptop) signalChain = signalChain.then(offer).catch(warn);
        return;
      case 'peer-left':
        peerPresent = false;
        relaying = false;
        fallback.cancel();
        stopKeepalive();
        teardownPeer();
        setStatus('disconnected');
        return;
      case 'signal':
        signalChain = signalChain.then(() => onSignal(m.data as SignalData)).catch(warn);
        return;
      case 'relay': {
        // Relay: a control message through the server.
        const tRecv = now();
        const c = asControl(m.data);
        if (c) for (const cb of controlCbs) cb(c, tRecv);
        return;
      }
      case 'error':
        // A message that raced the other page leaving; `peer-left` follows.
        if (roomKnown && m.code === 'no-peer') return;
        if (!roomKnown) {
          ws.close();
          setStatus('disconnected');
        }
        fail(m.code);
        return;
    }
  };
  ws.onclose = () => {
    if (closed) return;
    stopKeepalive();
    fallback.cancel();
    // Once connected peer to peer, the pages no longer need the server (but can't fall back to relay now).
    if (status !== 'connected') {
      relaying = false;
      teardownPeer();
      setStatus('disconnected');
    }
    if (!roomKnown && !failed) fail('socket-closed');
  };

  return {
    room,
    status: () => status,
    onStatus: (cb) => subscribe(statusCbs, cb),
    onPacket: (cb) => subscribe(packetCbs, cb),
    onControl: (cb) => subscribe(controlCbs, cb),
    onError: (cb) => subscribe(errorCbs, cb),
    sendPacket: (p) => {
      // Not open yet (or gone, or behind): drop it. A late packet is useless.
      if (relaying) {
        if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount <= RELAY_MAX_BUFFERED_BYTES && pacer.allow(now())) {
          ws.send(encodePacket(p));
        }
      } else if (motion?.readyState === 'open') motion.send(encodePacket(p));
    },
    sendControl: (m) => {
      if (relaying) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'relay', data: m }));
      } else if (control?.readyState === 'open') control.send(JSON.stringify(m));
    },
    close: () => {
      if (closed) return;
      closed = true;
      fallback.cancel();
      stopKeepalive();
      teardownPeer();
      ws.close();
      setStatus('disconnected');
    },
  };
}

function subscribe<T>(set: Set<T>, cb: T): () => void {
  set.add(cb);
  return () => set.delete(cb);
}

function warn(e: unknown) {
  console.warn('PhoneLink signaling:', e);
}

const CONTROL_TYPES = new Set(['ping', 'pong', 'zero', 'haptic']);

function parseControl(data: unknown): ControlMessage | null {
  if (typeof data !== 'string') return null;
  try {
    return asControl(JSON.parse(data));
  } catch {
    return null;
  }
}

function asControl(m: unknown): ControlMessage | null {
  return typeof m === 'object' && m !== null && CONTROL_TYPES.has((m as { type?: unknown }).type as string)
    ? (m as ControlMessage)
    : null;
}
