import { FlowBox } from "../api";
import { calcShapes } from "../calcGeometry";
import { drawn } from "../pixelCentre";

const COLORS: [string, string] = ["#ff9f1c", "#2ec4ff"];

/**
 * Over the picture in the viewer: how a Calculate box got this picture's number. The two found boxes (turned as found),
 * their centres A and B, and the shape of the chosen operation between them (see `calcGeometry.ts`). Lines keep their
 * screen width at any zoom; every line has a dark one under it so it shows on a white part of the picture.
 */
export default function CalcGeometry({ size, op, names, clockwise, boxes, value, unit }: {
  size: { w: number; h: number };
  op: string;
  names: [string, string];
  clockwise: boolean;
  boxes: Record<string, FlowBox> | undefined;
  value: number | null;
  unit: string;
}) {
  const a = boxes?.[names[0]] && drawn(boxes[names[0]]);
  const b = boxes?.[names[1]] && drawn(boxes[names[1]]);
  const u = Math.max(size.w, size.h) / 100;
  const g = a && b ? calcShapes(op, a, b, names, clockwise, value, unit, u) : null;
  const halo = { vectorEffect: "non-scaling-stroke" as const, pointerEvents: "none" as const };
  return (
    <svg data-testid="calc-geometry" viewBox={`0 0 ${size.w} ${size.h}`} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
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
