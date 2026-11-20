# Latency Measurements

## Trial 1
- Laptop Model: Macbook Pro
- Camera FPS: 30.0
- Phone FPS: 240.0 at 1080p HD
- Inference ms: 20.0
- Median Latency: 0.20 seconds of slow motion time recorded on iPhone

## Trial 2
- Laptop Model: Macbook Pro
- Camera FPS: 30.0
- Phone FPS: 240.0 at 1080p HD
- Inference ms: 20.0
- Median Latency: 0.18 seconds of slow motion time recorded on iPhone
# Detection Test (#12)

## Trial 1 (before tuning fixes)
- Detected: 12 / 20
- False triggers: 0 in 60 s (0.0 per minute)
- Camera FPS: 23

## Trial 2 (839de11 defaults)
- Detected: 20 / 20
- False triggers: 0 in 60 s (0.0 per minute)
- Values: SWING_ON 5.2, SWING_OFF 0.5, cooldown 700 ms, SWING_MIN_RISE 0.5, One Euro minCutoff 1.0 Hz / beta 10
