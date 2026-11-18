/**
 * What makes a detector picture worth a look (v1.171.0, phase 3 of `plans/detector-review-views.md`), kept as separate
 * signals and never blended: a target not found, a box outside its review zone or the pair outside its band / zone (how
 * far, in zone sizes: 1 is the edge, 2 twice as far out), and the weakest match score. The detector page sorts by them.
 */
import type { FlowBox, FlowPairState, FlowZone } from "./api";
import { deviation } from "./views/FlowBoxPanel";

export interface Attention {
  /** Target slots with no box. */
  missing: string[];
  /** The worst "how far out" (> 1 is outside), with what said so; null when nothing is outside. */
  outside: { by: string; times: number } | null;
  /** The lowest match score of the picture's boxes (a box placed by hand counts as 1); null when it has none. */
  score: number | null;
}

/** How far `p` lies from the zone's centre in zone sizes (1 = on the edge); null without a centre. */
export function zoneTimes(p: [number, number], zone: FlowZone): number | null {
  if (!zone.center) return null;
  const dx = p[0] - zone.center[0], dy = p[1] - zone.center[1];
  if (zone.shape === "circle") return zone.radius > 0 ? Math.hypot(dx, dy) / zone.radius : Infinity;
  return Math.max(Math.abs(dx) / zone.half[0], Math.abs(dy) / zone.half[1]);
}

/** How far a value lies from the nominal in tolerances (1 = on the band's edge); an angle wraps. */
export function bandTimes(value: number, nominal: number, tolerance: number, wrap: boolean): number {
  const d = deviation(value, nominal, wrap);
  if (tolerance <= 0) return Math.abs(d) < 1e-9 ? 0 : Infinity;
  return Math.abs(d) / tolerance;
}

export function attentionOf(
  frame: string,
  boxes: Record<string, FlowBox> | undefined,
  slots: string[],
  zones: Record<string, FlowZone>,
  pair: FlowPairState | null,
): Attention {
  const here = boxes ?? {};
  const missing = slots.filter((s) => !here[s]);
  let outside: Attention["outside"] = null;
  const worse = (by: string, times: number | null) => {
    if (times !== null && times > 1 + 1e-9 && (!outside || times > outside.times)) outside = { by, times };
  };
  for (const [slot, z] of Object.entries(zones)) {
    const b = here[slot];
    if (b) worse(`${slot} zone`, zoneTimes([b.x, b.y], z));
  }
  const p = pair?.pair;
  if (p) {
    if (pair!.mode === "zone") {
      const q = pair!.points[frame];
      if (q) worse("pair", zoneTimes(q, p.zone));
    } else {
      const v = pair!.values[frame];
      if (v != null && p.nominal != null) worse("pair", bandTimes(v, p.nominal, p.tolerance, pair!.wrap));
    }
  }
  const scores = slots.filter((s) => here[s]).map((s) => (here[s].source === "human" ? 1 : here[s].score));
  return { missing, outside, score: scores.length ? Math.min(...scores) : null };
}

export const ATTENTION_SORTS = [
  ["attention", "Needs attention first"],
  ["outside", "Furthest outside first"],
  ["score", "Weakest match first"],
  ["name", "File name"],
] as const;
export type AttentionSort = (typeof ATTENTION_SORTS)[number][0];
export const isAttentionSort = (v: string): v is AttentionSort => ATTENTION_SORTS.some(([k]) => k === v);

/** Not found first, then furthest outside, then weakest match; ties by file name. */
function attentionKey(a: Attention): [number, number] {
  if (a.missing.length) return [0, -a.missing.length];
  if (a.outside) return [1, -a.outside.times];
  return [2, a.score ?? 1];
}

export function sortByAttention(frames: string[], att: Map<string, Attention>, sort: AttentionSort): string[] {
  const by = (f: string): [number, number] => {
    const a = att.get(f);
    if (!a) return [9, 0];
    if (sort === "outside") return a.outside ? [0, -a.outside.times] : [1, 0];
    if (sort === "score") return a.score === null ? [1, 0] : [0, a.score];
    return attentionKey(a);
  };
  if (sort === "name") return [...frames].sort((x, y) => x.localeCompare(y));
  return [...frames].sort((x, y) => {
    const [a0, a1] = by(x), [b0, b1] = by(y);
    return a0 - b0 || a1 - b1 || x.localeCompare(y);
  });
}

/** The card's line: why it ranks where it does. */
export function attentionText(a: Attention | undefined): string | null {
  if (!a) return null;
  if (a.missing.length) return `${a.missing.join(", ")} not found`;
  if (a.outside) return `${a.outside.by} ${a.outside.times.toFixed(1)}× outside`;
  return a.score !== null ? `score ${a.score.toFixed(2)}` : null;
}
