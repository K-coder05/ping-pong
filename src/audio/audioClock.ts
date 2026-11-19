/**
 * AudioContext time at which a `performance.now()` moment (ms) will be heard.
 *
 * Uses `AudioContext.getOutputTimestamp()` (a paired contextTime /
 * performanceTime sample of what is leaving the speakers now), so it already
 * accounts for output latency where the browser reports it; falls back to
 * `currentTime` + `baseLatency`.
 */
export function contextTimeAt(audio: AudioContext, performanceTime: number): number {
  const stamp = audio.getOutputTimestamp?.();
  if (stamp && stamp.performanceTime && stamp.contextTime !== undefined && stamp.performanceTime > 0) {
    return stamp.contextTime + (performanceTime - stamp.performanceTime) / 1000;
  }
  return audio.currentTime + (performanceTime - performance.now()) / 1000 + (audio.baseLatency ?? 0);
}
