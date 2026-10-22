
import { fitPerPage, perPageOptions } from "./gridSizes";

test("the page sizes are whole rows of the chosen columns, and a column change keeps the number of rows", () => {
  expect(perPageOptions(6)).toEqual([12, 24, 48, 96]);
  expect(perPageOptions(5)).toEqual([10, 20, 40, 80]);
  expect(fitPerPage(24, 6, 5)).toBe(20); // 4 rows stay 4 rows
  expect(fitPerPage(96, 6, 3)).toBe(48);
  expect(fitPerPage(24, 4, 5)).toBe(20); // 24 on 4 columns (6 rows, an old size) goes to the nearest allowed row count
});
