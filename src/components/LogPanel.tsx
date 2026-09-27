import { logKey } from "@proxy/logKey";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { filterLogs, LEVELS, RANGES, type Range } from "../domain/logFilter";
import type { LogEntry } from "../domain/types";
import type { LogQueryOptions } from "../hooks/telemetryTypes";
import { formatClock } from "../lib/time";
import { useUiStore } from "../store/uiStore";
import { HighlightText } from "./logs/HighlightText";
import { useLogBackfill } from "./logs/useLogBackfill";
import { useResizable } from "./logs/useResizable";
import {
  Badge,
  type BadgeTone,
  Button,
  CloseIcon,
  cx,
  GlassPanel,
  Input,
  SegmentedControl,
} from "./ui";

const LEVEL_TONE: Record<LogEntry["level"], BadgeTone> = {
  error: "danger",
  warn: "warn",
  info: "info",
  debug: "muted",
};
const LEVEL_TEXT: Record<LogEntry["level"], string> = {
  error: "text-danger",
  warn: "text-warn",
  info: "text-sky-300",
  debug: "text-surface-500",
};

interface LogPanelProps {
  logs: LogEntry[];
  subscribeLogs: (nodes?: string[], levels?: LogEntry["level"][]) => void;
  unsubscribeLogs: () => void;
  connected: boolean;
  /** Some provider can serve a real past window, so the range selector is worth showing. */
  canQueryLogs: boolean;
  queryLogs: (opts: LogQueryOptions) => Promise<LogEntry[]>;
}

