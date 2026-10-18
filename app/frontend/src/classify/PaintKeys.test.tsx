import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import FrameViewer from "./FrameViewer";
import { cursorFor, DELETE_MODE, isClearKey, labelPainter } from "./paint";
import { reviewCursor } from "../reviewPaint";

test("0, x and X are the clear keys; nothing else is", () => {
  for (const key of ["0", "x", "X"]) expect(isClearKey({ key })).toBe(true);
  for (const key of ["1", "a", "Delete", "z"]) expect(isClearKey({ key })).toBe(false);
});

test("the label painter holds on the class keys, on 0 and X (the same clear mode), and on Delete", () => {
  const mode = (key: string) => {
    labelPainter.end();
    window.dispatchEvent(new KeyboardEvent("keydown", { key }));
    const m = labelPainter.held();
    window.dispatchEvent(new KeyboardEvent("keyup", { key }));
    return m;
  };
  labelPainter.track();
  expect(mode("1")).toBe("1");
  expect(mode("0")).toBe("0");
  expect(mode("x")).toBe("0");
  expect(mode("X")).toBe("0");
  expect(mode("Delete")).toBe(DELETE_MODE);
  expect(mode("q")).toBeNull();
});

test("clearing sweeps with the grey cross, deleting with a dark circle with a bin, a class with its colour; the Detector keeps its red cross", () => {
  const svg = (u: string | null) => decodeURIComponent(u ?? "");
  expect(svg(cursorFor("0", ["OK", "NG"]))).toContain("#555"); // grey cross
  expect(svg(cursorFor(DELETE_MODE, ["OK", "NG"]))).toContain("#444"); // dark circle
  expect(svg(cursorFor(DELETE_MODE, ["OK", "NG"]))).toContain("M8.5 9.5h9"); // the bin
  expect(svg(cursorFor("1", ["OK", "NG"]))).toContain("#1a7f37"); // OK green
  expect(svg(reviewCursor("clear"))).toContain("#c0392b"); // the Detector's red cross stays
  expect(svg(reviewCursor("delete"))).toContain("#444"); // but deleting looks the same everywhere
});

const renderViewer = (marks: { label: string | null; golden: string | null }) => {
  const h = { onLabel: vi.fn(), onGolden: vi.fn(), onDelete: vi.fn(), onRestore: vi.fn(), onClose: vi.fn() };
  render(<FrameViewer camera="camA" feature="seal" frames={["a.png"]} start="a.png" classes={["OK", "NG"]} marks={() => marks} busy={false} {...h} />);
  return h;
};

test("in the viewer 0, x and X clear the label; with no label they do nothing", () => {
  const h = renderViewer({ label: "OK", golden: null });
  for (const key of ["0", "x", "X"]) fireEvent.keyDown(window, { key });
  expect(h.onLabel).toHaveBeenCalledTimes(3);
  expect(h.onLabel).toHaveBeenLastCalledWith("a.png", null);
});

test("in the viewer X on an unlabeled picture does nothing", () => {
  const h = renderViewer({ label: null, golden: null });
  fireEvent.keyDown(window, { key: "x" });
  expect(h.onLabel).not.toHaveBeenCalled();
  expect(screen.getByText(/0 \/ X clear/)).toBeInTheDocument();
});
