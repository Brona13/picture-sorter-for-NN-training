/**
 * The reference picture of an Evaluation: the picture whose measurement lies closest to the nominal.
 * Zone (Offset): the smallest distance of B from the zone centre. Otherwise: the smallest difference of the value
 * from the nominal (an angle goes the short way around the clock). No nominal (or no zone centre) = no reference.
 * A picture used as the nominal is therefore its own reference; a nominal typed or placed by coordinates gets the nearest one.
 */
export interface ReferenceInput {
  frame: string;
  value: number | null;
  deviation?: [number, number] | null;
}

export function referenceFrame(
  rows: ReferenceInput[],
  rule: { mode: "tolerance" | "zone"; nominal: number | null; centre: [number, number] | null; wrap: boolean },
): string | null {
  if (rule.mode === "zone" ? !rule.centre : rule.nominal === null) return null;
  let best: string | null = null;
  let bestGap = Infinity;
  for (const r of [...rows].sort((a, b) => a.frame.localeCompare(b.frame))) {
    let gap: number | null = null;
    if (rule.mode === "zone") gap = r.deviation ? Math.hypot(r.deviation[0], r.deviation[1]) : null;
    else if (r.value !== null) {
      const d = Math.abs(r.value - (rule.nominal as number));
      gap = rule.wrap ? Math.min(d % 360, 360 - (d % 360)) : d;
    }
    if (gap !== null && gap < bestGap) { best = r.frame; bestGap = gap; }
  }
  return best;
}
