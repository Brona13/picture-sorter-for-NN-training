/**
 * The pair map of a detector page (v1.170.0): two of the detector's targets measured like a Calculate box (angle,
 * distance, dx, dy or the Offset of B from A) and judged like an Evaluation (nominal ± tolerance on the histogram, or a
 * zone on the Offset chart), with the same charts. A review aid only: saved on the detector box, never makes its run
 * stale, decides nothing downstream. The page loads the state (`api.flowPair`) and uses its verdicts for *Outside* and
 * the histogram's zoomed range to narrow its pictures.
 */
import { FlowPair, FlowPairState, FlowZone } from "../api";
import { densestSpot, densestValue } from "../density";
import { EvaluationHistogram } from "./FlowBoxPanel";
import { HeatChoice, HeatControls } from "./heatChoice";
import ZoneScatter from "./ZoneScatter";

export default function PairMap({ slots, state, save, heatChoice, range, onRange }: {
  /** The target slots that can be A or B (the ones with examples). */
  slots: string[];
  state: FlowPairState | null;
  /** Saves some fields of the pair, or removes it with null. */
  save: (pair: Partial<Omit<FlowPair, "zone">> & { zone?: Partial<FlowZone> } | null) => void;
  heatChoice: HeatChoice;
  range: [number, number] | null;
  onRange: (range: [number, number] | null) => void;
}) {
  const pair = state?.pair ?? null;
  const ops = state?.operations ?? { distance: "Distance A to B" };
  if (!pair) {
    return (
      <div className="flow-nav">
        <span className="muted">Measure two targets against each other, as a Calculate and an Evaluation box would, for review only.</span>
        <button type="button" disabled={slots.length < 2} onClick={() => save({ a: slots[0], b: slots[1], op: "distance" })}>
          Measure {slots[0]} → {slots[1] ?? "…"}
        </button>
      </div>
    );
  }
  const zoneMode = state!.mode === "zone";
  const numbers = Object.values(state!.values).filter((v): v is number => v !== null);
  const points = Object.values(state!.points).filter((q): q is [number, number] => !!q);
  const missing = Object.values(state!.values).filter((v) => v === null).length;
  const judged = state!.counts.pass + state!.counts.fail;
  const set = zoneMode ? !!pair.zone.center : pair.nominal != null;
  const densest = () => {
    if (zoneMode) {
      const spot = densestSpot(points, heatChoice.smoothing);
      if (spot) save({ zone: { center: [Math.round(spot[0] * 10) / 10, Math.round(spot[1] * 10) / 10] } });
    } else {
      const v = densestValue(numbers, state!.wrap);
      if (v !== null) save({ nominal: Number(v.toFixed(2)) });
    }
  };
  return (
    <>
      <div className="flow-nav">
        <label>A <select aria-label="Pair A" value={pair.a} onChange={(e) => save({ a: e.target.value })}>{slots.map((s) => <option key={s} value={s} disabled={s === pair.b}>{s}</option>)}</select></label>
        <label>B <select aria-label="Pair B" value={pair.b} onChange={(e) => save({ b: e.target.value })}>{slots.map((s) => <option key={s} value={s} disabled={s === pair.a}>{s}</option>)}</select></label>
        <label>
          Operation{" "}
          <select aria-label="Pair operation" value={pair.op} onChange={(e) => save({ op: e.target.value })}>
            {Object.entries(ops).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </label>
        {pair.op === "angle" && (
          <label><input type="checkbox" checked={pair.clockwise} onChange={(e) => save({ clockwise: e.target.checked })} /> clockwise</label>
        )}
        {zoneMode && <HeatControls choice={heatChoice} />}
        <button type="button" title={zoneMode ? "Take the densest spot (the red top of the heat map) as the zone centre" : "Take the densest value as the nominal"} onClick={densest}>
          {zoneMode ? "Use densest spot as nominal" : "Use densest value as nominal"}
        </button>
        {zoneMode && set && (
          <span className="flow-segment" role="group" aria-label="Pair zone shape">
            <button type="button" aria-pressed={pair.zone.shape === "circle"} onClick={() => save({ zone: { shape: "circle" } })}>Circle</button>
            <button type="button" aria-pressed={pair.zone.shape === "rect"} onClick={() => save({ zone: { shape: "rect" } })}>Rectangle</button>
          </span>
        )}
        <button type="button" onClick={() => save(null)}>Remove pair</button>
      </div>
      {zoneMode ? (
        <ZoneScatter
          points={state!.points}
          zone={pair.zone}
          onZone={(z) => save({ zone: z })}
          onCentre={(at) => save({ zone: { center: at } })}
          heat={heatChoice.heatOn ? { points, smoothing: heatChoice.smoothing } : null}
        />
      ) : (
        <EvaluationHistogram
          detail={{ histogram: state!.histogram, nominal: pair.nominal, tolerance: pair.tolerance, wrap: state!.wrap, unit: state!.unit }}
          values={numbers}
          range={range}
          onRange={onRange}
          onPick={(v) => save({ nominal: v })}
          onBand={(b) => save({ nominal: b.nominal, tolerance: b.tolerance })}
        />
      )}
      <p role="status" data-testid="pair-count" style={{ margin: "4px 0 0" }}>
        {set ? <><strong>{state!.counts.fail}</strong> of {judged} outside {zoneMode ? "the zone" : "the band"}</> : `${numbers.length} measured · ${zoneMode ? "click a dot or use the densest spot to set the nominal" : "click a bar or use the densest value to set the nominal"}`}
        {missing > 0 ? ` · ${missing} not measured (A or B not found)` : ""}
      </p>
    </>
  );
}
