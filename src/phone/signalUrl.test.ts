import { describe, expect, it, vi } from 'vitest';
import { healthUrlFor, signalUrlFor, wakeSignalServer } from './signalUrl.ts';

const loc = { protocol: 'https:', host: 'k-coder05.github.io' };

describe('signalUrlFor', () => {
  it('falls back to the dev proxy when unset or blank', () => {
    expect(signalUrlFor(undefined, loc)).toBe('wss://k-coder05.github.io/signal');
    expect(signalUrlFor('  ', { protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/signal');
  });
  it('uses the configured URL, converting http(s) to ws(s)', () => {
    expect(signalUrlFor('https://x.onrender.com', loc)).toBe('wss://x.onrender.com');
    expect(signalUrlFor('http://localhost:8787', loc)).toBe('ws://localhost:8787');
    expect(signalUrlFor('wss://x.onrender.com', loc)).toBe('wss://x.onrender.com');
  });
});

describe('healthUrlFor', () => {
  it('is /health on the configured server, whatever scheme it was given in', () => {
    expect(healthUrlFor('https://x.onrender.com', loc)).toBe('https://x.onrender.com/health');
    expect(healthUrlFor('wss://x.onrender.com/', loc)).toBe('https://x.onrender.com/health');
  });
  it('goes through the dev proxy when unset', () => {
    expect(healthUrlFor(undefined, loc)).toBe('https://k-coder05.github.io/signal/health');
  });
});

describe('wakeSignalServer', () => {
  it('sends one GET to the health URL', () => {
    const f = vi.fn().mockResolvedValue(new Response());
    wakeSignalServer(f, 'https://x.onrender.com', false, loc);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0]?.[0]).toBe('https://x.onrender.com/health');
  });
  it('sends nothing when unconfigured outside dev', () => {
    const f = vi.fn();
    wakeSignalServer(f, undefined, false, loc);
    expect(f).not.toHaveBeenCalled();
  });
  it('swallows a rejected or throwing fetch', async () => {
    expect(() => wakeSignalServer(vi.fn().mockRejectedValue(new Error('down')), 'https://x', false, loc)).not.toThrow();
    expect(() =>
      wakeSignalServer(
        () => {
          throw new Error('sync');
        },
        'https://x',
        false,
        loc,
      ),
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});
