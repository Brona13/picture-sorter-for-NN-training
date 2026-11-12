import { expect, test } from "vitest";
import { isDefaultVersionName, versionLabel } from "./versionLabel";

test("a version is written V01, V02 ... V99, V100, and nothing for no number", () => {
  expect([1, 9, 10, 99, 100].map(versionLabel)).toEqual(["V01", "V09", "V10", "V99", "V100"]);
  expect(versionLabel(null)).toBe("");
  expect(versionLabel(undefined)).toBe("");
});

test("the old default names (v1, v001) and the new one (V01) all count as the default name of that number", () => {
  expect(["v1", "v001", "V01", " V01 "].every((n) => isDefaultVersionName(n, 1))).toBe(true);
  expect(isDefaultVersionName("v2", 1)).toBe(false);
  expect(isDefaultVersionName("my set", 1)).toBe(false);
});
