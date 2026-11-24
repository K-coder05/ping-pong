# Phone fixtures

Recorded Phone logs (`docs/specs/p3.md`, P3-c). `src/input/phoneSwing.fixtures.test.ts` replays every `*.jsonl` here through the Phone Input and checks P3-c's done criteria. Until this folder has fixtures, those checks are skipped.

## File names are the labels

| File | What it holds |
| --- | --- |
| `phone-fore-top-NN.jsonl` | One Forehand with a closed face (topspin) |
| `phone-fore-flat-NN.jsonl` | One Forehand with the face upright |
| `phone-fore-chop-NN.jsonl` | One Forehand with an open face (chop, backspin) |
| `phone-back-top-NN.jsonl`, `phone-back-flat-NN.jsonl`, `phone-back-chop-NN.jsonl` | The same for the Backhand |
| `phone-idle-NN.jsonl` | No Swing at all: walking, adjusting the grip, lowering and raising the arm |

`NN` is a number (`01`, `02`, …). For a left-handed recorder, add `lh-` after `phone-`, for example `phone-lh-fore-top-01.jsonl`. Every other file name fails the checks.

**One Swing per clip.** Each Swing clip holds exactly one Swing. The checks judge the clip's first detected Swing, which is the one the game would act on. Each clip starts with a Zeroing.

**Closed and open** describe the face that hits the ball. On a Forehand that is the palm side, which is the screen. On a Backhand it is the back of the hand. A closed face tips toward the floor and an open face tips toward the ceiling. So a Backhand top tips the back of the hand toward the floor, which turns the screen toward the ceiling.

## What the checks need

- At least 10 clips of each of the six Swing labels
- At least 2 minutes of idle in total, for example four 30-second `phone-idle` clips

The checks pass when:

- at least 90% of Swing clips give their Swing with the right Forehand or Backhand side,
- at least 90% of top and chop clips have a Face Angle with the right sign (+ on top, − on chop), and
- the idle clips have fewer than 1 false Swing per minute.

## How to record

1. On the laptop, run `npm run signal` in one terminal and `npm run dev` in another. Vite prints a Network address such as `https://192.168.1.20:5173/`.
2. On the laptop, open `https://<that address>/?input=phone`, not localhost, because the Phone can't reach localhost. Accept the certificate warning.
3. Put the Phone on the same Wi-Fi network. Scan the QR code, accept the certificate warning, tap **Tap to start** and allow motion access. When the laptop's pairing screen disappears, the Phone is connected.
4. On the laptop, press **D** to turn on debug mode. The Phone log records only while debug mode is on. Press **Discard Phone log** in the panel's Phone group to start with an empty log.
5. For each clip:
   1. Hold the Phone like the handle of a bat, with the screen facing your palm side and the top pointing at the laptop screen. Keep the face upright and hold still.
   2. Tap **Zero** on the Phone with your other hand.
   3. Hold still for about 1 second. Make **one** Swing of the clip's kind, then hold still for about 1 second.
   4. On the laptop, click **Download Phone log**. It suggests the next name, such as `phone-fore-top-04`. Correct the name if needed and press Enter. The file is saved as `<name>.jsonl` in your Downloads folder, and the log starts again.
   5. If the clip went wrong, click **Discard Phone log** and record it again.
6. Move the files here, then run the checks. They print each clip's Swings.

   ```sh
   mv ~/Downloads/phone-*.jsonl fixtures/phone/
   npx vitest run src/input/phoneSwing.fixtures.test.ts
   ```

Note in the commit which Phone recorded the clips, for example iPhone 15 on Safari or Pixel 8 on Chrome. Browsers have disagreed on the motion axes before, so a set from each platform is worth having.
