# Ping Pong

A webcam table-tennis game where the player swings at the laptop camera to hit the ball. It has two modes: Return Drill, where a machine feeds balls, and Match, against a computer Opponent.

## Play

**Return Drill**:
The practice mode: the Feeder sends Feeds one at a time and the player tries to return each one onto the far half.
_Avoid_: Return Challenge

**Feeder**:
The machine at the far end of the table in Return Drill that launches balls toward the player.
_Avoid_: Serve machine, robot

**Opponent**:
The computer player at the far end of the table in a Match, who returns the player's Shots and serves. Not the Feeder: the Feeder only launches, the Opponent plays.
_Avoid_: AI, CPU, bot, NPC

**Feed**:
One ball launched by the Feeder, landing once on the player's half. A Feed is never a Serve.

**Shot**:
Any ball put into flight by either side: a Feed, a Serve, or an attempt at a Return, whether or not it succeeds.
_Avoid_: Hit

**Return**:
A Shot by either side, other than a Serve, whose first bounce is on the other side's half.
_Avoid_: Hit, shot (when meaning a successful one)

**Net-cord**:
A Shot in a Rally that clips the top of the net and carries on. It stays in play: one that then lands on the other half counts as if it had cleared the net.
_Avoid_: Let (a Serve-only rule)

**Streak**:
In Return Drill, the number of consecutive Returns; it resets on any failed Feed.
_Avoid_: Score, combo

## Match

**Match**:
A contest against the Opponent: one Game, or the best of three Games.

**Game**:
Won by the first side to 11 Points with a lead of at least 2.
_Avoid_: Set

**Point**:
What one side wins when a Rally ends.
_Avoid_: Score (for the tally)

**Rally**:
The Shots from a Serve until the ball is dead.

**Serve**:
The first Shot of a Rally: it must bounce once on the server's half, then on the receiver's half.
_Avoid_: Feed

**Fault**:
A Serve that breaks the Serve rule; the receiver wins the Point.

**Let**:
A Serve that clips the net and then lands legally; it is served again and no Point is awarded.

**Rally End**:
Why a Rally is over, and so who loses the Point: **Net** (a dead net), **Out** (the Shot doesn't land on the other half), **Own-half** (its first bounce is on the hitter's half), all against the hitter; or **Unreturned** (the receiver doesn't make a Return before a second bounce), against the receiver.
_Avoid_: Double bounce, missed (both are Unreturned)

**Pop-up**:
An Opponent mistake: a high, slow, easy ball to the middle of the player's half that invites a fast Return.

**Error**:
An Opponent mistake: a Shot that lands just past the end line or wide of the sideline.

**Difficulty**:
How strong the Opponent plays in a Match: Novice, Intermediate or Expert. It never changes during a Match.
_Avoid_: Tier, level

**Whiff**:
An Opponent mistake: it swings and doesn't touch the ball. The player's equivalent is Early, Late or Miss.

## Swinging

**Swing**:
A deliberate stroke by the player's hitting arm toward the ball, as recognised by the game.
_Avoid_: Hit, gesture

**Swing Onset**:
The moment a Swing is recognised: the wrist moving fast in the Stroke Direction. The game reacts at Onset, not when the Swing finishes.

**Stroke Direction**:
The way the wrist must travel for movement to count as a Swing: toward the non-hitting side for a Forehand, toward the hitting side for a Backhand.

**Lift**:
How steeply a Swing rises at Onset. It sets a Return's Topspin and is how the player answers an incoming Shot's Spin: Backspin needs more Lift, Topspin less.

**Backswing**:
The wind-up movement against the Stroke Direction before a Swing; it is never a Swing.

**Forehand** / **Backhand**:
The side of a Swing, decided by which side of the body's midline the wrist was on when the stroke started (its last stop or change of direction), so a fast stroke that has already crossed the midline at Onset keeps its side. Side never decides whether a Return succeeds.

**Paddle**:
The on-screen bat that follows the player's hitting wrist.
_Avoid_: Racket, bat, paddle marker

## Timing

**Ideal Time**:
The moment an incoming Shot reaches the receiver's end of the table, after its bounce.
_Avoid_: tIdeal (in prose)

**Hit Window**:
The span around the Ideal Time in which a Swing counts.

**Early** / **Late** / **Miss**:
The ways the player fails to return a Shot: a Swing before the Hit Window, a Swing after it, or no Swing at all.

**Timing Offset**:
A per-player correction, measured during calibration, between when the player means to hit and when the game sees their Swing Onset.
_Avoid_: Lag, delay

## Spin

**Spin**:
The ball's rotation, set at launch and slowly fading in flight. It bends the flight through the air and changes how the ball comes off the table.

**Topspin**:
Spin that rolls the top of the ball forward, in its direction of travel. It makes the ball dip in flight and come off the table faster and lower.
_Avoid_: Loop (that is a stroke, not a spin)

**Backspin**:
Spin opposite to Topspin. It makes the ball float in flight and come off the table no faster, and on steep bounces slower ("check up").
_Avoid_: Underspin, chop (a stroke)

**Sidespin**:
Spin about the vertical axis. It curves the ball sideways in flight but does not change how it comes off the table.
