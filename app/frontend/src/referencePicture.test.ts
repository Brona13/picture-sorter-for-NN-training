import { expect, test } from "vitest";
import { referenceFrame } from "./referencePicture";

const tol = { mode: "tolerance" as const, centre: null, wrap: false };

test("tolerance mode: the picture whose value is nearest the nominal", () => {
  const rows = [{ frame: "a", value: 10 }, { frame: "b", value: 19 }, { frame: "c", value: 30 }, { frame: "d", value: null }];
  expect(referenceFrame(rows, { ...tol, nominal: 20 })).toBe("b");
  expect(referenceFrame(rows, { ...tol, nominal: null })).toBeNull();
});

test("an angle goes the short way around the clock", () => {
  const rows = [{ frame: "a", value: 90 }, { frame: "b", value: 358 }];
  expect(referenceFrame(rows, { mode: "tolerance", nominal: 2, centre: null, wrap: true })).toBe("b");
  expect(referenceFrame(rows, { mode: "tolerance", nominal: 2, centre: null, wrap: false })).toBe("a");
});

test("zone mode: the smallest distance from the zone centre; none without a centre or a measurement", () => {
  const rows = [{ frame: "a", value: 5, deviation: [3, 4] as [number, number] }, { frame: "b", value: 2, deviation: [-1, 1] as [number, number] }, { frame: "c", value: null, deviation: null }];
  expect(referenceFrame(rows, { mode: "zone", nominal: null, centre: [100, 0], wrap: false })).toBe("b");
  expect(referenceFrame(rows, { mode: "zone", nominal: null, centre: null, wrap: false })).toBeNull();
  expect(referenceFrame([{ frame: "c", value: null, deviation: null }], { mode: "zone", nominal: null, centre: [1, 1], wrap: false })).toBeNull();
});

test("a tie goes to the first file name", () => {
  expect(referenceFrame([{ frame: "b", value: 9 }, { frame: "a", value: 11 }], { ...tol, nominal: 10 })).toBe("a");
});
