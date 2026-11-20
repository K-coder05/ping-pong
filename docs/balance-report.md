# Balance report

Nov 19, 2026 · from `npm run balance` (spec P2-g2, #33). The numbers come from `DIFFICULTIES` as committed and **provisional player models**. `fixtures/players/first-timer.json` and `you.json` haven't been recorded yet, so `scripts/balance.ts` used its built-in guesses, listed below. Rerun once the real models are fitted (`npm run fit-player`). Nothing in `DIFFICULTIES` has been changed; the proposals at the end are for you to decide.

## How to reproduce

```
npm run balance -- --matches 500                 # every Difficulty × every model
npm run balance -- --matches 500 --sweep mistakeBase=0.05:0.25:0.05 --difficulty novice --model first-timer
```

- **Setup:** one Game to 11, seed 1, 60 fps, default knobs.
- **Determinism:** the same flags print the same table; checked twice at 20 Matches per row.
- **Run time:** the full table (6 × 500 Matches) took 43 s on 10 worker threads. The 5-point sweep (5 × 500) took 22 s.

**Provisional models** (guesses, not measurements):

| Model | Timing (mean ± sd) | Detect rate | Speed (sw/s) | Vertical path |
| --- | --- | --- | --- | --- |
| first-timer | 25 ± 90 ms | 0.85 | 6.2 ± 1.3 | 0.6 ± 1.2 |
| you | 0 ± 45 ms | 0.95 | 6.8 ± 0.9 | 1.2 ± 0.9 |

## Results: current `DIFFICULTIES`

| Difficulty | Player | Opponent wins (95%) | Rally length | Points/Game | Opponent mistakes | Pop-up / Error / Whiff | Player errors | Unreachable Points | Target |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| novice | first-timer | 34.8% ± 4.2 | 5.29 | 18.9 | 25.0% | 14.9% / 5.0% / 5.1% | 14.7% | 30.1% | ≤ 40%: met |
| novice | you | 4.0% ± 1.7 | 13.03 | 15.9 | 23.0% | 13.9% / 4.6% / 4.5% | 4.6% | 10.9% | |
| intermediate | first-timer | 42.2% ± 4.3 | 5.39 | 19.0 | 13.5% | 5.1% / 4.3% / 4.1% | 14.9% | 32.2% | |
| intermediate | you | 5.0% ± 1.9 | 14.02 | 16.7 | 12.8% | 5.1% / 3.7% / 3.9% | 4.7% | 13.7% | 40–60%: **not met** |
| expert | first-timer | 50.0% ± 4.4 | 5.59 | 18.8 | 5.7% | 1.1% / 2.3% / 2.3% | 14.9% | 38.7% | |
| expert | you | 16.6% ± 3.3 | 15.89 | 18.1 | 5.4% | 1.1% / 2.2% / 2.2% | 4.9% | 25.9% | ≥ 70%: **not met** |

What the columns mean:

- **Rally length**: Shots per Rally, counting the Serve and leaving out Lets.
- **Opponent mistakes**: the share of the Opponent's chosen Shots that were Pop-ups, Errors or Whiffs.
- **Player errors**: the share of Shots coming to the player, tosses included, that ended the Rally against the player.
- **Unreachable Points**: the share of all Points the player won with a Return the Opponent never had a chance at. These are Returns that bounce twice on the Opponent's half before reaching its end line, so they have no Ideal Time there.

## Sweep: Novice `mistakeBase` against first-timer

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

1. **Give the Opponent short balls first (gameplay, not tuning).** When a Shot toward the Opponent has no end-line Ideal Time, strike it at the top of its bounce, or where it crosses a strike plane inside the table (for example z = −1.0 m). This touches `findIdealTime` and `lookAhead` in `rally.ts`, plus the brain's tests. Re-run this table after it lands, because every other number moves with it.
2. **Then re-tune against "you"** with the real `you.json`. If the Opponent is still too easy, the levers are, in order:
   - fewer Opponent mistakes (Expert `mistakeBase` toward 0.01);
   - harder Shots for the player: shorter `minFlightS` and more `maxSpinRevs`, which raise the player's errors through the Spin answer and less time to swing;
   - `cornerAim`.
3. **Keep Novice `mistakeBase` at 0.15 for now.** It meets its target with margin, so don't change it until the real first-timer model exists.

## Still to do by hand

- Record at least three first-timer sessions and three of your own. Fit them with `npm run fit-player -- logs/*.jsonl --name first-timer --detect-rate <r>` (and `--name you`), taking the detect rate from `detection.html`. Commit the fixtures, then re-run `npm run balance -- --matches 500` and replace the tables above.
- After a real playtest, check that the results land roughly where the table predicts. If they don't, refit the models.
