# The Opponent's Shots are decided by its brain at launch; its body is cosmetic

The Opponent chooses each Shot (a good Shot, a Pop-up, an Error or a Whiff) when the incoming Shot launches, from its Difficulty and how hard that ball is, and the choice takes effect at the Ideal Time. Its mistakes are designed, not emergent from simulated footwork, reach or launch noise, so they can be tuned to give the player chances (a Pop-up to attack) instead of looking like random glitches, and so a Match is reproducible from its seed. The Opponent's body only moves and swings to make the chosen Shot look real; it never changes an outcome, and removing it from the renderer must not change a replay.

## Considered Options

- **Physically simulated Opponent** (movement speed and reach decide whether it gets to the ball): rejected. Difficulty would be tuned indirectly through body parameters, mistakes would cluster on wide balls only, and outcomes would depend on the renderer's animation step.

## Consequences

- Same rule as ADR 0001 for the player: an Error is made by moving the Shot's target past the end line or sideline, never by adding noise to the launch.
- Deciding at launch, not at the Ideal Time, lets the body start its backswing and set its paddle angle for the Shot it is about to play.
