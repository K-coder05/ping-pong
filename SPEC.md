# Return Drill prototype build spec

Nov 18, 2026 · @Khiem

Terms in **bold** below are defined in [`GLOSSARY.md`](GLOSSARY.md). Key decisions are recorded in [`docs/adr/`](docs/adr/).

## Goal and scope

The prototype answers one question: does swinging at a laptop webcam feel like hitting a ping-pong ball? A **Feeder** on the far side sends slow **Feeds**; you swing; if your **Swing** lands in the **Hit Window**, the ball flies back onto the far half as a **Return** and your **Streak** goes up by one. It's modelled on the return-practice modes of motion-controlled table-tennis games, where a machine feeds and every return scores.

Swings come only from moving your hand like a paddle. There is no key or button that swings for you.

**In scope**

- Browser page: webcam on, MediaPipe Pose tracking your hitting wrist; you play standing 1.5–2 m from the laptop
- A 3D table, net, ball and a Feeder (simple shapes, no characters), seen from a fixed camera behind your end
- A **Paddle** that follows your wrist, swings at **Swing Onset** and meets the ball at contact
- Ball drawn larger than life with a shadow, so it's readable from 2 m away
- Swing detection from wrist speed in the **Stroke Direction**, so a **Backswing** never triggers; **Forehand**/**Backhand** from which side of your body your wrist is on
- Timing-only shot resolver: early or late changes direction, swing speed changes pace
- Score: Streak, with "Early!" / "Late!" / "Miss" feedback
- Two sounds: Paddle contact and table bounce
- A latency measurement, a short timing calibration and a cued detection test
- Mouse input as a **developer-only** flag (`?input=mouse`) for building the game loop before the camera works; players never see it

**Out of scope for now**: computer opponent, spin, player **Serve**, player avatar, music and any sound beyond the two above, phone-as-paddle, learned classifiers, seated play, key or button input for players, onboarding beyond handedness and calibration (no framing check, lighting check or practice balls).

**Done when**

- **Detection**: in the cued detection test, at least 90% of Swings are detected, with fewer than 1 false trigger per minute of standing and talking, across 3–5 testers in different lighting (Nintendo's bar for Switch Sports recognition)
- **Feel**: after a 5-minute session, testers rate "it felt like I hit the ball" from 1 to 5 and answer "would you play again?"; the median rating is at least 4 and most testers say yes
- **Latency**: you know your real motion-to-screen latency on at least two laptops

## Tech stack and project setup

Build it as a static web page: Three.js for rendering, `@mediapipe/tasks-vision` for pose, plain TypeScript for everything else. A URL with no install, inference on the player's own machine and free static hosting is the cheapest way to reach many players, and video never leaves the device.

| Piece | Choice | Why |
| --- | --- | --- |
| Build tool | Vite + TypeScript | Fast dev server; `localhost` counts as a secure context, so the camera works without HTTPS while developing |
| Rendering | Three.js, WebGL2 renderer | WebGPU now ships in Chrome, Edge, Firefox and Safari but is incomplete on Linux and some Firefox platforms; the scene is light, so WebGL2 is enough |
| Pose | `@mediapipe/tasks-vision` Pose Landmarker, **lite** model | Google's own web runtime; lite ran at about 92 FPS (full 81, heavy 38) on a 2019 MacBook Pro in 2021 tests |
| Physics | Your own \~100-line integrator | A rigid-body engine adds nothing; you need custom bounce and target solving anyway |
| Audio | Web Audio API | Two short sounds; no library needed |
| Hosting | Any static host (GitHub Pages, Netlify, Vercel) | Needs HTTPS for the camera in production |

&#91;embedded content: prototype architecture · 9 modules\]

The webcam (and, for developers, the mouse) ends in a `SwingEvent`; the shot resolver matches it to the Feed's **Ideal Time** (`tIdeal`) and hands a landing spot to the same solver the Feeder uses. See [ADR 0001](docs/adr/0001-timing-only-shot-resolution.md) for why there is no paddle–ball collision.

**Suggested file layout**

```
src/
  main.ts            // boot, game loop, state machine
  sensing/
    camera.ts        // getUserMedia, frame callback
    pose.ts          // MediaPipe setup, detectForVideo
    oneEuro.ts       // landmark smoothing
  input/
    types.ts         // SwingEvent interface
    poseInput.ts     // landmarks -> SwingEvent
    mouseInput.ts    // mouse drag -> SwingEvent (developer flag only)
  game/
    constants.ts     // table, ball, tuning knobs
    ball.ts          // integrator + bounce
    feeder.ts        // schedules and launches Feeds
    shotResolver.ts  // Hit Window -> Return
    solver.ts        // target point -> launch velocity
    score.ts         // Streak, best Streak
  render/
    scene.ts         // table, net, ball + shadow, Feeder, play camera
    paddle.ts        // wrist mapping, swing animation, contact assist
    hud.ts           // Streak, Early!/Late!, tracking banner
  audio/
    sounds.ts        // contact and bounce sounds
  tools/
    latencyHarness.ts
    detectionTest.ts // cued Swings + idle false-trigger count
```

Keep `input/` separate from `sensing/` from day one: the game only ever sees `SwingEvent`s, so you can tune physics with the developer mouse flag and add a phone controller later without touching game code.

**Setup commands**

```
npm create vite@latest pingpong -- --template vanilla-ts
cd pingpong
npm install three @mediapipe/tasks-vision
npm install -D @types/three
npm run dev
```

## Sensing: camera, pose model, smoothing

Run pose inference once per new camera frame, separately from the 60 Hz render loop, and smooth only the few landmarks you use. Inference runs at about camera rate (30 or 60 Hz); rendering and physics must never wait on it.

**Player position**: stand about 1.5–2 m from the laptop so that both shoulders and your fully extended hitting arm stay in frame through the whole swing. At desk distance, a typical laptop camera (about 70–80° field of view) loses the wrist mid-swing, exactly when Swing Onset needs it. Seated play is out of scope.

**Camera**

- Request `getUserMedia({ video: { width: 640, height: 480, frameRate: { ideal: 60 } } })`. 60 FPS halves capture delay and motion blur where the webcam supports it; many laptop cameras top out at 30.
- Show the video mirrored (CSS `transform: scaleX(-1)`) so the player's right hand appears on the right.
- Drive inference with `video.requestVideoFrameCallback`, so each camera frame is processed exactly once. Move it to a Web Worker later if it stutters the render loop.

**Pose Landmarker setup**

```
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

const vision = await FilesetResolver.forVisionTasks(
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm');
const pose = await PoseLandmarker.createFromOptions(vision, {
  baseOptions: {
    modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
    delegate: 'GPU',
  },
  runningMode: 'VIDEO',   // ordered frames, increasing timestamps
  numPoses: 1,
});

function onFrame(now: number) {
  const res = pose.detectForVideo(video, now);
  // res.landmarks[0]: 33 points, x/y in 0..1, plus visibility
  // res.worldLandmarks[0]: same points in meters, hip-centred
  video.requestVideoFrameCallback(onFrame);
}
video.requestVideoFrameCallback(onFrame);
```

VIDEO mode is the documented way to process live webcam frames on the web. It reruns its person detector only when tracking is lost, which keeps it fast. Fall back to the `full` model only if lite is too jittery on your test laptops.

**Landmarks you need** (MediaPipe's left/right is the *person's* side)

| Index | Landmark | Used for |
| --- | --- | --- |
| 11, 12 | Left, right shoulder | Body scale (shoulder width), midline, body axis |
| 13, 14 | Left, right elbow | Later: forearm angle |
| 15, 16 | Left, right wrist | Swing speed and position (drives the Paddle) |
| 19, 20 | Left, right index finger | Later: rough palm angle |
| 23, 24 | Left, right hip | Midline fallback |

**Smoothing: One Euro filter**

Apply a One Euro filter to each coordinate of the hitting wrist (and the shoulders). It is an adaptive low-pass filter: `minCutoff` removes jitter when the hand is still, and `beta` raises the cutoff as speed rises so fast swings are not delayed ([reference](https://gery.casiez.net/1euro/)). Use `minCutoff = 1.0` Hz and `beta = 10`, tuned from logs (#12). `beta` multiplies speed in normalized image units per second, and a Swing moves the wrist about 1–3 image widths per second, so `beta = 10` lifts the cutoff to 10–30 Hz mid-Swing. The original guess of `0.01` left it near 1 Hz, which blunted every Swing and delayed Onset by a frame.

**Tracking loss**: if the hitting wrist's `visibility` drops below about 0.5 for more than a few frames, pause the Feeder and show a "Can't see your hand" banner.

## Swing detection

A Swing starts the moment wrist speed in the Stroke Direction crosses a threshold, and the game reacts right then, not when the Swing finishes. This is the webcam version of Nintendo's 2006 tennis patent (US 7,424,388), which started a swing when acceleration passed about 1 g and classified it partway through so the animation could begin early.

The Stroke Direction rule matters because every real stroke starts with a Backswing, a fast movement *away* from the ball. If any fast movement counted, the Backswing would fire first, the cooldown would swallow the real stroke, and timing would be off by the length of the Backswing.

**The event the game consumes**

```
export interface SwingEvent {
  t: number;          // ms timestamp of Swing Onset (camera frame time)
  peakSpeed: number;  // total wrist speed, shoulder-widths per second, max over last 3 frames
  side: 'forehand' | 'backhand';
  vertPath: number;   // + = moving upward; unused until spin is added
}
```

**Algorithm, per camera frame**

1. Take the smoothed hitting wrist `w`, the hitting-side shoulder `H` and the other shoulder `N` (normalized image coordinates).
2. Body scale: `sw = |H − N|` (shoulder width). Origin: `mid = (H + N) / 2`. Body axis: `a = (H − N) / sw`, a unit vector pointing toward the hitting side.
3. Normalized wrist position: `p = (w − mid) / sw`. This makes thresholds work for kids and adults at any distance from the laptop.
4. Velocity: `v = (w − wPrev) / (dt · sw)`, the wrist's own movement across the image in shoulder widths per second, with `dt` from frame timestamps (not an assumed 1/30 s). Total speed `s = |v|`. Do not difference `p`: when the torso turns for a Backswing, the shoulders' on-screen width shrinks to a fraction and their midpoint shifts, and as it unwinds `p` races back toward the midline while the wrist barely moves. In the #12 logs, that alone fired 13 false Swings from Backswings.
5. Side: `u = p · a`. Forehand if `u > 0` (wrist on the hitting side), Backhand otherwise. Working along the body axis means you never have to think about which way the image is mirrored.
6. **Stroke speed**: `uDot = v · a`. A Forehand sweeps toward the non-hitting side, so `sStroke = −uDot`; a Backhand sweeps toward the hitting side, so `sStroke = +uDot`. Pick Forehand or Backhand from `u` where the current movement started: the wrist's last stop or change of direction along the body axis (`|uDot| < SWING_OFF` counts as stopped). A Forehand starts at the far end of its Backswing; a Backhand starts wherever the wrist was before it swept out, even just across the midline. At 20–30 FPS a fast stroke that starts near the midline can show only one frame on its own side before it crosses, so the current frame's side is not enough. The Swing's side is that side too. Backswings and mostly vertical movements (lowering your arm, scratching your head) give a stroke speed near zero or below.
7. **Onset**: if `sStroke > SWING_ON` for 2 consecutive frames, the wrist is rising faster than `SWING_MIN_RISE` on the second, and you are not in the cooldown, emit a `SwingEvent`. `SWING_ON = 5.2`, tuned from logs (#12): the softest real Swing was 5.5, and Backswings re-smoothed at `beta = 10` reached about 4.4. With the rise rule, nothing from Backswings or standing and talking fires even at 4.0, but most of those logs were recorded at the old `beta = 0.01`, so recheck on new recordings before lowering it. `SWING_MIN_RISE = 0.5` shoulder widths/s: real Forehands and Backhands rise (0.6 or more, nearly all above 1.6), while the return to ready position after a Swing, and sliding across between Forehand and Backhand ready, are flat or falling (0.9 at most, mostly below 0). In the #12 detection test such a slide fired just before a real Forehand, and its cooldown swallowed the Swing. A flat or falling stroke is ignored and does not start the cooldown. So a downward chop or push is not a Swing. Mouse mode needs no rise.
8. **Cooldown**: ignore new onsets for 700 ms so one Swing never fires twice. 400 ms let the follow-through's return fire as a second Swing about 0.6 s later.
9. **Re-arm**: the next Swing needs the stroke that fired to have ended: the wrist stopped or turned back along the body axis (`|uDot| < SWING_OFF`, 0.5, or a change of direction), so one long stroke never fires twice. A resting wrist logs under 0.05. Do not wait for total speed `s < SWING_OFF`: in real play the follow-through flows into the return to ready and the next Backswing without the wrist ever stopping, and that rule missed 5 of 20 Swings in the #12 detection test.

Ask handedness once at startup and save it in `localStorage` (wrapped in try/catch).

**Debug overlay (build this first)**: draw the mirrored video, a dot on each tracked landmark, the wrist's last 10 positions as a trail, a live stroke-speed bar with the threshold marked, and a flash on every onset. Log every frame's `t, p, u, s, sStroke`, vertical speed and side to an array you can download as CSV. You will tune every number in this section from those logs, including checking that Backswings never cross the threshold.

**Mouse mode (developer only)**: with `?input=mouse` in the URL, `mouseInput.ts` turns pointer drags over the canvas into the same `SwingEvent`. Screen width stands in for shoulder width, the canvas centre for the midline, and the same Stroke Direction rule applies. Use it to build and tune steps 3–6 before the camera works. It has no menu entry and is never offered to players.

## Feeder and ball physics

The ball is a point mass under gravity and air drag, stepped at a fixed 240 Hz, with a hand-written table bounce. Spin and the Magnus force wait until after the prototype works.

**Constants** (`constants.ts`; table, net and ball from the ITTF rules, drag from Rod Cross)

| Name | Value | Note |
| --- | --- | --- |
| Table length × width | 2.74 × 1.525 m | Origin at table centre; z runs from the Feeder (−) to you (+) |
| Table top height | 0.76 m | Standard table height |
| Net height | 0.1525 m | At z = 0 |
| Ball radius, mass | 0.020 m, 0.0027 kg | 40 mm, 2.7 g (physics; drawn larger, see below) |
| Table restitution `e` | 0.88 | √(23/30): a 30 cm drop bounces about 23 cm |
| Drag coefficient `C_D` | 0.5 | Smooth sphere |
| Drag constant `k` | ≈ 0.14 /m | k = ½·ρ·C\_D·A / m with ρ = 1.2 kg/m³; gives about 1.4 g of drag at 10 m/s |
| Physics step | 1/240 s | Fixed substeps so a fast ball can't skip through the net or table |

**Integrator** (each substep, semi-implicit Euler)

```latex
\mathbf{a} = \mathbf{g} - k\,\lvert\mathbf{v}\rvert\,\mathbf{v}
```

Then `v += a·dt; p += v·dt`. Run physics from an accumulator in the render loop: add the frame's elapsed time and step in 1/240 s chunks.

**Collisions**

- **Table**: if the ball is over the table, moving down, and `p.y − r ≤ 0.76`, set `p.y = 0.76 + r`, `v.y = −e·v.y`, and scale `v.x`, `v.z` by about 0.9 for friction (a starting guess). Record which half it bounced on, and play the bounce sound.
- **Net**: if the ball crosses z = 0 below net height, it is dead (point over). No net-cord physics yet.
- **Out**: below the table top and outside its edges, or a second bounce on the same side, means the rally ends.

**Feeder** (`feeder.ts`)

- Sits at the far end, about 0.3 m above the table. Each Feed lands once on your half, like a practice robot; the Feeder never makes a legal two-bounce Serve.
- Each Feed: pick a random landing target on your half (x within ±0.5 m, z between 0.5 and 1.0 m) and a flight time `T`. The launch velocity comes from the same target solver your Returns use (next section).
- Start slow: `T` about 1.0 s. Every 10 consecutive Returns, cut `T` by about 5%.
- Wait about 1.5 s after a rally ends, show a short "3, 2, 1" cue, then feed.
- At launch, simulate the ball ahead once (it is deterministic) to find the Ideal Time `tIdeal`: the moment it crosses your end of the table, z = +1.37 m, after its bounce. Hand `tIdeal` to the shot resolver.

**Slow-motion knob**: a global `TIME_SCALE` (start 0.8) slows the whole simulation. It widens the effective Hit Window more simply than changing gravity, and you can raise it toward 1.0 as players improve.

## Shot resolver and target solver

The game never checks whether the Paddle touches the ball ([ADR 0001](docs/adr/0001-timing-only-shot-resolution.md)). It compares when you swung with when the ball arrived, picks a landing spot from that timing and your swing speed, then solves for the launch velocity that reaches it. That is why noisy, laggy input can still produce clean Returns that land in.

**Hit Window** (`shotResolver.ts`)

1. Corrected swing time: `tSwing = swing.t − timingOffset`, where `timingOffset` is the player's **Timing Offset** from calibration. Keep camera timestamps, `tIdeal` and game time on the same `performance.now()` clock, converting simulation time to real time when `TIME_SCALE` ≠ 1.
2. `delta = tSwing − tIdeal`. Accept the Swing if `|delta| ≤ W`. Start with `W = 200 ms`; the researched range is ±150–250 ms.
3. One try per Feed: a Swing more than `W` early shows "Early!" and uses up your try, so you can't flail continuously. Make this a toggle in case jittery tracking makes it feel unfair.
4. A Swing after `tIdeal + W` shows "Late!"; no Swing at all shows "Miss". Either way the Streak resets.
5. Contact moment: `tContact = max(now, tIdeal)`. An early, accepted Swing waits for the ball to reach your end, then launches. A late one launches from wherever the ball is now. Play the contact sound at `tContact`.

**From Swing to Return**

| Input | Output | Starting rule |
| --- | --- | --- |
| Timing `delta` | Left/right target `x` | Early → cross-court, late → down the line: `x = sideSign · (−delta / W) · 0.6 m`, with `sideSign` flipped for Backhand and left-handers |
| Timing quality `q = 1 − \|delta\| / W` | In or risky | Inner 70% of the window always lands in; outer 30% pushes the target long by up to 0.4 m so it can miss |
| `peakSpeed` | Pace and depth | Normalize between `SWING_ON` and `SWING_FAST` (start at 8): flight time `T` from 1.0 s (soft) to 0.55 s (hard); depth `z` from −0.6 to −1.2 m |
| Small random scatter | Natural variation | Up to ±0.1 m on x and z, scaled by `1 − q` |

Forehand or Backhand only flips the direction sign and picks the Paddle animation. Using the "wrong" side for where the Feed landed never causes a miss.

This follows what Nintendo learned: timing-to-direction is more robust than recognizing swing direction, and players forgive coarse control if they rarely whiff a swing that should have counted.

**Target solver** (`solver.ts`, shared by the Feeder and your Returns)

Without drag, the launch velocity from point `p0` to landing point `target` in flight time `T` is:

```latex
\mathbf{v}_0 = \frac{\mathbf{target} - \mathbf{p}_0 - \tfrac{1}{2}\mathbf{g}T^2}{T}
```

Drag makes the real ball fall short, so correct it:

```
function solve(p0, target, T) {
  let v0 = closedForm(p0, target, T);
  for (let i = 0; i < 4; i++) {
    const land = simulateUntilTableHeight(p0, v0); // same integrator
    const err = target.clone().sub(land);         // horizontal miss
    v0.x += err.x / T; v0.z += err.z / T;
  }
  if (!clearsNet(p0, v0, 0.05)) return solve(p0, target, T * 1.1); // higher arc
  return v0;
}
```

To make a shot miss on purpose, move the target (long or wide); never add noise to the velocity, or misses look like glitches.

**Scoring**: a Return (first bounce on the Feeder's half) adds 1 to the Streak. Anything else ends the Streak; show the best Streak on screen.

## Scene, Paddle and sound

What you see and hear is half of the feel being tested, so these are in scope even though they're presentation.

**Play camera**: fixed at about eye height behind your end of the table, looking down it toward the Feeder. An orbit camera exists only in debug mode (`D`).

**Ball readability**: at 1.5–2 m from a 13–15" screen, a true-scale ball at the far end is a few pixels wide. Draw the ball at about 2× its physics radius (`BALL_DRAW_SCALE`) and drop a dark shadow straight down onto the table; the shadow is the main cue for judging when it arrives.

**Paddle** (`paddle.ts`)

- **Follows the wrist**: map the normalized wrist position to the Paddle at your end of the table: body-axis position `u` across the table's width (about ±2 shoulder widths → ±0.76 m) and height above the table from `p.y`. Mirror it so it moves the same way as your hand in the mirrored video. The mapping range is a tuning knob.
- **Swing animation**: starts at Swing Onset, and its contact frame is timed to land exactly at `tContact`. The wind-up stretches for early Swings and compresses for late ones, so the Paddle never finishes its follow-through before the ball leaves.
- **Contact assist** (debug toggle, default on): once a Swing is accepted, the Paddle eases toward the ball's contact point during the animation, then returns to following your wrist. The ball always visibly leaves the Paddle.
- **Latency extrapolation** (debug toggle, default off): draw the Paddle ahead of the wrist by the measured motion-to-screen latency, extrapolated from current velocity.

**Sound** (`sounds.ts`, Web Audio): one short *tock* for Paddle contact at `tContact`, and one for each table bounce. Nothing else.

## Latency harness, calibration and detection test

Measure your real motion-to-screen delay before tuning anything. The research only has an estimate of about 100–230 ms for a webcam pipeline, and no one has published a measured figure for MediaPipe in the browser on current laptops. Research on a Kinect exergame found play degrades noticeably around 250 ms and recommends staying at or under 300 ms total.

**Estimated budget (unmeasured)**

| Stage | Estimate |
| --- | --- |
| Camera capture and exposure at 30 FPS | 33–100 ms |
| Pose inference (lite) | 10–35 ms |
| Smoothing | 0–30 ms |
| Game loop + display | 16–50 ms |
| **Total** | **≈ 100–230 ms** |

**Latency harness** (`tools/latencyHarness.ts`, a separate page)

1. Show the mirrored video full screen with a bright dot drawn on the tracked wrist, nothing else.
2. Film the laptop screen and your real hand together with a phone in slow-motion mode (240 FPS if available).
3. Swing fast, then step through the video frame by frame: count frames between your real hand starting to move and the dot starting to move. At 240 FPS each frame is about 4.2 ms.
4. Repeat about 10 times per laptop and take the median. Test at least two laptops, including a cheap one with integrated graphics.
5. Also log, in-app, the time between a frame's timestamp and the end of `detectForVideo` (inference cost) and the average camera frame interval (real FPS).

**Timing calibration** (part of onboarding)

- A visual and audio metronome ticks 5–8 times; the player swings on each tick.
- Compute the median of `swing.t − tickTime` and store it as the Timing Offset (subtracted in the shot resolver). The median ignores one wild swing.
- Save it in `localStorage` (wrapped in try/catch) so returning players skip this step.

**Detection test** (`tools/detectionTest.ts`, run once per tester, separate from play)

1. The same metronome ticks 20 times; the tester swings on each tick. A tick counts as detected if exactly one Swing Onset falls within ±300 ms of the tick plus the tester's Timing Offset from calibration (0 if not calibrated), because that is when the game expects to see a Swing made on the tick. Without it, the ~400 ms between a tick and its Onset (reaction plus camera lag) scored a fully detected run as 0/20 (#12).
2. Then 60 s of standing and talking normally; every Onset counts as a false trigger.
3. Record detected/20 and false triggers per minute in the playtest log. This is the ground truth for the Detection criterion.

**Log replay** (`npm run replay -- pose_csvs/*.csv [--swing-on 4.5] [--min-rise 0.5] [--offset 390] …`, #12): feeds downloaded CSVs (debug overlay or detection test) back through the real pose input and Swing detector with any thresholds, and prints each log's Onsets and, for a detection test, its score and how long after each tick its Onsets came. Tune and check detector changes against recorded sessions with it instead of re-recording. It replays the logged smoothed wrist and shoulders, so its numbers reflect the One Euro settings the log was recorded with (logs before #12's `beta = 10` were smoothed at 0.01), and One Euro changes still need a new recording. The detection test logs each tick's exact time (`tickTime`); older logs fall back to the first frame after the tick, up to one frame late.

**Onboarding for the prototype** (you sit next to each tester, so keep it minimal)

1. Camera permission, with a line that video stays on the device.
2. A static instruction with the mirrored video showing: "Stand back until your whole swing fits in the picture."
3. Handedness: "Which hand holds the paddle?"
4. Timing calibration (above).

The tracking-loss banner stays on during play.

## Step-by-step build order

Build in this order and don't move on until each checkpoint passes. The developer mouse flag lets you finish the whole game loop (steps 3–6) before the camera has to be good.

- [ ] **1. Project skeleton**

  Vite + TypeScript + Three.js. Render a table, net and ball from the fixed play camera, with orbit in debug mode. Checkpoint: the page loads at 60 FPS.
- [ ] **2. Camera and pose debug overlay**

  Webcam on, Pose Landmarker lite in VIDEO mode, mirrored video with landmark dots, wrist trail and live stroke-speed bar, CSV logging. Checkpoint: the wrist dot follows your hand; you can read the real camera FPS and inference time.
- [ ] **3. Ball physics**

  Integrator, table bounce, net and out rules, fixed 240 Hz step. Checkpoint: a dropped ball from 30 cm bounces to about 23 cm; a ball thrown into the net dies.
- [ ] **4. Target solver + Feeder**

  Solver with drag correction and net check; the Feeder sends Feeds to random spots on your half; compute `tIdeal`. Checkpoint: 50 Feeds in a row all land on your half, and a marker shows `tIdeal` correctly.
- [ ] **5. Shot resolver with developer mouse input**

  `SwingEvent` from the mouse (`?input=mouse`), Hit Window, direction from timing, pace from speed, Streak and HUD. Checkpoint: with the mouse, early sends the ball cross-court, late down the line, and the Streak counts.
- [ ] **6. Paddle, ball readability and sound**

  Paddle following the (mouse-driven) wrist position, swing animation synced to `tContact`, contact assist, enlarged ball and shadow, contact and bounce sounds. Checkpoint: from 2 m away you can follow the ball, and every Return visibly and audibly leaves the Paddle, including early and late ones.
- [ ] **7. Latency harness**

  Slow-motion phone test on two laptops. Checkpoint: you have a measured median latency per laptop; write it down.
- [ ] **8. Pose swing detector**

  Body axis, stroke speed, onset threshold, cooldown, re-arm, Forehand/Backhand. Tune thresholds from the CSV logs of 20+ swings (including deliberate Backswings) and 30+ seconds of standing still. Checkpoint: the detection test gives at least 18/20, fewer than 1 false trigger per minute, and no Backswing in the logs crosses the threshold.
- [ ] **9. Wire pose into the game + calibration**

  Swap mouse for pose input, add handedness, metronome calibration, the Timing Offset and the tracking-loss banner. Checkpoint: you can return 10 slow Feeds in a row by swinging naturally while standing.
- [ ] **10. Deploy and playtest**

  Push to a static HTTPS host; test with 3–5 people in different rooms and lighting. Each tester runs the detection test, then plays 5 minutes and answers the feel questions. Checkpoint: the Done-when criteria are met, or you know which number to change.

## Tuning knobs and open questions

Every number below is a starting guess. Put them all in `constants.ts` with an on-screen slider panel (press `D` for debug) so you can tune during playtests without reloading.

| Knob | Start | Raise it if | Lower it if |
| --- | --- | --- | --- |
| `SWING_ON` (stroke speed, shoulder widths/s) | 5.2 (tuned, #12) | Idle movement or talking triggers Swings | Real Swings are missed |
| `SWING_MIN_RISE` (upward speed at Onset, shoulder widths/s) | 0.5 (tuned, #12) | Returns to ready position trigger Swings | Flat real Swings are missed |
| `SWING_FAST` (total speed, shoulder widths/s) | 8 | Every Swing comes out at full power | Players can't reach full power |
| Cooldown | 700 ms (tuned, #12) | One Swing fires twice | Quick re-swings get ignored |
| Hit Window `W` | 200 ms | Players feel robbed | It feels automatic, with no skill |
| Timing Offset | Measured | n/a | n/a |
| Feed flight time `T` | 1.0 s | Players can't keep up | It feels sluggish |
| `TIME_SCALE` | 0.8 | It feels sluggish | Players can't keep up |
| One Euro `minCutoff` | 1.0 Hz | The Paddle lags at rest | The Paddle jitters while still |
| One Euro `beta` | 10 (tuned, #12) | The Paddle lags during fast swings | The Paddle jitters during swings |
| Direction spread | 0.6 m | Returns all go to the middle | Too many go wide |
| `BALL_DRAW_SCALE` | 2× | Players lose the ball | The ball looks cartoonish |
| Paddle mapping range | ±2 shoulder widths | The Paddle hits the table edges too easily | Players must reach too far |
| Contact assist | On | n/a (toggle) | n/a (toggle) |
| Latency extrapolation | Off | n/a (toggle) | n/a (toggle) |

**Playtest log** for each session: laptop model, room lighting, measured FPS, detection test result (detected/20, false triggers per minute), best Streak, feel rating (1–5), "would you play again?", and one sentence of what felt wrong.

**Open questions the prototype should answer**

- What is the real motion-to-screen latency on a typical student laptop, and does lite pose hold 30 FPS on integrated graphics?
- Does a 30 FPS camera blur the wrist so much during fast swings that detection fails? Does 60 FPS fix it?
- How wide must the Hit Window be before rallies feel good, and does a wide window make it feel automatic?
- Do players notice contact assist? Does turning it off, or turning latency extrapolation on, change the feel rating?
- Does stretching the wind-up for early Swings look natural, or does it read as lag?
- Is the wrist alone enough, or do players expect the Paddle to follow their forearm angle?

After this works, the planned next steps are a computer opponent, spin from the Swing's vertical path, player Serves, and a phone-as-paddle mode for real tilt-based spin.
