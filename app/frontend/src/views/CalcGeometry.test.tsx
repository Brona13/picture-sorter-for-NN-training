import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import type { FlowBox } from "../api";
import type { EvalSpec } from "../evalGeometry";
import CalcGeometry from "./CalcGeometry";

const box = (x: number, y: number): FlowBox => ({ x, y, angle: 0, score: 0.9, w: 20, h: 20, source: "auto" });
const BOXES = { A: box(100, 100), B: box(123, 91) };
const ZONE: EvalSpec = { mode: "zone", op: "offset", zone: { shape: "circle", center: [20, -10], radius: 5, half: [5, 5] }, nominal: null, tolerance: 3, clockwise: false, unit: "px" };

const show = (evaluation?: { spec: EvalSpec; verdict?: string }) =>
  render(<CalcGeometry size={{ w: 400, h: 300 }} op="offset" names={["A", "B"]} clockwise={false} boxes={BOXES} value={3.2} unit="px" evaluation={evaluation} />);

test("without an evaluation only the Calculate geometry is drawn", () => {
  show();
  expect(screen.getByTestId("calc-geometry")).toBeInTheDocument();
  expect(screen.queryByTestId("evaluation-geometry")).toBeNull();
});

test("an evaluation adds its pass region, tinted by the verdict of the picture", () => {
  const { unmount } = show({ spec: ZONE, verdict: "pass" });
  const layer = screen.getByTestId("evaluation-geometry");
  expect(layer).toHaveAttribute("data-verdict", "pass");
  expect(layer.querySelector("path")!.getAttribute("fill")).toBe("#3ccf6e");
  expect(layer).toHaveTextContent("3.2 / 5 px");
  unmount();
  show({ spec: ZONE, verdict: "fail" });
  expect(screen.getByTestId("evaluation-geometry").querySelector("path")!.getAttribute("fill")).toBe("#ff5b5b");
});

test("a rule that has nothing to draw adds nothing", () => {
  show({ spec: { ...ZONE, zone: { ...ZONE.zone, center: null } }, verdict: "undetermined" });
  expect(screen.queryByTestId("evaluation-geometry")).toBeNull();
});
