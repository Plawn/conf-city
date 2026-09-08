import { cx } from "./ui";

export function ConnectionStatus({
  connected,
  providerCount,
}: {
  connected: boolean;
  providerCount: number;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={cx(
          "h-2 w-2 rounded-full",
          connected ? "bg-ok shadow-[0_0_6px_var(--color-ok)]" : "bg-surface-500",
        )}
      />
      <span
        className={cx(
          "text-[11px] font-semibold uppercase tracking-wide",
          connected ? "text-ok" : "text-surface-500",
        )}
      >
        {connected ? `Live${providerCount > 0 ? ` (${providerCount})` : ""}` : "Static"}
      </span>
    </span>
  );
}
