import { expect, test } from "vitest";
import { sampleLabel } from "./samples";

test("a sample id reads as picture and box number, a plain name stays", () => {
  expect(sampleLabel("part.png#2")).toBe("part.png · box 2");
  expect(sampleLabel("part.png")).toBe("part.png");
});
