import type { IngestOverviewFrame } from "./api";
import { dayOf } from "./ingestDays";

/** The size label of a picture: "1920 × 1080", or "unknown" when it could not be read. */
export function sizeOf(f: Pick<IngestOverviewFrame, "width" | "height">): string {
  return f.width && f.height ? `${f.width} × ${f.height}` : "unknown";
}

export interface Cell {
  /** Pictures in use (not removed at Ingest). */
  active: string[];
  /** Pictures removed at Ingest. */
  removed: string[];
}

export interface IngestMatrix {
  /** Sizes, the most pictures first. */
  sizes: string[];
  /** Days, newest first. */
  days: string[];
  cells: Map<string, Cell>;
}

export const cellKey = (size: string, day: string) => `${size}|${day}`;

export function buildMatrix(frames: IngestOverviewFrame[]): IngestMatrix {
  const cells = new Map<string, Cell>();
  const perSize = new Map<string, number>();
  const days = new Set<string>();
  for (const f of frames) {
    const size = sizeOf(f);
    const day = dayOf(f.created);
    days.add(day);
    perSize.set(size, (perSize.get(size) ?? 0) + 1);
    const key = cellKey(size, day);
    const cell = cells.get(key) ?? { active: [], removed: [] };
    (f.removed ? cell.removed : cell.active).push(f.frame);
    cells.set(key, cell);
  }
  return {
    sizes: [...perSize.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([s]) => s),
    days: [...days].sort((a, b) => b.localeCompare(a)),
    cells,
  };
}

/** The cells a row, a column or the whole table stands for. */
export const rowKeys = (m: IngestMatrix, size: string) => m.days.map((d) => cellKey(size, d)).filter((k) => m.cells.has(k));
export const columnKeys = (m: IngestMatrix, day: string) => m.sizes.map((s) => cellKey(s, day)).filter((k) => m.cells.has(k));
export const allKeys = (m: IngestMatrix) => [...m.cells.keys()];

/** Pick or drop a group of cells: all of them are picked unless they all are already, then they are dropped. */
export function toggleGroup(selected: Set<string>, keys: string[]): Set<string> {
  const next = new Set(selected);
  const all = keys.length > 0 && keys.every((k) => next.has(k));
  for (const k of keys) {
    if (all) next.delete(k);
    else next.add(k);
  }
  return next;
}

/** What the three actions would do with the picked cells. */
export function effects(m: IngestMatrix, selected: Set<string>) {
  const picked = { active: [] as string[], removed: [] as string[] };
  const outside: string[] = [];
  for (const [key, cell] of m.cells) {
    if (selected.has(key)) {
      picked.active.push(...cell.active);
      picked.removed.push(...cell.removed);
    } else outside.push(...cell.active);
  }
  return { remove: picked.active, bringBack: picked.removed, keepOnlyKeep: picked.active, keepOnlyRemove: outside };
}
