import { logKey } from "@proxy/logKey";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LogEntry } from "../domain/types";
import type { LogQueryOptions } from "../hooks/useTelemetryStream";
import { formatClock } from "../lib/time";
import { useUiStore } from "../store/uiStore";
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

const LEVELS: LogEntry["level"][] = ["error", "warn", "info", "debug"];
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

/** How far back the panel asks for history when it opens. */
const RANGES = [
  { value: "15m", label: "15m", ms: 15 * 60_000 },
  { value: "1h", label: "1h", ms: 60 * 60_000 },
  { value: "24h", label: "24h", ms: 24 * 60 * 60_000 },
] as const;
type Range = (typeof RANGES)[number]["value"];

/** Cap on a single backfill, matched to the proxy's own ceiling. */
const BACKFILL_LIMIT = 1_000;

const MIN_W = 320;
const MIN_H = 200;
const DEFAULT_W = 560;
const DEFAULT_H = 400;

interface LogPanelProps {
  logs: LogEntry[];
  subscribeLogs: (nodes?: string[], levels?: LogEntry["level"][]) => void;
  unsubscribeLogs: () => void;
  connected: boolean;
  /** Some provider can serve a real past window, so the range selector is worth showing. */
  canQueryLogs: boolean;
  queryLogs: (opts: LogQueryOptions) => Promise<LogEntry[]>;
}

function HighlightText({ text, search }: { text: string; search: string }) {
  if (!search) {
    return <>{text}</>;
  }
  const idx = text.toLowerCase().indexOf(search.toLowerCase());
  if (idx === -1) {
    return <>{text}</>;
  }
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded-sm bg-warn/30 px-px text-warn">
        {text.slice(idx, idx + search.length)}
      </mark>
      {text.slice(idx + search.length)}
    </>
  );
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
  const [panelSize, setPanelSize] = useState({ width: DEFAULT_W, height: DEFAULT_H });
  const [range, setRange] = useState<Range>("15m");
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const lastClosedAt = useRef(0);
  const dragRef = useRef<{ startX: number; startY: number; startW: number; startH: number } | null>(
    null,
  );

  // Subscribe while open; use the server-side node filter when the filter is a full address.
  const serverNodes = nodeFilter.includes("/") ? nodeFilter : "";
  useEffect(() => {
    if (!open || !connected) {
      return;
    }
    subscribeLogs(serverNodes ? [serverNodes] : undefined);
    return () => unsubscribeLogs();
  }, [open, connected, serverNodes, subscribeLogs, unsubscribeLogs]);

  /**
   * Backfill on open, and whenever the node filter or the range changes.
   *
   * Deliberately not keyed on `levelFilter`: levels are already applied client-side, and a
   * round-trip on every badge click would buy nothing. Resolved entries are merged into
   * `logs` by the stream hook, so there is nothing to do with them here.
   */
  useEffect(() => {
    if (!open || !connected) {
      return;
    }
    let cancelled = false;
    const rangeMs = RANGES.find((r) => r.value === range)?.ms ?? RANGES[0].ms;

    setLoadingHistory(true);
    setHistoryError(null);
    queryLogs({
      nodes: serverNodes ? [serverNodes] : undefined,
      since: Date.now() - rangeMs,
      limit: BACKFILL_LIMIT,
    })
      .catch((err: Error) => {
        if (!cancelled) {
          setHistoryError(err.message);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingHistory(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, connected, serverNodes, range, queryLogs]);

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

  const handleResizeDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        startW: panelSize.width,
        startH: panelSize.height,
      };
      const onMove = (ev: MouseEvent) => {
        if (!dragRef.current) {
          return;
        }
        const dw = dragRef.current.startX - ev.clientX;
        const dh = dragRef.current.startY - ev.clientY;
        setPanelSize({
          width: Math.max(MIN_W, Math.min(window.innerWidth * 0.9, dragRef.current.startW + dw)),
          height: Math.max(MIN_H, Math.min(window.innerHeight * 0.8, dragRef.current.startH + dh)),
        });
      };
      const onUp = () => {
        dragRef.current = null;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [panelSize],
  );

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
  const filtered = useMemo(() => {
    const nf = nodeFilter.toLowerCase();
    const s = searchText.toLowerCase();
    return visibleLogs.filter((entry) => {
      if (!levelFilter.has(entry.level)) {
        return false;
      }
      if (nf && !entry.node.toLowerCase().includes(nf)) {
        return false;
      }
      if (s && !entry.message.toLowerCase().includes(s) && !entry.node.toLowerCase().includes(s)) {
        return false;
      }
      return true;
    });
  }, [visibleLogs, levelFilter, nodeFilter, searchText]);

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
