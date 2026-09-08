import { useMemo } from "react";

export function Sparkline({
  values,
  width = 120,
  height = 32,
  color = "currentColor",
  min,
  max,
}: {
  values: (number | undefined)[];
  width?: number;
  height?: number;
  color?: string;
  min?: number;
  max?: number;
}) {
  const { path, area, last } = useMemo(() => {
    const pts = values
      .map((v, i) => (v == null ? null : ([i, v] as const)))
      .filter((p): p is readonly [number, number] => p !== null);
    if (pts.length < 2) {
      return { path: "", area: "", last: null as null | [number, number] };
    }
    const lo = min ?? Math.min(...pts.map((p) => p[1]));
    const hi0 = max ?? Math.max(...pts.map((p) => p[1]));
    const hi = hi0 === lo ? lo + 1 : hi0;
    const n = Math.max(values.length - 1, 1);
    const pad = 2;
    const sx = (i: number) => pad + (i / n) * (width - pad * 2);
    const sy = (v: number) => height - pad - ((v - lo) / (hi - lo)) * (height - pad * 2);
    const coords = pts.map(([i, v]) => `${sx(i).toFixed(1)},${sy(v).toFixed(1)}`);
    const path = `M${coords.join("L")}`;
    const first = pts[0]!;
    const end = pts[pts.length - 1]!;
    const area = `${path}L${sx(end[0]).toFixed(1)},${height}L${sx(first[0]).toFixed(1)},${height}Z`;
    return { path, area, last: [sx(end[0]), sy(end[1])] as [number, number] };
  }, [values, width, height, min, max]);

  if (!path) {
    return (
      <svg aria-hidden="true" width={width} height={height} className="opacity-30">
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke={color}
          strokeDasharray="2 3"
        />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" width={width} height={height} style={{ color }}>
      <path d={area} fill="currentColor" opacity={0.12} />
      <path d={path} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" />
      {last && <circle cx={last[0]} cy={last[1]} r={2} fill="currentColor" />}
    </svg>
  );
}
