import { describe, expect, it } from 'vitest';
import { devSignalUrl, statusLabel } from './link.ts';
import { isLoopbackHost, phonePageUrl } from './pairing.ts';

describe('phonePageUrl', () => {
  it('puts phone.html next to the current page, with the room', () => {
    expect(phonePageUrl('https://192.168.1.20:5173/', 'AB2CD')).toBe('https://192.168.1.20:5173/phone.html?room=AB2CD');
    expect(phonePageUrl('https://192.168.1.20:5173/pairing.html?x=1', 'AB2CD')).toBe(
      'https://192.168.1.20:5173/phone.html?room=AB2CD',
    );
  });

  it('keeps the project-pages base path', () => {
    expect(phonePageUrl('https://k.github.io/ping-pong/index.html', 'XYZ23')).toBe(
      'https://k.github.io/ping-pong/phone.html?room=XYZ23',
    );
  });
});

describe('isLoopbackHost', () => {
  it('flags hosts the Phone cannot reach', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('192.168.1.20')).toBe(false);
  });
});

describe('devSignalUrl', () => {
  it('uses the page host, over wss on https', () => {
    expect(devSignalUrl({ protocol: 'https:', host: '192.168.1.20:5173' })).toBe('wss://192.168.1.20:5173/signal');
    expect(devSignalUrl({ protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/signal');
  });
});

describe('statusLabel', () => {
  it('names each status the pairing screens show', () => {
    expect(statusLabel('waiting')).toBe('Waiting for Phone');
    expect(statusLabel('connecting')).toBe('Connecting…');
    expect(statusLabel('connected')).toBe('Connected');
    expect(statusLabel('disconnected')).toBe('Disconnected');
  });
});
