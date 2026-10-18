import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { ClassifyState } from "../api";
import ClassifyKpis from "./ClassifyKpis";

const state = (over: Partial<ClassifyState> = {}): ClassifyState =>
  ({
    feature: "seal",
    classes: ["OK", "NG"],
    counts: { OK: 12, golden_OK: 3, NG: 4, golden_NG: 1, unlabeled: 20, total: 36 },
    views: ["All", "Unlabeled", "Labeled OK", "Labeled NG", "Golden", "Deleted"],
    scope: { restricted: false, camera_frames: 36 },
    ...over,
  }) as ClassifyState;

const kpi = (key: string) => screen.getByTestId(`kpi-${key}`);

test("shows the frames, one box per class with its golden count, and the unlabeled ones", () => {
  render(<ClassifyKpis state={state()} view="All" onPick={() => {}} />);
  expect(kpi("frames")).toHaveTextContent("Frames36");
  expect(kpi("class-OK")).toHaveTextContent("OK12 ⭐ 3");
  expect(kpi("class-NG")).toHaveTextContent("NG4 ⭐ 1");
  expect(kpi("unlabeled")).toHaveTextContent("Unlabeled20");
});

test("the class boxes follow the ROI: the products for the product-sorting ROI", () => {
  const s = state({ classes: ["4x4", "2x4", "RS"], counts: { "4x4": 5, "golden_4x4": 0, "2x4": 7, "golden_2x4": 0, RS: 1, golden_RS: 0, unlabeled: 2, total: 15 }, views: ["All", "Unlabeled", "Labeled 4x4", "Labeled 2x4", "Labeled RS"] });
  render(<ClassifyKpis state={s} view="All" onPick={() => {}} />);
  expect(kpi("class-4x4")).toHaveTextContent("4x4");
  expect(kpi("class-2x4")).toHaveTextContent("7");
  expect(kpi("class-RS")).toHaveTextContent("1");
  expect(screen.queryByTestId("kpi-class-OK")).toBeNull();
});

test("classes use the colours they have elsewhere: OK green, NG red", () => {
  render(<ClassifyKpis state={state()} view="All" onPick={() => {}} />);
  expect(kpi("class-OK")).toHaveStyle({ borderLeft: "4px solid #1a7f37" });
  expect(kpi("class-NG")).toHaveStyle({ borderLeft: "4px solid #c62828" });
});

test("a restricted ROI shows how many pictures the camera has", () => {
  render(<ClassifyKpis state={state({ scope: { restricted: true, camera_frames: 180 }, counts: { OK: 1, golden_OK: 0, NG: 0, golden_NG: 0, unlabeled: 119, total: 120 } })} view="All" onPick={() => {}} />);
  expect(kpi("frames")).toHaveTextContent("Frames120 of 180");
  expect(kpi("frames")).toHaveAttribute("title", expect.stringContaining("other products"));
});

test("an unrestricted ROI shows just the number", () => {
  render(<ClassifyKpis state={state()} view="All" onPick={() => {}} />);
  expect(kpi("frames")).not.toHaveTextContent("of");
});

test("a box leads to the matching View", async () => {
  const onPick = vi.fn();
  render(<ClassifyKpis state={state()} view="All" onPick={onPick} />);
  await userEvent.click(kpi("unlabeled"));
  expect(onPick).toHaveBeenLastCalledWith("Unlabeled");
  await userEvent.click(kpi("class-NG"));
  expect(onPick).toHaveBeenLastCalledWith("Labeled NG");
  await userEvent.click(kpi("frames"));
  expect(onPick).toHaveBeenLastCalledWith("All");
});

test("the box of the View on show is pressed; none is while the grid shows something else", () => {
  const { rerender } = render(<ClassifyKpis state={state()} view="Labeled OK" onPick={() => {}} />);
  expect(kpi("class-OK")).toHaveAttribute("aria-pressed", "true");
  expect(kpi("frames")).toHaveAttribute("aria-pressed", "false");
  rerender(<ClassifyKpis state={state()} view={null} onPick={() => {}} />);
  for (const key of ["frames", "class-OK", "class-NG", "unlabeled"]) expect(kpi(key)).toHaveAttribute("aria-pressed", "false");
});

test("a box whose View does not exist is disabled", () => {
  render(<ClassifyKpis state={state({ views: ["All", "Unlabeled"] })} view="All" onPick={() => {}} />);
  expect(kpi("class-OK")).toBeDisabled();
  expect(kpi("unlabeled")).toBeEnabled();
});
