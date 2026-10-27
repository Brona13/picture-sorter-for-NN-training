/**
 * Density of the pictures' measurements, for the Evaluation heat map and "densest spot as nominal".
 *
 * Every picture adds a soft bump (a Gaussian with peak 1), so the value at a place is about how many pictures lie within
 * one smoothing width of it. The bumps are summed on a grid by binning the points and blurring along x and then y.
 */
import type { Pt2 } from "./zoneGeometry";

export interface Box { x: number; y: number; w: number; h: number }
export interface Density {
  /** Cells per side. */
  n: number;
  /** Row-major, n x n: the density at each cell centre (row 0 is the top, y = box.y). */
  values: Float32Array;
  max: number;
  box: Box;
}

/** Scott's rule for two axes: the spread of the points times n^(-1/6). Never zero, so one point or equal points still draw. */
export function autoBandwidth(points: Pt2[], fallback: number): number {
  if (points.length < 2) return fallback;
  const mean = [0, 1].map((k) => points.reduce((s, p) => s + p[k], 0) / points.length);
  const sd = Math.sqrt([0, 1].reduce((s, k) => s + points.reduce((t, p) => t + (p[k] - mean[k]) ** 2, 0) / points.length, 0) / 2);
  const bw = sd * points.length ** (-1 / 6);
  return bw > 1e-9 ? bw : fallback;
}

function blur(src: Float32Array, n: number, sigma: number, horizontal: boolean): Float32Array {
  const radius = Math.max(1, Math.ceil(3 * sigma));
  const kernel = Array.from({ length: 2 * radius + 1 }, (_, i) => Math.exp(-((i - radius) ** 2) / (2 * sigma * sigma)));
  const out = new Float32Array(n * n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const cc = horizontal ? c + k : c;
        const rr = horizontal ? r : r + k;
        if (cc < 0 || cc >= n || rr < 0 || rr >= n) continue;
        sum += src[rr * n + cc] * kernel[k + radius];
      }
      out[r * n + c] = sum;
    }
  }
  return out;
}

/** The density of `points` on an n x n grid over `box`, with Gaussian width `bandwidth` (in the points' own units). */
export function density2d(points: Pt2[], box: Box, bandwidth: number, n = 96): Density {
  const counts = new Float32Array(n * n);
  for (const [px, py] of points) {
    const c = Math.floor(((px - box.x) / box.w) * n);
    const r = Math.floor(((py - box.y) / box.h) * n);
    if (c >= 0 && c < n && r >= 0 && r < n) counts[r * n + c] += 1;
  }
  const sigma = Math.max(0.6, (bandwidth / box.w) * n); // in cells; the x and y cells are square in a square box
  const values = blur(blur(counts, n, sigma, true), n, Math.max(0.6, (bandwidth / box.h) * n), false);
  let max = 0;
  for (const v of values) if (v > max) max = v;
  return { n, values, max, box };
}

/** Where the density is highest: the centre of the strongest cell, in the points' units. */
export function peak(d: Density): Pt2 | null {
  if (d.max <= 0) return null;
  let best = 0;
  for (let i = 1; i < d.values.length; i++) if (d.values[i] > d.values[best]) best = i;
  return [d.box.x + ((best % d.n) + 0.5) * (d.box.w / d.n), d.box.y + (Math.floor(best / d.n) + 0.5) * (d.box.h / d.n)];
}

/** The densest spot of a set of (dx, dy) points: automatic width times `smoothing`. */
export function densestSpot(points: Pt2[], smoothing = 1): Pt2 | null {
  if (points.length === 0) return null;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 1);
  const bw = autoBandwidth(points, span / 20) * smoothing;
  const side = span + 6 * bw;
  const box = { x: (Math.min(...xs) + Math.max(...xs)) / 2 - side / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 - side / 2, w: side, h: side };
  return peak(density2d(points, box, bw, 128));
}

/** The densest value of a list of numbers (one dimension); an angle goes around the clock (0-360). */
export function densestValue(values: number[], wrap: boolean, smoothing = 1): number | null {
  if (values.length === 0) return null;
  const lo = wrap ? 0 : Math.min(...values);
  const hi = wrap ? 360 : Math.max(...values);
  const span = hi - lo;
  if (span <= 0) return values[0];
  const n = 360;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length) || span / 20;
  const sigma = Math.max(0.6, ((1.06 * sd * values.length ** (-1 / 5) * smoothing) / span) * n);
  const bins = new Float64Array(n);
  for (const v of values) bins[Math.min(n - 1, Math.max(0, Math.floor(((v - lo) / span) * n)))] += 1;
  const radius = Math.ceil(3 * sigma);
  let best = 0;
  let bestV = -1;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
      let j = i + k;
      if (wrap) j = (j + n) % n;
      else if (j < 0 || j >= n) continue;
      sum += bins[j] * Math.exp(-(k * k) / (2 * sigma * sigma));
    }
    if (sum > bestV) { bestV = sum; best = i; }
  }
  return lo + ((best + 0.5) / n) * span;
}

/** Blue, cyan, green, yellow, red for t from 0 to 1, with the weakest densities fading to transparent: [r, g, b, a]. */
export function heatColour(t: number): [number, number, number, number] {
  const x = Math.min(1, Math.max(0, t));
  const stops: [number, [number, number, number]][] = [
    [0, [20, 40, 200]], [0.25, [0, 190, 255]], [0.5, [60, 220, 60]], [0.75, [255, 230, 0]], [1, [235, 30, 20]],
  ];
  let i = 0;
  while (i < stops.length - 2 && x > stops[i + 1][0]) i++;
  const [t0, c0] = stops[i];
  const [t1, c1] = stops[i + 1];
  const f = (x - t0) / (t1 - t0);
  const rgb = c0.map((v, k) => Math.round(v + (c1[k] - v) * f)) as [number, number, number];
  return [...rgb, Math.round(255 * Math.min(1, x * 5) * 0.85)];
}

/** RGBA pixels of a density (n x n), red at the densest spot. */
export function heatPixels(d: Density): Uint8ClampedArray<ArrayBuffer> {
  const px = new Uint8ClampedArray(new ArrayBuffer(d.n * d.n * 4));
  for (let i = 0; i < d.values.length; i++) {
    const [r, g, b, a] = heatColour(d.max > 0 ? d.values[i] / d.max : 0);
    px.set([r, g, b, a], i * 4);
  }
  return px;
}
