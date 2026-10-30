import { useState } from "react";
import { DedupSweep } from "../api";
import { lastSession } from "../lastSession";

const W = 760;
const H = 280;
const M = { l: 46, r: 46, t: 30, b: 34 };
const COLOURS = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#0891b2", "#db2777", "#4b5563", "#65a30d"];

/** An axis that ends on a round number, with about four steps. */
export function niceAxis(max: number): { top: number; ticks: number[] } {
  if (!(max > 0)) return { top: 1, ticks: [0, 1] };
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  const ticks: number[] = [];
  for (let v = 0; v < max + step * 0.999; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { top: ticks[ticks.length - 1], ticks };
}

/** Index of the Epsilon nearest to a chart-space x. */
export function nearestIndex(xs: number[], at: number): number {
  let best = 0;
  xs.forEach((x, i) => {
    if (Math.abs(x - at) < Math.abs(xs[best] - at)) best = i;
  });
  return best;
}

type Series = { mp: number; kind: "clusters" | "would_mute"; values: (number | null)[] };

/**
 * The sweep of one Dedup box: clusters (solid, left axis) and frames that would be muted (dashed, right axis) over Epsilon, one colour
 * per Min points. Clicking picks the nearest Epsilon and the line nearest to the click; the peak is ringed, the current Epsilon marked.
 */
export default function DedupSweepChart({
  sweep,
  epsilon,
  minPoints,
  method,
  onPick,
}: {
  sweep: DedupSweep;
  epsilon: number;
  minPoints: number;
  method: string;
  onPick: (epsilon: number, minPoints: number) => void;
}) {
  const [open, setOpen] = useState(lastSession.sweepOpen());
  const [hover, setHover] = useState<number | null>(null);
  const eps = sweep.epsilons;
  const lo = eps[0];
  const hi = eps[eps.length - 1];
  const colour = (mp: number) => COLOURS[Math.max(0, sweep.min_points.indexOf(mp)) % COLOURS.length];
  const series: Series[] = sweep.lines.flatMap((l) => [
    { mp: l.min_points, kind: "clusters" as const, values: l.clusters },
    { mp: l.min_points, kind: "would_mute" as const, values: l.would_mute },
  ]);
  const maxOf = (kind: Series["kind"]) => Math.max(0, ...series.filter((s) => s.kind === kind).flatMap((s) => s.values.map((v) => v ?? 0)));
  const left = niceAxis(maxOf("clusters"));
  const right = niceAxis(maxOf("would_mute"));
  const x = (e: number) => M.l + (hi === lo ? 0.5 : (e - lo) / (hi - lo)) * (W - M.l - M.r);
  const yOf = (kind: Series["kind"], v: number) => {
    const top = kind === "clusters" ? left.top : right.top;
    return H - M.b - (v / top) * (H - M.t - M.b);
  };
  const path = (s: Series) => {
    let d = "";
    let pen = false;
    s.values.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(eps[i]).toFixed(1)} ${yOf(s.kind, v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const xTicks = eps.filter((_, i) => i % Math.max(1, Math.ceil(eps.length / 8)) === 0);

  function at(ev: { clientX: number; clientY: number; currentTarget: SVGSVGElement }) {
    const r = ev.currentTarget.getBoundingClientRect();
    const sx = r.width ? W / r.width : 1;
    const sy = r.height ? H / r.height : 1;
    const px = (ev.clientX - r.left) * sx;
    const py = (ev.clientY - r.top) * sy;
    const i = nearestIndex(eps.map(x), px);
    return { i, py };
  }

  function pick(ev: React.MouseEvent<SVGSVGElement>) {
    const { i, py } = at(ev);
    let best: { mp: number; d: number } | null = null;
    for (const s of series) {
      const v = s.values[i];
      if (v === null) continue;
      const d = Math.abs(yOf(s.kind, v) - py);
      if (best === null || d < best.d) best = { mp: s.mp, d };
    }
    if (best) onPick(eps[i], best.mp);
  }

  const shown = hover ?? nearestIndex(eps, epsilon);
  const peak = sweep.peak;
  const peakLine = peak && sweep.lines.find((l) => l.min_points === peak.min_points);
  const peakAt = peak ? eps.indexOf(peak.epsilon) : -1;

  return (
    <details
      className="sweep-chart"
      data-testid="sweep-chart"
      open={open}
      onToggle={(e) => {
        const o = (e.currentTarget as HTMLDetailsElement).open;
        if (o !== open) {
          setOpen(o);
          lastSession.setSweepOpen(o);
        }
      }}
    >
      <summary>
        Sweep chart
        <span className="sweep-sub">
          {" "}
          · {sweep.frames} pictures · {sweep.method}
          {peak ? ` · peak ${peak.clusters} clusters at ε ${peak.epsilon.toFixed(3)}, min points ${peak.min_points}` : " · nothing clusters in this range"}
        </span>
      </summary>
      {sweep.method !== method && (
        <p role="note" className="sweep-note">
          Calculated with {sweep.method}; the Embedding now is {method}.
        </p>
      )}
      <svg
        role="img"
        aria-label="Clusters and frames that would be muted over Epsilon"
        viewBox={`0 0 ${W} ${H}`}
        className="sweep-svg"
        onClick={pick}
        onMouseMove={(ev) => setHover(at(ev).i)}
        onMouseLeave={() => setHover(null)}
      >
        {left.ticks.map((t) => (
          <g key={`l${t}`}>
            <line x1={M.l} x2={W - M.r} y1={yOf("clusters", t)} y2={yOf("clusters", t)} className="sweep-grid" />
            <text x={M.l - 6} y={yOf("clusters", t) + 4} textAnchor="end" className="sweep-tick">
              {t}
            </text>
          </g>
        ))}
        {right.ticks.map((t) => (
          <text key={`r${t}`} x={W - M.r + 6} y={yOf("would_mute", t) + 4} className="sweep-tick">
            {t}
          </text>
        ))}
        {xTicks.map((e) => (
          <text key={e} x={x(e)} y={H - M.b + 16} textAnchor="middle" className="sweep-tick">
            {e.toFixed(3)}
          </text>
        ))}
        <text x={12} y={14} className="sweep-axis">
          clusters
        </text>
        <text x={W - 12} y={14} textAnchor="end" className="sweep-axis">
          would mute
        </text>
        <text x={(M.l + W - M.r) / 2} y={H - 4} textAnchor="middle" className="sweep-axis">
          Epsilon
        </text>
        {epsilon >= lo && epsilon <= hi && <line data-testid="sweep-current" x1={x(epsilon)} x2={x(epsilon)} y1={M.t} y2={H - M.b} className="sweep-current" />}
        {series.map((s) => (
          <path
            key={`${s.mp}${s.kind}`}
            d={path(s)}
            fill="none"
            stroke={colour(s.mp)}
            strokeWidth={s.mp === minPoints ? 2.6 : 1.6}
            strokeDasharray={s.kind === "would_mute" ? "5 3" : undefined}
          />
        ))}
        {peak && peakLine && peakAt >= 0 && <circle data-testid="sweep-peak" cx={x(peak.epsilon)} cy={yOf("clusters", peak.clusters)} r={6} className="sweep-peak" />}
      </svg>
      <div className="sweep-legend">
        {sweep.lines.map((l) => (
          <span key={l.min_points}>
            <i style={{ background: colour(l.min_points) }} /> Min points {l.min_points}
          </span>
        ))}
        <span>solid = clusters (left axis) · dashed = would mute (right axis)</span>
      </div>
      <p className="sweep-readout" data-testid="sweep-readout">
        ε {eps[shown].toFixed(3)}
        {sweep.lines.map((l) => (
          <span key={l.min_points} style={{ color: colour(l.min_points) }}>
            {" "}
            · min {l.min_points}: {l.clusters[shown] ?? "–"} clusters, {l.would_mute[shown] ?? "–"} would mute
          </span>
        ))}
      </p>
    </details>
  );
}
