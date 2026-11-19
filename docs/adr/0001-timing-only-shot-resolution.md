# Returns are resolved from Swing timing, not paddle–ball collision

Webcam pose tracking is noisy, sees little depth, and arrives roughly 100–230 ms late, so testing whether the tracked Paddle touches the ball would make players whiff Swings they clearly timed right. Instead, the game compares the Swing Onset (corrected by the player's Timing Offset) with the Feed's Ideal Time: a Swing inside the Hit Window always produces a Return. Timing picks the direction, swing speed picks the pace, and a target solver computes the launch velocity that reaches the chosen landing spot. The Paddle is drawn for feel and pulled to the ball at contact, but it never decides whether a Return happens.

## Consequences

- Misses are made by moving the solver's target (long or wide), never by adding noise to the launch velocity, so they look like real misses, not glitches.
- Adding spin or a phone-as-paddle later means feeding more fields into the same resolver, not adding collision.
