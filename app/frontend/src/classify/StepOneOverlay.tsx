/**
 * The step-1 measurements over a picture of a step-2 Classifier (v1.164.0, `step_two_measures.py`): every step-1
 * Evaluation draws what its rule judges (zone, angle wedge, distance ring, dx / dy band) with box B and its centre, in
 * the colour of this picture's verdict. No numbers and no names: the drawing says whether B is where it should be.
 * The viewer's switch turns it on; the choice is remembered in the browser.
 */
import { useEffect, useState } from "react";
import { api, FlowBox, StepOneMeasure } from "../api";
import { lastSession } from "../lastSession";
import CalcGeometry from "../views/CalcGeometry";

export interface StepOneMeasures {
  /** The viewer offers the switch (a step-2 Classifier on the whole picture, with step-1 Evaluations). */
  available: boolean;
  /** Step 1 changed since its last freeze: the drawing shows step 1 as it is now. */
  changed: boolean;
  on: boolean;
  toggle: () => void;
  /** The measurements of the picture on screen, once they have arrived for it. */
  measures: StepOneMeasure[] | null;
}

export function useStepOneMeasures(camera: string, feature: string | undefined, frame: string, allowed: boolean): StepOneMeasures {
  const [summary, setSummary] = useState<{ available: boolean; changed: boolean } | null>(null);
  const [on, setOn] = useState<boolean>(() => lastSession.viewerMeasures());
  const [got, setGot] = useState<{ frame: string; measures: StepOneMeasure[] } | null>(null);
  useEffect(() => {
    if (!feature) { setSummary(null); return; }
    let cancelled = false;
    api.roiMeasuresSummary(camera, feature)
      .then((r) => !cancelled && setSummary({ available: r.available, changed: r.changed }))
      .catch(() => !cancelled && setSummary(null)); // cosmetic: the picture is useful without the drawing
    return () => { cancelled = true; };
  }, [camera, feature]);
  const available = allowed && !!summary?.available;
  useEffect(() => {
    if (!available || !on || !feature || !frame) { setGot(null); return; }
    let cancelled = false;
    api.roiMeasures(camera, feature, frame)
      .then((r) => !cancelled && setGot({ frame, measures: r.measures }))
      .catch(() => !cancelled && setGot(null));
    return () => { cancelled = true; };
  }, [camera, feature, frame, available, on]);
  return {
    available,
    changed: !!summary?.changed,
    on,
    toggle: () => setOn((v) => { lastSession.setViewerMeasures(!v); return !v; }),
    measures: available && on && got?.frame === frame ? got.measures : null,
  };
}

/** Every measurement drawn over the picture, one layer each (they may overlap: a zone and an angle wedge). */
export default function StepOneOverlay({ size, measures }: { size: { w: number; h: number }; measures: StepOneMeasure[] }) {
  return (
    <>
      {measures.map((m) => {
        const boxes: Record<string, FlowBox> = {};
        if (m.a) boxes.a = m.a;
        if (m.b) boxes.b = m.b;
        return (
          <CalcGeometry
            key={m.evaluation}
            size={size}
            op={m.op}
            names={["a", "b"]}
            clockwise={m.clockwise}
            boxes={boxes}
            value={null}
            unit=""
            evaluation={{ spec: { mode: m.mode, op: m.op, zone: m.zone, nominal: m.nominal, tolerance: m.tolerance, clockwise: m.clockwise, unit: m.unit }, verdict: m.verdict }}
            ruleOnly
          />
        );
      })}
    </>
  );
}
