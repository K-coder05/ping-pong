# Spin control depends on the Input: Lift with the Camera, Face Angle with the Phone

The Camera can't see the bat's face, so with the Camera, Lift (how steeply a Swing rises) sets a Return's Topspin and answers an incoming Shot's Spin. The Phone measures its own orientation, so with the Phone the Face Angle does both jobs instead: a closed face sets Topspin, an open face sets Backspin, and the player answers Spin by matching it (closed against Topspin, open against Backspin). Each Input uses the control it can measure well, instead of the two Inputs sharing the weaker one.

## Considered Options

- **Lift for both Inputs**: rejected. Spin from Face Angle is the main thing the Phone can do that the Camera can't.
- **Combining them** (Lift sets how much Spin, Face Angle sets its direction): rejected as harder to learn, with no clear benefit.

## Consequences

- Same rule as ADR 0001: an unanswered Spin moves the Return's target (short against Backspin, long against Topspin). It never changes the launch.
- With the Phone, a flat face is punished by both Topspin and Backspin, while the Camera's flat Swing never goes long. Expect the Phone to play harder at the same Difficulty; the balance harness measures the gap.
- Backspin Returns exist only with the Phone. The Phone gives no Sidespin and doesn't use Lift.
