import { FlowBox } from "../api";
import { calcShapes } from "../calcGeometry";
import { EvalSpec, evalLayer } from "../evalGeometry";
import { drawn } from "../pixelCentre";

const COLORS: [string, string] = ["#ff9f1c", "#2ec4ff"];
const VERDICT_COLORS: Record<string, string> = { pass: "#3ccf6e", fail: "#ff5b5b" };

/**
 * Over the picture in the viewer: how a Calculate box got this picture's number. The two found boxes (turned as found),
 * their centres A and B, and the shape of the chosen operation between them (see `calcGeometry.ts`). Lines keep their
 * screen width at any zoom; every line has a dark one under it so it shows on a white part of the picture.
 * On the Evaluation page `evaluation` adds the pass region of its rule (`evalGeometry.ts`) under the rest, in the colour
 * of this picture's verdict, and a ring in that colour around B.
 */
export default function CalcGeometry({ size, op, names, clockwise, boxes, value, unit, evaluation }: {
  size: { w: number; h: number };
  op: string;
  names: [string, string];
  clockwise: boolean;
  boxes: Record<string, FlowBox> | undefined;
  value: number | null;
  unit: string;
  evaluation?: { spec: EvalSpec; verdict?: string };
}) {
  const a = boxes?.[names[0]] && drawn(boxes[names[0]]);
  const b = boxes?.[names[1]] && drawn(boxes[names[1]]);
  const u = Math.max(size.w, size.h) / 100;
  const g = a && b ? calcShapes(op, a, b, names, clockwise, value, unit, u) : null;
  const layer = evaluation && a && b ? evalLayer(evaluation.spec, a, b, size, value, u) : null;
  const tint = (evaluation?.verdict && VERDICT_COLORS[evaluation.verdict]) || "#c9ced6";
  const halo = { vectorEffect: "non-scaling-stroke" as const, pointerEvents: "none" as const };
  return (
    <svg data-testid="calc-geometry" viewBox={`0 0 ${size.w} ${size.h}`} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
      {layer && (
        <g data-testid="evaluation-geometry" data-verdict={evaluation?.verdict ?? "none"}>
          {layer.regions.map((r, i) => <path key={`r${i}`} d={r.d} fillRule={r.evenodd ? "evenodd" : undefined} fill={tint} fillOpacity={0.16} stroke="none" />)}
          {layer.paths.map((p, i) => (
            <g key={`p${i}`}>
              <path d={p.d} fill="none" stroke="rgba(0,0,0,.75)" strokeWidth={4} strokeDasharray={p.dashed ? "6 4" : undefined} {...halo} />
              <path d={p.d} fill="none" stroke={tint} strokeWidth={2} strokeDasharray={p.dashed ? "6 4" : undefined} {...halo} />
            </g>
          ))}
          {layer.segments.map((s, i) => (
            <g key={`e${i}`}>
              <line x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke="rgba(0,0,0,.75)" strokeWidth={4} strokeDasharray={s.dashed ? "6 4" : undefined} {...halo} />
              <line x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke={tint} strokeWidth={2} strokeDasharray={s.dashed ? "6 4" : undefined} {...halo} />
            </g>
          ))}
          {layer.labels.map((l, i) => (
            <text key={`el${i}`} x={l.x} y={l.y} textAnchor={l.anchor} fontSize={2 * u} fontWeight={700} fill={tint} stroke="#000" strokeWidth={3.5} paintOrder="stroke" strokeLinejoin="round">{l.text}</text>
          ))}
          {b && <circle cx={b.x} cy={b.y} r={1.4 * u} fill="none" stroke={tint} strokeWidth={2.5} vectorEffect="non-scaling-stroke" />}
        </g>
      )}
      {names.map((n, i) => {
        const box = i === 0 ? a : b;
        if (!box) return null;
        return (
          <g key={n} transform={`translate(${box.x} ${box.y}) rotate(${-box.angle})`}>
            <rect x={-box.w / 2} y={-box.h / 2} width={box.w} height={box.h} fill="none" stroke="rgba(0,0,0,.75)" strokeWidth={4} {...halo} />
            <rect x={-box.w / 2} y={-box.h / 2} width={box.w} height={box.h} fill="none" stroke={COLORS[i]} strokeWidth={2} {...halo} />
          </g>
        );
      })}
      {g?.segments.map((s, i) => (
        <g key={`s${i}`}>
          <line x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke="rgba(0,0,0,.75)" strokeWidth={s.strong ? 5 : 4} strokeDasharray={s.dashed ? "6 4" : undefined} {...halo} />
          <line x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke="#ffe066" strokeWidth={s.strong ? 3 : 2} strokeDasharray={s.dashed ? "6 4" : undefined} {...halo} />
        </g>
      ))}
      {g?.arcs.map((arc, i) => (
        <g key={`a${i}`}>
          <path d={arc.d} fill="none" stroke="rgba(0,0,0,.75)" strokeWidth={5} {...halo} />
          <path d={arc.d} fill="none" stroke="#ffe066" strokeWidth={3} {...halo} />
        </g>
      ))}
      {g?.dots.map((d, i) => (
        <g key={`d${i}`}>
          <circle cx={d.x} cy={d.y} r={0.7 * u} fill={COLORS[i]} stroke="#000" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          <text x={d.x + 1.2 * u} y={d.y - 1.2 * u} fontSize={1.8 * u} fill={COLORS[i]} stroke="#000" strokeWidth={3} paintOrder="stroke" strokeLinejoin="round">{d.name}</text>
        </g>
      ))}
      {g?.labels.map((l, i) => (
        <text key={`l${i}`} x={l.x} y={l.y} textAnchor={l.anchor} fontSize={2.2 * u} fontWeight={700} fill="#ffe066" stroke="#000" strokeWidth={3.5} paintOrder="stroke" strokeLinejoin="round">{l.text}</text>
      ))}
    </svg>
  );
}
