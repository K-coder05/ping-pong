# Balance report

Nov 23, 2026 · from `npm run balance` (spec P2-g2, #33; Phone rows from spec P3-f, #36). The numbers come from `DIFFICULTIES` as committed and **provisional player models**. `fixtures/players/first-timer.json` and `you.json` haven't been recorded yet, so `scripts/balance.ts` used its built-in guesses, listed below. Rerun once the real models are fitted (`npm run fit-player`). Nothing in `DIFFICULTIES` has been changed; the proposals at the end are for you to decide.

## How to reproduce

```
npm run balance -- --matches 500                 # every Difficulty × every model × Camera and Phone
npm run balance -- --matches 500 --input phone --face-angle-sd 15   # the Phone rows only
npm run balance -- --matches 500 --sweep mistakeBase=0.05:0.25:0.05 --difficulty novice --model first-timer
```

- **Setup:** one Game to 11, seed 1, 60 fps, default knobs.
- **Determinism:** the same flags print the same table; checked twice at 20 Matches per row.
- **Run time:** the Camera-only table (6 × 500 Matches) took 43 s on 10 worker threads; the full table with the Phone rows (12 × 500) took 225 s on a busy machine. The 5-point sweep (5 × 500) took 22 s.
- **The Camera rows are unchanged** by the Phone work: they match the Nov 19 run digit for digit.

**Provisional models** (guesses, not measurements):

| Model | Timing (mean ± sd) | Detect rate | Speed (sw/s) | Vertical path |
| --- | --- | --- | --- | --- |
| first-timer | 25 ± 90 ms | 0.85 | 6.2 ± 1.3 | 0.6 ± 1.2 |
| you | 0 ± 45 ms | 0.95 | 6.8 ± 0.9 | 1.2 ± 0.9 |

**Phone model** (spec P3-f, ADR 0003): the same model, with the same timing, detect rate and speed draws, but each Swing carries a Face Angle and a `vertPath` of 0. The Face Angle is the one that exactly answers the incoming Shot's Spin (its share of `SPIN_ANSWER_FULL_REVS` turned back into an angle) plus Gaussian error, σ = 15° (a starting guess until real Phone logs measure it). So the Face Angle, not Lift, sets the Return's Spin (open gives Backspin, closed gives Topspin) and answers the incoming Spin. Knobs at their defaults: `FACE_ANGLE_DEAD_DEG` 10, `FACE_ANGLE_FULL_DEG` 45, `RETURN_BACKSPIN_MAX_REVS` 30, `PHONE_SPEED_FULL` 7.5.

## Results: current `DIFFICULTIES`

| Difficulty | Player | Input | Opponent wins (95%) | Rally length | Points/Game | Opponent mistakes | Pop-up / Error / Whiff | Player errors | Unreachable Points | Target |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| novice | first-timer | Camera | 34.8% ± 4.2 | 5.29 | 18.9 | 25.0% | 14.9% / 5.0% / 5.1% | 14.7% | 30.1% | ≤ 40%: met |
| novice | first-timer | Phone | 31.6% ± 4.1 | 5.00 | 18.8 | 24.1% | 14.5% / 4.8% / 4.8% | 15.0% | 34.4% | ≤ 40%: met |
| novice | you | Camera | 4.0% ± 1.7 | 13.03 | 15.9 | 23.0% | 13.9% / 4.6% / 4.5% | 4.6% | 10.9% | |
| novice | you | Phone | 0.6% ± 0.7 | 11.00 | 14.9 | 23.0% | 13.7% / 4.6% / 4.7% | 4.5% | 25.2% | |
| intermediate | first-timer | Camera | 42.2% ± 4.3 | 5.39 | 19.0 | 13.5% | 5.1% / 4.3% / 4.1% | 14.9% | 32.2% | |
| intermediate | first-timer | Phone | 45.6% ± 4.4 | 5.27 | 18.9 | 13.6% | 5.3% / 4.2% / 4.2% | 15.3% | 32.5% | |
| intermediate | you | Camera | 5.0% ± 1.9 | 14.02 | 16.7 | 12.8% | 5.1% / 3.7% / 3.9% | 4.7% | 13.7% | 40–60%: **not met** |
| intermediate | you | Phone | 2.4% ± 1.3 | 11.65 | 15.6 | 13.0% | 5.3% / 3.8% / 3.9% | 4.8% | 27.2% | 40–60%: **not met** |
| expert | first-timer | Camera | 50.0% ± 4.4 | 5.59 | 18.8 | 5.7% | 1.1% / 2.3% / 2.3% | 14.9% | 38.7% | |
| expert | first-timer | Phone | 59.6% ± 4.3 | 5.48 | 18.5 | 5.8% | 1.2% / 2.3% / 2.4% | 15.9% | 36.7% | |
| expert | you | Camera | 16.6% ± 3.3 | 15.89 | 18.1 | 5.4% | 1.1% / 2.2% / 2.2% | 4.9% | 25.9% | ≥ 70%: **not met** |
| expert | you | Phone | 4.0% ± 1.7 | 12.20 | 16.4 | 5.7% | 1.1% / 2.2% / 2.3% | 5.1% | 41.0% | ≥ 70%: **not met** |

The targets were set for the Camera; the Phone rows show them only for comparison.

What the columns mean:

- **Rally length**: Shots per Rally, counting the Serve and leaving out Lets.
- **Opponent mistakes**: the share of the Opponent's chosen Shots that were Pop-ups, Errors or Whiffs.
- **Player errors**: the share of Shots coming to the player, tosses included, that ended the Rally against the player.
- **Unreachable Points**: the share of all Points the player won with a Return the Opponent never had a chance at. These are Returns that bounce twice on the Opponent's half before reaching its end line, so they have no Ideal Time there.

## Phone against Camera, per Difficulty

The Opponent's Match win rate, with the change from Camera to Phone (σ = 15°):

| Difficulty | first-timer: Camera → Phone | you: Camera → Phone |
| --- | --- | --- |
| novice | 34.8% → 31.6% (−3.2, inside the noise) | 4.0% → 0.6% (−3.4) |
| intermediate | 42.2% → 45.6% (+3.4, inside the noise) | 5.0% → 2.4% (−2.6) |
| expert | 50.0% → 59.6% (+9.6) | 16.6% → 4.0% (−12.6) |

- **Against Intermediate and Expert, the first-timer plays harder with the Phone, as ADR 0003 expected**, but only Expert's gap is clearly outside the ±4.4-point interval; Novice moves the other way, inside the noise. Their Player errors rise by 0.3–1.0 points, from Spin they answer wrongly with the Face Angle.
- **"You" play easier with the Phone at every Difficulty**, the opposite of what ADR 0003 expected. Player errors are unchanged (4.5–5.1%), so the Phone isn't making "you" safer. What changes is the Unreachable Points column, which roughly doubles (11% → 25%, 14% → 27%, 26% → 41%), and Rallies get 2–4 Shots shorter. The likely causes, both through finding 1 below:
  - a Face Angle that under-answers Backspin moves the Return short, and with the Phone even a flat face is punished, where the Camera's Lift is usually high enough for "you" to answer Backspin fully;
  - a face opened against Backspin sends Backspin back, which floats and checks up, so more Returns bounce twice before the Opponent's end line.
  Short Returns are free Points today, so the Phone's extra short Returns win Points instead of losing them. Not confirmed by a separate run; checking it needs the per-Rally-End breakdown or a `RETURN_BACKSPIN_MAX_REVS` = 0 comparison.
- **Until proposal 1 below lands, the Phone vs Camera gap can't be read as a difficulty gap.** Re-run both Inputs after the Opponent can play short balls, and again once real Phone logs give the Face Angle error a measured σ (`--face-angle-sd`).

## Sweep: Novice `mistakeBase` against first-timer (Camera)

| mistakeBase | Opponent wins (95%) | Rally length | Opponent mistakes | Unreachable Points |
| --- | --- | --- | --- | --- |
| 0.05 | 60.2% ± 4.3 | 5.73 | 14.0% | 33.5% |
| 0.10 | 47.6% ± 4.4 | 5.47 | 19.3% | 32.1% |
| **0.15** (now) | 34.8% ± 4.2 | 5.29 | 25.0% | 30.1% |
| 0.20 | 30.6% ± 4.0 | 5.11 | 29.1% | 29.0% |
| 0.25 | 24.8% ± 3.8 | 4.94 | 34.4% | 28.4% |

## Findings

1. **The Opponent can't reach short Returns, and this decides the balance.**
   - A Shot's Ideal Time is when it crosses the receiver's end line after bouncing (`findIdealTime`, P2-b). A Return that lands short and bounces twice before the Opponent's end line has no Ideal Time, so the Opponent never gets a chance at it, and the referee scores it `unreturned` against the Opponent.
   - These Points are 11–39% of all Points, and the share grows with Difficulty. A harder Opponent makes fewer mistakes, so more of the Points it loses are these.
   - This is why Expert loses to "you" 83% of the time even though it makes few mistakes. No `DIFFICULTIES` value can fix it.
2. **Against first-timers the targets are met, but Difficulty barely matters.** Novice, Intermediate and Expert win 35%, 42% and 50%. The first-timer loses about 15% of the Shots they face whichever Difficulty they play, so their own errors decide most Points.
3. **Against "you", every Difficulty is far too easy**: 4%, 5% and 17% against targets of 40–60% (Intermediate) and at least 70% (Expert). Part of this is finding 1. The rest is that a ±45 ms Swing almost never fails: Player errors are only 4.6–4.9%.
4. **Mistake rates follow the spec's formula.** Novice 25%, Intermediate 13% and Expert 5.5% sit where `mistakeBase + mistakeSlope · d` puts them for typical Returns. The Pop-up share is close to `popUpShare` at each Difficulty.
5. **`mistakeBase` moves Novice's win rate smoothly**, by about 12 points per 0.05 near the current value. Novice against first-timer meets its target anywhere from 0.15 up.

## Proposals (you decide)

1. **Give the Opponent short balls first (gameplay, not tuning).** It matters more with the Phone, whose short Returns turn into Points (see Phone against Camera). When a Shot toward the Opponent has no end-line Ideal Time, strike it at the top of its bounce, or where it crosses a strike plane inside the table (for example z = −1.0 m). This touches `findIdealTime` and `lookAhead` in `rally.ts`, plus the brain's tests. Re-run this table after it lands, because every other number moves with it.
2. **Then re-tune against "you"** with the real `you.json`. If the Opponent is still too easy, the levers are, in order:
   - fewer Opponent mistakes (Expert `mistakeBase` toward 0.01);
   - harder Shots for the player: shorter `minFlightS` and more `maxSpinRevs`, which raise the player's errors through the Spin answer and less time to swing;
   - `cornerAim`.
3. **Keep Novice `mistakeBase` at 0.15 for now.** It meets its target with margin, so don't change it until the real first-timer model exists.

## Still to do by hand

- Record at least three first-timer sessions and three of your own. Fit them with `npm run fit-player -- logs/*.jsonl --name first-timer --detect-rate <r>` (and `--name you`), taking the detect rate from `detection.html`. Commit the fixtures, then re-run `npm run balance -- --matches 500` and replace the tables above.
- Measure the Phone's Face Angle error from real Phone logs (after P3-c), then re-run with `--face-angle-sd <measured>` and replace the Phone rows.
- After a real playtest, check that the results land roughly where the table predicts. If they don't, refit the models.
