import type { LogEntry } from "../../protocol.ts";

/**
 * Severity tokens, most severe first so a line mentioning several is classified by the worst.
 * Anchored on word boundaries: a bare substring test classifies every line containing an
 * "/api/error" path or an `error=null` field as an error.
 */
const LEVELS: [RegExp, LogEntry["level"]][] = [
  [/\b(FATAL|PANIC|ERROR|ERR)\b/i, "error"],
  [/\b(WARN|WARNING)\b/i, "warn"],
  [/\b(DEBUG|TRACE)\b/i, "debug"],
];

export function getLogLevel(message: string): LogEntry["level"] {
  for (const [re, level] of LEVELS) {
    if (re.test(message)) {
      return level;
    }
  }
  return "info";
}