export function LogPanel({
  logs,
  subscribeLogs,
  unsubscribeLogs,
  connected,
  canQueryLogs,
  queryLogs,
}: LogPanelProps) {
  const open = useUiStore((s) => s.logPanel.open);
  const nodeFilter = useUiStore((s) => s.logPanel.nodeFilter);
  const setOpen = useUiStore((s) => s.setLogPanelOpen);
  const setNodeFilter = useUiStore((s) => s.setLogNodeFilter);

  const [levelFilter, setLevelFilter] = useState<Set<LogEntry["level"]>>(() => new Set(LEVELS));
  const [searchText, setSearchText] = useState("");
  const [clearedAt, setClearedAt] = useState(0);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [paused, setPaused] = useState(false);
  const [range, setRange] = useState<Range>("15m");

  const bottomRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const lastClosedAt = useRef(0);

  // Subscribe while open; use the server-side node filter when the filter is a full address.
  const serverNodes = nodeFilter.includes("/") ? nodeFilter : "";
  useEffect(() => {
    if (!open || !connected) {
      return;
    }
    subscribeLogs(serverNodes ? [serverNodes] : undefined);
    return () => unsubscribeLogs();
  }, [open, connected, serverNodes, subscribeLogs, unsubscribeLogs]);

  const { loadingHistory, historyError } = useLogBackfill({
    open,
    connected,
    serverNodes,
    range,
    queryLogs,
  });
  const { panelSize, handleResizeDown } = useResizable();

  // biome-ignore lint/correctness/useExhaustiveDependencies: the effect intentionally reacts to newly appended log entries.
  useEffect(() => {
    if (open && !paused && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs.length, open, paused]);

  const handleScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) {
      return;
    }
    setPaused(el.scrollHeight - el.scrollTop - el.clientHeight >= 30);
  }, []);

  const toggleLevel = (level: LogEntry["level"]) =>
    setLevelFilter((prev) => {
      const next = new Set(prev);
      if (next.has(level)) {
        next.delete(level);
      } else {
        next.add(level);
      }
      return next;
    });

  const visibleLogs = useMemo(
    () => logs.filter((e) => e.timestamp >= clearedAt),
    [logs, clearedAt],
  );
  const filtered = useMemo(
    () => filterLogs(visibleLogs, levelFilter, nodeFilter, searchText),
    [visibleLogs, levelFilter, nodeFilter, searchText],
  );

  const copyEntry = (entry: LogEntry, idx: number) => {
    const line = `${formatClock(entry.timestamp)} [${entry.level.toUpperCase()}] ${entry.node} ${entry.message}`;
    navigator.clipboard
      .writeText(line)
      .then(() => {
        setCopiedIdx(idx);
        setTimeout(() => setCopiedIdx(null), 800);
      })
      .catch(() => {});
  };

  const close = () => {
    lastClosedAt.current = Date.now();
    setOpen(false);
  };

  const errorsSinceClosed = !open
    ? logs.filter((e) => e.level === "error" && e.timestamp > lastClosedAt.current).length
    : 0;

  if (!open) {
    return (
      <div className="absolute bottom-4 right-4 z-30">
        <Button onClick={() => setOpen(true)} title="Open logs (L)" className="!rounded-full">
          <span className="text-[11px] font-bold uppercase tracking-wider">Logs</span>
          {visibleLogs.length > 0 && (
            <span className="text-[11px] text-surface-400">{visibleLogs.length}</span>
          )}
          {errorsSinceClosed > 0 && (
            <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-white">
              {errorsSinceClosed}
            </span>
          )}
        </Button>
      </div>
    );
  }

  return (
    <GlassPanel
      variant="thick"
      className="absolute bottom-4 right-4 z-30 flex flex-col"
      style={{ width: panelSize.width, height: panelSize.height }}
    >
      <button
        type="button"
        aria-label="Resize log panel"
        onMouseDown={handleResizeDown}
        className="absolute left-1.5 top-1.5 z-10 flex h-3.5 w-3.5 cursor-nw-resize select-none items-center justify-center text-[8px] text-surface-500"
        title="Drag to resize"
      >
        ⋱
      </button>

      {/* Header */}
      <div className="mb-2 flex items-center justify-between">
        <div className="heading ml-4 flex items-center gap-2">
          Logs
          <span className="font-normal text-surface-500">{filtered.length}</span>
          {paused && <Badge tone="warn">paused</Badge>}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setClearedAt(Date.now())}
            title="Clear logs"
          >
            Clear
          </Button>
          <Button iconOnly aria-label="Close" onClick={close} title="Close (Esc)">
            <CloseIcon />
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {LEVELS.map((level) => (
          <Badge
            key={level}
            tone={LEVEL_TONE[level]}
            active={levelFilter.has(level)}
            onClick={() => toggleLevel(level)}
          >
            {level}
          </Badge>
        ))}
        <div className="ml-auto flex items-center gap-1">
          {canQueryLogs && (
            <SegmentedControl
              options={RANGES.map((r) => ({ value: r.value, label: r.label }))}
              value={range}
              onChange={setRange}
              className="mr-1"
            />
          )}
          <Input
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="Search…"
            className="!w-28 !py-1 !text-[11px]"
          />
          <div className="relative">
            <Input
              value={nodeFilter}
              onChange={(e) => setNodeFilter(e.target.value)}
              placeholder="Node…"
              className={cx("!w-36 !py-1 !text-[11px]", nodeFilter && "!pr-6")}
            />
            {nodeFilter && (
              <button
                type="button"
                onClick={() => setNodeFilter("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 cursor-pointer text-surface-400 hover:text-white"
                aria-label="Clear node filter"
              >
                <CloseIcon />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Log entries */}
      <div
        ref={listRef}
        onScroll={handleScroll}
        className="glass-scroll relative min-h-0 flex-1 overflow-y-auto font-mono text-[11px] leading-relaxed"
      >
        {filtered.length === 0 ? (
          <div className="p-5 text-center text-surface-500">
            {!connected
              ? "Not connected"
              : loadingHistory
                ? "Loading history…"
                : historyError
                  ? `History unavailable: ${historyError}`
                  : "Waiting for logs…"}
          </div>
        ) : (
          filtered.map((entry, i) => (
            <div
              key={logKey(entry)}
              className={cx(
                "flex gap-2 border-b border-white/5 px-1 py-px transition-colors hover:bg-white/5",
                copiedIdx === i && "bg-ok/20",
              )}
            >
              <span className="shrink-0 text-surface-500">{formatClock(entry.timestamp)}</span>
              <span
                className={cx(
                  "w-10 shrink-0 text-[10px] font-semibold uppercase",
                  LEVEL_TEXT[entry.level],
                )}
              >
                {entry.level}
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setNodeFilter(entry.node);
                }}
                className="max-w-36 shrink-0 cursor-pointer truncate bg-transparent p-0 text-left text-surface-400 hover:text-white"
                title={`Filter: ${entry.node}`}
              >
                {entry.node}
              </button>
              <button
                type="button"
                onClick={() => copyEntry(entry, i)}
                className="min-w-0 flex-1 cursor-pointer truncate bg-transparent p-0 text-left text-surface-200"
                title="Click to copy"
              >
                <HighlightText text={entry.message} search={searchText} />
              </button>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {paused && (
        <Button
          size="xs"
          className="mt-1 self-center"
          onClick={() => {
            setPaused(false);
            bottomRef.current?.scrollIntoView({ behavior: "smooth" });
          }}
        >
          ↓ New logs
        </Button>
      )}
    </GlassPanel>
  );
}
