/** "3s ago", "2m ago", "1h ago" */
export function formatRelative(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) {
    return `${s}s ago`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m ago`;
  }
  const h = Math.floor(m / 60);
  if (h < 24) {
    return `${h}h ago`;
  }
  return `${Math.floor(h / 24)}d ago`;
}

export function formatClock(ts: number): string {
  const d = new Date(ts);
  const hms = d.toLocaleTimeString("en-US", { hour12: false });
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hms}.${ms}`;
}
