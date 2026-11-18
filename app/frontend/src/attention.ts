/**
 * What makes a detector picture worth a look (v1.171.0, phase 3 of `plans/detector-review-views.md`), kept as separate
 * signals and never blended: a target not found, a box outside its review zone or the pair outside its band / zone (how
 * far, in zone sizes: 1 is the edge, 2 twice as far out; v1.172.0 adds a box angle outside its band), a match below its
 * score threshold (weak), and the weakest match score. The detector page sorts by them.
 */
import type { FlowBox, FlowBoxRule, FlowPairState, FlowZone } from "./api";
import { deviation } from "./views/FlowBoxPanel";

export interface Attention {
  /** Target slots with no box. */
  missing: string[];
  /** The worst "how far out" (> 1 is outside), with what said so; null when nothing is outside. */
  outside: { by: string; times: number } | null;
  /** The weakest match below its slot's score threshold, if any. */
  weak: { slot: string; score: number; threshold: number } | null;
  /** The lowest match score of the picture's boxes (a box placed by hand counts as 1); null when it has none. */
  score: number | null;
  /** Every rule the picture breaks ("hole zone", "pin angle", "pair", "hole score"): what puts it under *Outside*. */
  reasons: string[];
}

/** A box's angle on the clock, 0-360. */
export const clockAngle = (a: number) => ((a % 360) + 360) % 360;
/** A box's match score; a box placed by hand counts as a perfect match. */
export const boxScore = (b: FlowBox) => (b.source === "human" ? 1 : b.score);

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
  rules: Record<string, FlowBoxRule> = {},
): Attention {
  const here = boxes ?? {};
  const missing = slots.filter((s) => !here[s]);
  const reasons: string[] = [];
  let outside: Attention["outside"] = null;
  const worse = (by: string, times: number | null) => {
    if (times === null || times <= 1 + 1e-9) return;
    reasons.push(by);
    if (!outside || times > outside.times) outside = { by, times };
  };
  let weak: Attention["weak"] = null;
  for (const [slot, rule] of Object.entries(rules)) {
    const b = here[slot];
    if (!b) continue;
    if (rule.angle) worse(`${slot} angle`, bandTimes(clockAngle(b.angle), rule.angle.nominal, rule.angle.tolerance, true));
    if (rule.score_min != null && boxScore(b) < rule.score_min) {
      reasons.push(`${slot} score`);
      if (!weak || boxScore(b) < weak.score) weak = { slot, score: boxScore(b), threshold: rule.score_min };
    }
  }
  for (const [slot, z] of Object.entries(zones)) {
    const b = here[slot];
    if (b) worse(`${slot} zone`, zoneTimes([b.x, b.y], z));
  }
  const p = pair?.pair;
  if (p) {
    if (pair!.mode === "zone") {
      const q = pair!.points[frame];
      if (q) worse(`pair ${p.a} → ${p.b}`, zoneTimes(q, p.zone));
    } else {
      const v = pair!.values[frame];
      if (v != null && p.nominal != null) worse(`pair ${p.a} → ${p.b}`, bandTimes(v, p.nominal, p.tolerance, pair!.wrap));
    }
  }
  const scores = slots.filter((s) => here[s]).map((s) => boxScore(here[s]));
  return { missing, outside, weak, score: scores.length ? Math.min(...scores) : null, reasons };
}

export const ATTENTION_SORTS = [
  ["attention", "Needs attention first"],
  ["outside", "Furthest outside first"],
  ["score", "Weakest match first"],
  ["name", "File name"],
] as const;
export type AttentionSort = (typeof ATTENTION_SORTS)[number][0];
export const isAttentionSort = (v: string): v is AttentionSort => ATTENTION_SORTS.some(([k]) => k === v);

/** Not found first, then furthest outside, then below a score threshold, then weakest match; ties by file name. */
function attentionKey(a: Attention): [number, number] {
  if (a.missing.length) return [0, -a.missing.length];
  if (a.outside) return [1, -a.outside.times];
  if (a.weak) return [2, a.weak.score];
  return [3, a.score ?? 1];
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
  if (a.weak) return `${a.weak.slot} score ${a.weak.score.toFixed(2)} below ${a.weak.threshold.toFixed(2)}`;
  return a.score !== null ? `score ${a.score.toFixed(2)}` : null;
}
