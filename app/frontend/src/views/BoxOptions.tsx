import { useEffect, useState } from "react";
import { BOX_SIDES, FlowBoxModule } from "../api";
import { PanelSection } from "../SidePanel";

const SIDE_LABEL = { left: "Left", right: "Right", up: "Up", down: "Down" } as const;
const keyOf = (h: { detector: string; target: string }) => `${h.detector}\u0000${h.target}`;

/**
 * The right-hand options of a Box (step 2): how many detector boxes it works with (one or two), which ones (a list of the
 * boxes of step 1, no lines), whether the margins count from the box edge or its centre, and the four margins. The picture
 * with the rectangle is the page itself (`BoxWork`).
 */
export default function BoxOptions({ detail, onUpdate }: { detail: FlowBoxModule; onUpdate: (body: Record<string, unknown>) => void }) {
  const [typed, setTyped] = useState<Record<string, string>>({});
  useEffect(() => setTyped({}), [detail.margins]);
  const two = detail.mode === "two";
  const chosen = (i: number) => (detail.holes[i] ? keyOf(detail.holes[i]) : "");
  const pick = (i: number, value: string) => {
    const found = detail.candidates.find((c) => keyOf(c) === value);
    const next = [...detail.holes];
    if (!found) next.splice(i, 1);
    else next[i] = { detector: found.detector, target: found.target };
    onUpdate({ holes: next.slice(0, detail.needed).filter(Boolean) });
  };
  const commit = (side: (typeof BOX_SIDES)[number]) => {
    const text = typed[side];
    if (text === undefined) return;
    const value = Number(text);
    if (text.trim() === "" || !Number.isFinite(value)) { setTyped(({ [side]: _, ...rest }) => rest); return; }
    if (value !== detail.margins[side]) onUpdate({ margins: { [side]: value } });
    else setTyped(({ [side]: _, ...rest }) => rest);
  };
  const select = (label: string, i: number) => (
    <label>
      {label}
      <select value={chosen(i)} onChange={(e) => pick(i, e.target.value)}>
        <option value="">— choose a detector box —</option>
        {detail.candidates.map((c) => <option key={keyOf(c)} value={keyOf(c)}>{c.label}</option>)}
      </select>
    </label>
  );
  return (
    <>
      <PanelSection title="Detector boxes">
        {detail.candidates.length === 0 && <p className="muted">Step 1 has no detector box with a target yet: add a detector and its targets in step 1.</p>}
        <label>
          Works with
          <select value={detail.mode} onChange={(e) => onUpdate({ mode: e.target.value })}>
            <option value="two">Two boxes (left hole and right hole)</option>
            <option value="one">One box</option>
          </select>
        </label>
        {two ? (
          <>
            {select("Left hole", 0)}
            {select("Right hole", 1)}
            <button type="button" disabled={detail.holes.length < 2} onClick={() => onUpdate({ holes: [...detail.holes].reverse() })} title="Exchange the two holes">⇄ Swap left and right</button>
            <p className="muted">The part's own direction runs from the left hole to the right hole, so the rectangle turns with the part and "up" and "down" follow it.</p>
          </>
        ) : (
          <>
            {select("Box", 0)}
            <p className="muted">The rectangle takes the direction of this box (its angle).</p>
          </>
        )}
        {detail.stale.length > 0 && <p role="status">⚠ {detail.stale.join(", ")} changed since it last ran in step 1: run it again, the boxes here are the old ones.</p>}
      </PanelSection>
      <PanelSection title="Margins">
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="muted">Measure from</legend>
          {(["edge", "centre"] as const).map((m) => (
            <label key={m} className="flow-check">
              <input type="radio" name="box-measure" checked={detail.measure_from === m} onChange={() => onUpdate({ measure_from: m })} />{" "}
              {m === "edge" ? "The box edge (the background beyond it)" : "The box centre"}
            </label>
          ))}
        </fieldset>
        {BOX_SIDES.map((side) => (
          <label key={side}>
            {SIDE_LABEL[side]} (px)
            <input
              type="number"
              step="1"
              value={typed[side] ?? String(detail.margins[side])}
              onChange={(e) => setTyped((t) => ({ ...t, [side]: e.target.value }))}
              onBlur={() => commit(side)}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            />
          </label>
        ))}
        <p className="muted">
          {two ? "Left and right count from the two holes; up and down from both. " : ""}
          Each number is measured in the part's own direction. A negative number moves the edge inside.
        </p>
      </PanelSection>
      <PanelSection title="Result">
        <p>
          {detail.inputs.length === 0
            ? "Works on every picture of the camera. Draw Ingest OK and Ingest NG into this Box (its left dot) to limit it to the pictures of the freeze."
            : `Works on the pictures of ${detail.inputs.map((i) => (i.startsWith("inok") ? "Ingest OK" : "Ingest NG")).join(" and ")}.`}
        </p>
        <p>{detail.frames.length} of {detail.total} pictures have a rectangle.</p>
        <p className="muted">The Box gives one upright rectangle per picture (the turned one squared off). Draw its dot onto a Classifier in step 2.</p>
      </PanelSection>
    </>
  );
}
