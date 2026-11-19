# Return Drill

A webcam table-tennis game where a machine feeds balls and the player returns them by swinging at the laptop camera. The first prototype tests whether swinging this way feels like hitting a ball.

## Play

**Return Drill**:
The game mode: the Feeder sends Feeds one at a time and the player tries to return each one onto the far half.
_Avoid_: Return Challenge

**Feeder**:
The machine at the far end of the table that launches balls toward the player.
_Avoid_: Serve machine, robot, NPC, opponent

**Feed**:
One ball launched by the Feeder, landing once on the player's half.
_Avoid_: Serve

**Serve**:
Reserved for a future feature where the player starts a point. The Feeder never serves.

**Return**:
A ball the player sends back whose first bounce is on the Feeder's half.
_Avoid_: Hit, shot (when meaning a successful one)

**Streak**:
The number of consecutive Returns; it resets on any failed Feed.
_Avoid_: Score, combo

## Swinging

**Swing**:
A deliberate stroke by the player's hitting arm toward the ball, as recognised by the game.
_Avoid_: Hit, gesture

**Swing Onset**:
The moment a Swing is recognised: the wrist moving fast in the Stroke Direction. The game reacts at Onset, not when the Swing finishes.

**Stroke Direction**:
The way the wrist must travel for movement to count as a Swing: toward the non-hitting side for a Forehand, toward the hitting side for a Backhand.

**Backswing**:
The wind-up movement against the Stroke Direction before a Swing; it is never a Swing.

**Forehand** / **Backhand**:
The side of a Swing, decided by whether the wrist is on the hitting-hand side of the body's midline at Onset. Side never decides whether a Return succeeds.

**Paddle**:
The on-screen bat that follows the player's hitting wrist.
_Avoid_: Racket, bat, paddle marker

## Timing

**Ideal Time**:
The moment a Feed reaches the player's end of the table, after its bounce.
_Avoid_: tIdeal (in prose)

**Hit Window**:
The span around the Ideal Time in which a Swing counts.

**Early** / **Late** / **Miss**:
The outcomes of a Feed that is not returned: a Swing before the Hit Window, a Swing after it, or no Swing at all.

**Timing Offset**:
A per-player correction, measured during calibration, between when the player means to hit and when the game sees their Swing Onset.
_Avoid_: Lag, delay
