/**
 * The WebRTC PhoneLink (docs/specs/p3.md, P3-a), used by both pages: the
 * laptop creates a room on the signaling server and makes the offer when the
 * Phone joins; the Phone joins by room code and answers. After that the two
 * talk directly over two data channels:
 *
 * - `motion`: unordered, no retransmits. A late packet is useless, so never wait for it.
 * - `control`: reliable and ordered, JSON `ControlMessage`s.
 *
 * A thin wrapper over `WebSocket` and `RTCPeerConnection`; checked end to end
 * by `e2e/pairing.spec.ts`. ICE servers default to none: on the same network
 * host candidates are enough, and there is no TURN (ADR 0004).
 */
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
  | { kind: 'candidate'; candidate: RTCIceCandidateInit };

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
  const sendSignal = (data: SignalData) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'signal', data }));
  };

  const teardownPeer = () => {
    const old = pc;
    pc = null;
    control = null;
    motion = null;
    pendingCandidates = [];
    old?.close();
  };

  const lost = (from: RTCPeerConnection) => {
    if (from !== pc || closed) return;
    teardownPeer();
    setStatus('disconnected');
  };

  const checkOpen = (from: RTCPeerConnection) => {
    if (from === pc && control?.readyState === 'open' && motion?.readyState === 'open') setStatus('connected');
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
      // TODO(#38): decode with `decodePacket` from src/phone/packet.ts and call packetCbs with now().
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

  /** Laptop: the Phone joined; make the channels and the offer. */
  const offer = async () => {
    const p = newPeer();
    attach(p, p.createDataChannel('control'));
    attach(p, p.createDataChannel('motion', { ordered: false, maxRetransmits: 0 }));
    setStatus('connecting');
    await p.setLocalDescription(await p.createOffer());
    if (p === pc && p.localDescription) sendSignal({ kind: 'description', description: p.localDescription.toJSON() });
  };

  const onSignal = async (data: SignalData) => {
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

  ws.onopen = () => {
    ws.send(JSON.stringify(isLaptop ? { type: 'create' } : { type: 'join', room: joinRoom }));
  };
  ws.onmessage = (e) => {
    if (closed || typeof e.data !== 'string') return;
    const m = JSON.parse(e.data) as ServerMessage;
    switch (m.type) {
      case 'created':
      case 'joined':
        roomKnown = true;
        resolveRoom(m.room);
        setStatus(m.type === 'created' ? 'waiting' : 'connecting');
        return;
      case 'peer-joined':
        if (isLaptop) signalChain = signalChain.then(offer).catch(warn);
        return;
      case 'peer-left':
        if (pc) lost(pc);
        else setStatus('disconnected');
        return;
      case 'signal':
        signalChain = signalChain.then(() => onSignal(m.data as SignalData)).catch(warn);
        return;
      case 'error':
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
    // Once connected, the peers no longer need the server.
    if (status !== 'connected') {
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
    sendPacket: () => {
      // TODO(#38): `motion.send(encodePacket(p))` when the motion channel is open.
    },
    sendControl: (m) => {
      if (control?.readyState === 'open') control.send(JSON.stringify(m));
    },
    close: () => {
      if (closed) return;
      closed = true;
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
    const m = JSON.parse(data) as { type?: unknown };
    return typeof m === 'object' && m !== null && CONTROL_TYPES.has(m.type as string) ? (m as ControlMessage) : null;
  } catch {
    return null;
  }
}
