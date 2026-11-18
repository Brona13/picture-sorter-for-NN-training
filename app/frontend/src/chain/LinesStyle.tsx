import WheelRange from "../WheelRange";
import { CURVATURE_RANGE, LINE_SHAPES, LineShape, LineStyle, OFFSET_RANGE, RADIUS_RANGE } from "./lineStyle";

/** The Chain's right pane: how the lines are drawn, with the one setting each style has. Only the look; no line changes. */
export default function LinesStyle({ style, onChange }: { style: LineStyle; onChange: (next: LineStyle) => void }) {
  const rounded = style.shape === "rounded";
  const angled = rounded || style.shape === "right-angle";
  return (
    <div className="chain-lines" data-testid="lines-style">
      <label>
        Line style
        <select aria-label="Line style" value={style.shape} onChange={(e) => onChange({ ...style, shape: e.target.value as LineShape })}>
          {LINE_SHAPES.map((s) => <option key={s.value} value={s.value} title={s.hint}>{s.label}</option>)}
        </select>
      </label>
      {rounded && (
        <label>
          Corner radius: {style.radius} px
          <WheelRange aria-label="Corner radius" {...RADIUS_RANGE} value={style.radius} onValue={(radius) => onChange({ ...style, radius })} />
        </label>
      )}
      {angled && (
        <label title="How far a line leaves its dot before it turns">
          Distance before the first bend: {style.offset} px
          <WheelRange aria-label="Distance before the first bend" {...OFFSET_RANGE} value={style.offset} onValue={(offset) => onChange({ ...style, offset })} />
        </label>
      )}
      {style.shape === "curved" && (
        <label>
          Curvature: {style.curvature.toFixed(2)}
          <WheelRange aria-label="Curvature" {...CURVATURE_RANGE} value={style.curvature} onValue={(curvature) => onChange({ ...style, curvature })} />
        </label>
      )}
    </div>
  );
}
