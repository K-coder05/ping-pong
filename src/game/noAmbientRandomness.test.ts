import { describe, expect, it } from 'vitest';

/** Source (not tests) under src/game/ and src/physics/, as raw text. */
const sources = import.meta.glob(['/src/game/**/*.ts', '/src/physics/**/*.ts', '!/src/**/*.test.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

describe('no ambient randomness or clock in game or physics source', () => {
  it('scans the game and physics source files', () => {
    const paths = Object.keys(sources);
    expect(paths).toContain('/src/game/feeder.ts');
    expect(paths).toContain('/src/physics/spin.ts');
    expect(paths.some((p) => p.endsWith('.test.ts'))).toBe(false);
  });

  it('never uses Math.random or Date.now', () => {
    const offenders = Object.entries(sources)
      .filter(([, text]) => /Math\s*\.\s*random|Date\s*\.\s*now/.test(text))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
