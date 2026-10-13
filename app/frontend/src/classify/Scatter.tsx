import { ScatterPoint } from "../api";
import { classColor, clusterColor } from "./colors";
import { layoutPoints } from "./scatterLayout";

const W = 720;
const H = 420;

export default function Scatter({ points, classes }: { points: ScatterPoint[]; classes: string[] }) {
  const placed = layoutPoints(points, W, H);
  return (
    <svg role="img" aria-label="2D scatter of clusters" viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxWidth: W, border: "1px solid #ddd" }}>
      {placed.map((p) => (
        <g key={p.frame} data-testid={`pt-${p.frame}`}>
          <title>{`${p.frame} — ${p.cluster < 0 ? "unique" : `cluster ${p.cluster}`}${p.representative ? " (representative)" : ""}${p.golden ? ` — golden ${p.golden}` : ""}`}</title>
          {p.golden ? (
            <rect
              x={p.px - 6}
              y={p.py - 6}
              width={12}
              height={12}
              transform={`rotate(45 ${p.px} ${p.py})`}
              fill={classColor(p.golden, classes)}
              stroke="#fff"
              strokeWidth={1.5}
            />
          ) : (
            <circle cx={p.px} cy={p.py} r={p.cluster < 0 ? 3.5 : 4.5} fill={p.cluster < 0 ? "rgba(120,120,120,.6)" : clusterColor(p.cluster)} />
          )}
          {p.representative && <circle cx={p.px} cy={p.py} r={8} fill="none" stroke="#111" strokeWidth={2} />}
        </g>
      ))}
    </svg>
  );
}
