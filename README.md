# ping-pong

Live (auto-deployed from `main` via GitHub Pages, HTTPS): https://k-coder05.github.io/ping-pong/

```
npm run dev     # local dev server
npm test        # unit tests
npm run build   # typecheck + production build into dist/
```

## Measuring latency

The latency harness is a separate page, not linked from the game: https://k-coder05.github.io/ping-pong/latency.html (locally `/latency.html` under `npm run dev`). It shows the mirrored camera full screen with one magenta dot on the tracked wrist, plus a small corner readout of camera FPS and inference cost.

- `?hand=left` tracks the left wrist (default right).
- `?raw` draws the unsmoothed wrist. By default the dot uses the smoothed wrist, as the game does, so the result includes the smoothing lag.

Procedure (SPEC "Latency harness"):

1. Film the laptop screen and your real hand together with a phone in slow motion (240 FPS if available).
2. Swing fast, then step through the video frame by frame and count frames between your real hand starting to move and the dot starting to move (about 4.2 ms per frame at 240 FPS).
3. Repeat about 10 times per laptop and take the median. Test at least two laptops, including a cheap one with integrated graphics.
