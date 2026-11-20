import { describe, expect, it } from 'vitest';

/**
 * Every source file (tests included, except this one, whose examples
 * would match) under src/game/, src/physics/ and src/opponent/, as raw text:
 * these must run in Node, so they never import Three.js, MediaPipe or the
 * renderer. Type-only imports from src/sensing/ are allowed.
 */
const sources = import.meta.glob(['/src/game/**/*.ts', '/src/physics/**/*.ts', '/src/opponent/**/*.ts', '!/src/game/headless.test.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** Every module specifier a file imports or re-exports, statically or with `import()`. */
function specifiers(text: string): string[] {
  const found: string[] = [];
  const patterns = [/\b(?:import|export)\s[^'"]*?\sfrom\s*['"]([^'"]+)['"]/g, /\bimport\s*['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) found.push(match[1]!);
  return found;
}

/** Whether `specifier`, imported from the file at `path`, is Three.js, MediaPipe or under src/render/. */
function isForbidden(path: string, specifier: string): boolean {
  if (specifier === 'three' || specifier.startsWith('three/') || specifier.startsWith('@mediapipe/')) return true;
  if (!specifier.startsWith('.')) return specifier.includes('/render/') || specifier.startsWith('src/render');
  const resolved = new URL(specifier, `file://${path}`).pathname;
  return resolved.startsWith('/src/render/');
}

describe('headless game, physics and Opponent code', () => {
  it('scans the game and physics source files', () => {
    const paths = Object.keys(sources);
    expect(paths).toContain('/src/game/core.ts');
    expect(paths).toContain('/src/game/ball.ts');
    expect(paths).toContain('/src/physics/flight.ts');
    expect(specifiers(sources['/src/game/core.ts']!)).toContain('./feeder.ts');
  });

  it('recognises the imports it forbids', () => {
    const text = [
      "import * as THREE from 'three';",
      "import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';",
      "import { PoseLandmarker } from '@mediapipe/tasks-vision';",
      "import type { Hud } from '../render/hud.ts';",
      "export { createHud } from '../render/hud.ts';",
      "const scene = await import('../render/scene.ts');",
      "import './ball.ts';",
    ].join('\n');
    const found = specifiers(text);
    expect(found.filter((s) => isForbidden('/src/game/x.ts', s))).toHaveLength(6);
    expect(isForbidden('/src/game/x.ts', './ball.ts')).toBe(false);
    expect(isForbidden('/src/game/x.ts', '../sensing/landmarks.ts')).toBe(false);
  });

  it('never imports three, @mediapipe/* or src/render/', () => {
    const offenders = Object.entries(sources).flatMap(([path, text]) =>
      specifiers(text)
        .filter((specifier) => isForbidden(path, specifier))
        .map((specifier) => `${path} imports ${specifier}`),
    );
    expect(offenders).toEqual([]);
  });
});
