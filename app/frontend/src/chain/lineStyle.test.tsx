import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, expect, test } from "vitest";
import LinesStyle from "./LinesStyle";
import { DEFAULT_LINE_STYLE, edgeLook, LineStyle, loadLineStyle, saveLineStyle } from "./lineStyle";
import { toFlowEdge } from "../views/ChainView";

beforeEach(() => localStorage.clear());

test("the default style is the look the Chain always had: right angles, corner radius 5, 20 px before the bend", () => {
  expect(loadLineStyle()).toEqual(DEFAULT_LINE_STYLE);
  expect(edgeLook(DEFAULT_LINE_STYLE)).toEqual({ type: "smoothstep", pathOptions: { borderRadius: 5, offset: 20 } });
});

test("each style maps to a React Flow line type with its own setting", () => {
  expect(edgeLook({ ...DEFAULT_LINE_STYLE, shape: "right-angle", offset: 40 })).toEqual({ type: "smoothstep", pathOptions: { borderRadius: 0, offset: 40 } });
  expect(edgeLook({ ...DEFAULT_LINE_STYLE, shape: "curved", curvature: 0.6 })).toEqual({ type: "default", pathOptions: { curvature: 0.6 } });
  expect(edgeLook({ ...DEFAULT_LINE_STYLE, shape: "straight" })).toEqual({ type: "straight" });
});

test("the style is remembered in this browser and a damaged value falls back field by field", () => {
  saveLineStyle({ shape: "curved", radius: 12, offset: 30, curvature: 0.5 });
  expect(loadLineStyle()).toEqual({ shape: "curved", radius: 12, offset: 30, curvature: 0.5 });
  localStorage.setItem("picturesorter.chain.lineStyle", JSON.stringify({ shape: "zigzag", radius: 999, offset: "x" }));
  expect(loadLineStyle()).toEqual({ ...DEFAULT_LINE_STYLE, radius: 40 }); // unknown shape and bad offset: defaults; a too large radius: the largest
  localStorage.setItem("picturesorter.chain.lineStyle", "not json");
  expect(loadLineStyle()).toEqual(DEFAULT_LINE_STYLE);
});

function Harness({ onStyle }: { onStyle?: (s: LineStyle) => void }) {
  const [style, setStyle] = useState<LineStyle>(DEFAULT_LINE_STYLE);
  return <LinesStyle style={style} onChange={(s) => { setStyle(s); onStyle?.(s); }} />;
}

test("the dropdown lists the four styles and shows only the settings the chosen style has", () => {
  render(<Harness />);
  const select = screen.getByLabelText("Line style");
  expect(Array.from(select.querySelectorAll("option")).map((o) => o.textContent)).toEqual(["Rounded", "Right angle", "Curved", "Straight"]);
  expect(screen.getByLabelText("Corner radius")).toBeInTheDocument();
  expect(screen.getByLabelText("Distance before the first bend")).toBeInTheDocument();
  fireEvent.change(select, { target: { value: "right-angle" } });
  expect(screen.queryByLabelText("Corner radius")).toBeNull();
  expect(screen.getByLabelText("Distance before the first bend")).toBeInTheDocument();
  fireEvent.change(select, { target: { value: "curved" } });
  expect(screen.getByLabelText("Curvature")).toBeInTheDocument();
  expect(screen.queryByLabelText("Distance before the first bend")).toBeNull();
  fireEvent.change(select, { target: { value: "straight" } });
  expect(screen.queryByRole("slider")).toBeNull();
});

test("moving a slider changes that setting only", () => {
  const seen: LineStyle[] = [];
  render(<Harness onStyle={(s) => seen.push(s)} />);
  fireEvent.change(screen.getByLabelText("Corner radius"), { target: { value: "18" } });
  expect(seen.at(-1)).toEqual({ ...DEFAULT_LINE_STYLE, radius: 18 });
});

test("a Chain line is drawn in the chosen style, and a 'searches inside' hint line is dashed and cannot be deleted", () => {
  const edge = { id: "a->b", source: "a", source_handle: null, target: "b", locked: false };
  expect(toFlowEdge(edge, { ...DEFAULT_LINE_STYLE, shape: "straight" }).type).toBe("straight");
  const hint = toFlowEdge({ ...edge, id: "a~>b#hole", locked: true, kind: "inside", label: "hole searches inside right" });
  expect(hint.className).toBe("chain-edge-inside");
  expect(hint.deletable).toBe(false);
});
