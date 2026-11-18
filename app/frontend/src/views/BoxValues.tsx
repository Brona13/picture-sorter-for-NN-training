/**
 * The box values of one detector target (v1.172.0, phase 4 of `plans/detector-review-views.md`): the match score of
 * every found box with a threshold (below it is weak), or its angle with a nominal ± tolerance band (wrapping, only
 * when the detector searches turned). The Evaluation histogram draws both. Review aids like the zones: saved on the
 * detector box, never make its run stale; pictures that break them join *Outside* and the attention order.
 */
import { FlowBox, FlowBoxRule } from "../api";
import { boxScore, clockAngle } from "../attention";
import { densestValue } from "../density";
import { EvaluationHistogram, histogramOf } from "./FlowBoxPanel";

export type BoxMeasure = "score" | "angle";

/** The value a measure reads off a box. */
export const boxValue = (b: FlowBox, measure: BoxMeasure) => (measure === "score" ? boxScore(b) : clockAngle(b.angle));

export default function BoxValues({ slot, measure, values, rule, save, range, onRange }: {
  slot: string;
  measure: BoxMeasure;
  /** The measure's value per picture where the target was found. */
  values: number[];
  rule: FlowBoxRule | undefined;
  save: (change: { score_min?: number | null; angle?: { nominal: number; tolerance: number } | null }) => void;
  range: [number, number] | null;
  onRange: (range: [number, number] | null) => void;
}) {
  const wrap = measure === "angle";
  const band = rule?.angle ?? null;
  const threshold = rule?.score_min ?? null;
  const histogram = histogramOf(values, wrap);
  const broken = measure === "score"
    ? threshold == null ? null : values.filter((v) => v < threshold).length
    : band == null ? null : values.filter((v) => { const d = (((v - band.nominal + 180) % 360) + 360) % 360 - 180; return Math.abs(d) > band.tolerance + 1e-9; }).length;
  return (
    <>
      <div className="flow-nav">
        {measure === "angle" && (
          <button type="button" title="Take the densest angle as the nominal (the band keeps its tolerance, 5° to start)" onClick={() => { const v = densestValue(values, true); if (v !== null) save({ angle: { nominal: Number(v.toFixed(2)), tolerance: band?.tolerance ?? 5 } }); }}>
            Use densest value as nominal
          </button>
        )}
        {measure === "score" && threshold != null && <button type="button" onClick={() => save({ score_min: null })}>Remove threshold</button>}
        {measure === "angle" && band && <button type="button" onClick={() => save({ angle: null })}>Remove band</button>}
      </div>
      <EvaluationHistogram
        label="Histogram of the box values"
        detail={{ histogram, nominal: band?.nominal ?? null, tolerance: band?.tolerance ?? 0, wrap, unit: measure === "angle" ? "deg" : "" }}
        values={values}
        range={range}
        onRange={onRange}
        onPick={(v) => (measure === "score" ? save({ score_min: Math.min(1, Math.max(0, v)) }) : save({ angle: { nominal: v, tolerance: band?.tolerance ?? 5 } }))}
        onBand={(b) => save({ angle: { nominal: b.nominal, tolerance: b.tolerance } })}
        {...(measure === "score" ? { threshold, onThreshold: (v: number) => save({ score_min: Math.min(1, Math.max(0, v)) }) } : {})}
      />
      <p role="status" data-testid="box-value-count" style={{ margin: "4px 0 0" }}>
        {broken === null
          ? `${values.length} found · ${measure === "score" ? "click a bar to set the threshold: a match below it is weak" : "click a bar or use the densest value to set the nominal"}`
          : <><strong>{broken}</strong> of {values.length} {measure === "score" ? "below the threshold" : "outside the band"}</>}
        {` · ${slot}`}
      </p>
    </>
  );
}
