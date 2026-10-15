import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import Histogram from "./Histogram";

const edges = [0, 1, 2, 3, 4];
const counts = [1, 4, 2, 0];

test("draws one bar per bin, scaled to the tallest, and marks both ranges", () => {
  render(<Histogram title="40 frames" unit="px" edges={edges} counts={counts} suggested={[0.5, 3.5]} chosen={[1, 3]} />);
  const bars = screen.getAllByTestId("bar");
  expect(bars).toHaveLength(4);
  const heights = bars.map((b) => Number(b.getAttribute("height")));
  expect(heights[1]).toBeGreaterThan(heights[2]);
  expect(heights[2]).toBeGreaterThan(heights[0]);
  expect(heights[3]).toBe(0);
  expect(screen.getByTestId("suggested-0")).toBeInTheDocument();
  expect(screen.getByTestId("chosen-1")).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "40 frames histogram" })).toBeInTheDocument();
});

test("a chosen range outside the data widens the axis so it can still be seen", () => {
  const { rerender } = render(<Histogram title="h" unit="px" edges={edges} counts={counts} suggested={null} chosen={[1, 3]} />);
  const inside = Number(screen.getByTestId("chosen-1").getAttribute("x1"));
  rerender(<Histogram title="h" unit="px" edges={edges} counts={counts} suggested={null} chosen={[1, 8]} />);
  const outside = Number(screen.getByTestId("chosen-1").getAttribute("x1"));
  expect(outside).toBeLessThanOrEqual(352); // inside the 360-wide drawing
  expect(screen.getAllByTestId("bar")[0].getAttribute("width")).not.toBe("0");
  expect(inside).not.toBe(outside);
});

test("no ranges means no marks", () => {
  render(<Histogram title="h" unit="°" edges={edges} counts={counts} suggested={null} chosen={null} />);
  expect(screen.queryByTestId("suggested-0")).toBeNull();
  expect(screen.queryByTestId("chosen-0")).toBeNull();
});
