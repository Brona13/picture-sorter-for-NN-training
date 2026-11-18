/**
 * Dots or heat map, and the heat map's smoothing: one choice remembered in this browser and shared by every chart that
 * draws pictures as points (the Evaluation zone chart, the detector's position map), with its controls.
 */
import { useMemo, useState } from "react";
import { autoBandwidth, Box, density2d, heatPixels } from "../density";
import type { Pt2 } from "../zoneGeometry";

const HEAT_STORE = "flow.heatmap"; // "heat" or "dots"
const SMOOTH_STORE = "flow.heatSmoothing"; // a power of two (0 = automatic)

export interface HeatChoice {
  heatOn: boolean;
  chooseHeat: (on: boolean) => void;
  smoothExp: number;
  smoothing: number;
  chooseSmooth: (v: number) => void;
}

export function useHeatChoice(): HeatChoice {
  const [heatOn, setHeatOn] = useState(() => {
    try { return localStorage.getItem(HEAT_STORE) === "heat"; } catch { return false; }
  });
  const [smoothExp, setSmoothExp] = useState(() => {
    try { const v = Number(localStorage.getItem(SMOOTH_STORE)); return Number.isFinite(v) && v >= -2 && v <= 2 ? v : 0; } catch { return 0; }
  });
  return {
    heatOn,
    smoothExp,
    smoothing: 2 ** smoothExp,
    chooseHeat: (on) => {
      setHeatOn(on);
      try { localStorage.setItem(HEAT_STORE, on ? "heat" : "dots"); } catch { /* not remembered */ }
    },
    chooseSmooth: (v) => {
      setSmoothExp(v);
      try { localStorage.setItem(SMOOTH_STORE, String(v)); } catch { /* not remembered */ }
    },
  };
}

export function HeatControls({ choice }: { choice: HeatChoice }) {
  const { heatOn, chooseHeat, smoothExp, smoothing, chooseSmooth } = choice;
  return (
    <>
      <span className="flow-segment" role="group" aria-label="Chart style">
        <button type="button" aria-pressed={!heatOn} onClick={() => chooseHeat(false)}>Dots</button>
        <button type="button" aria-pressed={heatOn} title="Colour by how many pictures lie around each place: blue few, red the most" onClick={() => chooseHeat(true)}>Heatmap</button>
      </span>
      {heatOn && (
        <label title="How far each picture's bump reaches. Automatic in the middle; left shows small piles, right merges them">
          Smoothing{" "}
          <input type="range" min={-2} max={2} step={0.25} value={smoothExp} onChange={(e) => chooseSmooth(Number(e.target.value))} aria-label="Smoothing" />{" "}
          {smoothExp === 0 ? "auto" : `×${smoothing.toFixed(2)}`}
        </label>
      )}
    </>
  );
}

/** The heat map of `points` over `view` as an image (a data URL; null where there is no canvas), its peak and its count. */
export function useHeatImage(points: Pt2[] | null, view: Box, smoothing: number): { url: string | null; max: number; count: number } | null {
  return useMemo(() => {
    if (!points) return null;
    const d = density2d(points, view, autoBandwidth(points, view.w / 20) * smoothing, 96);
    let url: string | null = null;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = d.n;
      canvas.height = d.n;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.putImageData(new ImageData(heatPixels(d), d.n, d.n), 0, 0);
        url = canvas.toDataURL();
      }
    } catch { /* no canvas here: the legend still says where the pile is */ }
    return { url, max: d.max, count: points.length };
  }, [points, view.x, view.y, view.w, view.h, smoothing]); // eslint-disable-line react-hooks/exhaustive-deps
}
