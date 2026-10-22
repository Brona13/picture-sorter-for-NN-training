/** Page sizes of the picture grids: whole rows only (2, 4, 8 or 16 rows), so a full page never ends in a half-empty row.
 *  6 columns: 12, 24, 48, 96. 5 columns: 10, 20, 40, 80. Mirrors `grid_sizes.py`. */
export const ROWS = [2, 4, 8, 16];
export const COLS = [3, 4, 5, 6, 8];

export const perPageOptions = (cols: number): number[] => ROWS.map((r) => r * cols);

/** Every size that is valid for some column count (a remembered size is checked against this alone). */
export const isPageSize = (n: unknown): boolean => typeof n === "number" && COLS.some((c) => perPageOptions(c).includes(n));

/** The page size to use after the columns change: the same number of rows (the nearest allowed one) in the new width. */
export function fitPerPage(perPage: number, oldCols: number, newCols: number): number {
  const rows = perPage / (oldCols || 1);
  const nearest = ROWS.reduce((best, r) => (Math.abs(r - rows) < Math.abs(best - rows) ? r : best), ROWS[1]);
  return nearest * newCols;
}
