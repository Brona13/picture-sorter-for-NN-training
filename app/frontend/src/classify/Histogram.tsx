const W = 360;
const H = 110;
const PAD = { l: 8, r: 8, t: 6, b: 22 };

const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1));

/**
 * A small histogram with the suggested range (dashed blue) and the chosen range (orange) marked.
 * ``edges`` has one more entry than ``counts``.
 */
export default function Histogram({
  title,
  unit,
  edges,
  counts,
  suggested,
  chosen,
}: {
  title: string;
  unit: string;
  edges: number[];
  counts: number[];
  suggested: [number, number] | null;
  chosen: [number, number] | null;
}) {
  const lo = Math.min(edges[0], chosen?.[0] ?? edges[0], suggested?.[0] ?? edges[0]);
  const hi = Math.max(edges[edges.length - 1], chosen?.[1] ?? edges[edges.length - 1], suggested?.[1] ?? edges[edges.length - 1]);
  const span = hi - lo || 1;
  const x = (v: number) => PAD.l + ((v - lo) / span) * (W - PAD.l - PAD.r);
  const peak = Math.max(1, ...counts);
  const plotH = H - PAD.t - PAD.b;
  const mark = (range: [number, number], colour: string, dash: string | undefined, id: string) =>
    range.map((v, i) => <line key={`${id}${i}`} data-testid={`${id}-${i}`} x1={x(v)} x2={x(v)} y1={PAD.t} y2={H - PAD.b} stroke={colour} strokeWidth={2} strokeDasharray={dash} />);
  return (
    <figure style={{ margin: 0 }}>
      <svg role="img" aria-label={`${title} histogram`} viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxWidth: W, border: "1px solid var(--border, #ccc)" }}>
        {counts.map((c, i) => (
          <rect
            key={i}
            data-testid="bar"
            x={x(edges[i])}
            y={PAD.t + plotH - (c / peak) * plotH}
            width={Math.max(1, x(edges[i + 1]) - x(edges[i]) - 1)}
            height={(c / peak) * plotH}
            fill="#6b7280"
          />
        ))}
        {suggested && mark(suggested, "#1a73e8", "4 3", "suggested")}
        {chosen && mark(chosen, "#ff9800", undefined, "chosen")}
        <line x1={PAD.l} x2={W - PAD.r} y1={H - PAD.b} y2={H - PAD.b} stroke="currentColor" strokeWidth={1} />
        <text x={PAD.l} y={H - 6} fontSize={10} fill="currentColor">
          {fmt(lo)}
        </text>
        <text x={W - PAD.r} y={H - 6} fontSize={10} fill="currentColor" textAnchor="end">
          {fmt(hi)} {unit}
        </text>
      </svg>
      <figcaption style={{ fontSize: 12 }}>{title}</figcaption>
    </figure>
  );
}
