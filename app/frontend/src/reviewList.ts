import { DetectionRow } from "./api";

/** Which frames the Detector review lists. The first is what needs a look; the rest answer "show me the trusted ones", "what did I accept", ... */
export const REVIEW_FILTERS = [
  ["needs", "Needs review"],
  ["unsure", "Unsure"],
  ["none", "No detection"],
  ["trusted", "Trusted"],
  ["accepted", "Accepted"],
  ["adjusted", "Adjusted by me"],
  ["all", "All frames"],
] as const;
export type ReviewFilter = (typeof REVIEW_FILTERS)[number][0];

/** The order of the list. The position sorts compare the detected box with the first exemplar's: a box far from where the object usually is is worth a look. */
export const REVIEW_SORTS = [
  ["least", "Least confident first"],
  ["most", "Most confident first"],
  ["name", "File name"],
  ["far", "Furthest from the exemplar position"],
  ["near", "Nearest to the exemplar position"],
] as const;
export type ReviewSort = (typeof REVIEW_SORTS)[number][0];

export const isReviewFilter = (v: string): v is ReviewFilter => REVIEW_FILTERS.some(([id]) => id === v);
export const isReviewSort = (v: string): v is ReviewSort => REVIEW_SORTS.some(([id]) => id === v);

export function matchesFilter(r: DetectionRow, filter: ReviewFilter): boolean {
  switch (filter) {
    case "needs":
      return r.state === "review" || r.state === "none";
    case "unsure":
      return r.state === "review";
    case "none":
      return r.state === "none";
    case "trusted":
      return r.state === "trusted";
    case "accepted":
      return r.state === "human" && r.status === "reviewed";
    case "adjusted":
      return r.state === "human" && r.status === "manual";
    default:
      return true;
  }
}

/** How many frames each filter would list, for the choice's own label. */
export function countByFilter(rows: DetectionRow[]): Record<ReviewFilter, number> {
  return Object.fromEntries(REVIEW_FILTERS.map(([id]) => [id, rows.filter((r) => matchesFilter(r, id)).length])) as Record<ReviewFilter, number>;
}

const conf = (r: DetectionRow) => r.boxes[0]?.conf ?? -1; // a frame without a box counts as the least confident

/** Distance of the detected box's centre from the exemplar's centre (both normalised); null without a box. */
function shift(r: DetectionRow, centre: { x: number; y: number } | null): number | null {
  const b = r.boxes[0];
  return b && centre ? Math.hypot(b.x + b.w / 2 - centre.x, b.y + b.h / 2 - centre.y) : null;
}

export function sortRows(rows: DetectionRow[], sort: ReviewSort, centre: { x: number; y: number } | null): DetectionRow[] {
  const out = [...rows];
  const byName = (a: DetectionRow, b: DetectionRow) => a.frame.localeCompare(b.frame, undefined, { numeric: true });
  if (sort === "name") return out.sort(byName);
  if (sort === "least") return out.sort((a, b) => conf(a) - conf(b) || byName(a, b));
  if (sort === "most") return out.sort((a, b) => (a.boxes[0] ? 0 : 1) - (b.boxes[0] ? 0 : 1) || conf(b) - conf(a) || byName(a, b)); // no box last
  const sign = sort === "far" ? -1 : 1;
  return out.sort((a, b) => {
    const da = shift(a, centre);
    const db = shift(b, centre);
    if (da === null || db === null) return (da === null ? 1 : 0) - (db === null ? 1 : 0) || byName(a, b); // no box last
    return sign * (da - db) || byName(a, b);
  });
}

/** What the grid lists: the frames the filter lets through, in the chosen order. */
export function reviewRows(all: DetectionRow[], filter: ReviewFilter, sort: ReviewSort, centre: { x: number; y: number } | null): DetectionRow[] {
  return sortRows(all.filter((r) => matchesFilter(r, filter)), sort, centre);
}
