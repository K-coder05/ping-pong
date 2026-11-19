import { describe, expect, it } from 'vitest';
import installedPackageJson from '../../node_modules/@mediapipe/tasks-vision/package.json?raw';
import { WASM_BASE_URL } from './pose.ts';

describe('pose model loading', () => {
  it('loads the wasm runtime for exactly the installed @mediapipe/tasks-vision version', () => {
    const { version } = JSON.parse(installedPackageJson) as { version: string };
    expect(WASM_BASE_URL).toBe(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${version}/wasm`);
  });
});
