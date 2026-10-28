import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import Counter from "./Counter";
import { KindIcon, PALETTE_KINDS } from "./kindIcons";
import { PALETTE, BOX_SIZE, HUE } from "./palette";

test("a counter is an icon and a number, with its meaning in the tooltip", () => {
  render(<Counter icon="▦" value={65} title="Pictures it works on" />);
  const c = screen.getByTitle("Pictures it works on");
  expect(c).toHaveTextContent("▦ 65");
  expect(c).toHaveAttribute("data-counter", "▦");
});

test("every palette kind has one drawing, shared by the tile and the box corner", () => {
  expect(PALETTE_KINDS.sort()).toEqual(PALETTE.flatMap((g) => g.items.map((i) => i.kind)).sort());
  render(<KindIcon kind="roi" />);
  expect(screen.getByTestId("kind-icon-classifier")).toBeInTheDocument(); // a Classifier box uses the Classifier tile's icon
});

test("Picture edits is as wide as Ingest and the Classifier is blue", () => {
  expect(BOX_SIZE.crop.w).toBe(BOX_SIZE.ingest.w);
  expect(HUE.roi).toBeGreaterThan(215);
  expect(HUE.roi).toBeLessThan(235);
});
