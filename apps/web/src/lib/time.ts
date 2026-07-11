/** Lap times are stored as integer milliseconds; formatting is display-only. */

/** 138103 → "2:18.103"; sub-minute laps → "58.204". */
export function formatLapTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;
  const secPart = `${seconds.toString().padStart(minutes > 0 ? 2 : 1, "0")}.${millis
    .toString()
    .padStart(3, "0")}`;
  return minutes > 0 ? `${minutes}:${secPart}` : secPart;
}

/** Gap to the car/driver ahead: 621 → "+0.621"; 61_204 → "+1:01.204". */
export function formatGap(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms === 0) return "—";
  if (ms < 60_000) {
    return `+${(ms / 1000).toFixed(3)}`;
  }
  return `+${formatLapTime(ms)}`;
}
