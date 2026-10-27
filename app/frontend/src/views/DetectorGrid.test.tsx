import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FlowBox } from "../api";
import DetectorGrid, { sameSpot } from "./DetectorGrid";

const box = (x: number, y: number, extra: Partial<FlowBox> = {}): FlowBox => ({ x, y, angle: 0, score: 0.9, w: 40, h: 30, source: "auto", ...extra });

beforeEach(() => localStorage.removeItem("flow.detectorGrid"));
afterEach(() => vi.restoreAllMocks());

const FRAMES = ["a.png", "b.png", "c.png", "d.png"];
const BOXES: Record<string, Record<string, FlowBox>> = {
  "a.png": { left: box(50, 50), right: box(150, 50) }, // fine
  "b.png": { left: box(50, 50), right: box(55, 52) }, // both targets on the same hole
  "c.png": { left: box(50, 50) }, // right not found
  "d.png": {}, // nothing found
};

const setup = (over: Partial<Parameters<typeof DetectorGrid>[0]> = {}) => {
  const onPick = vi.fn();
  render(<DetectorGrid frames={FRAMES} boxes={BOXES} targets={["left", "right"]} current="a.png" size={{ w: 200, h: 100 }} imageUrl={(f) => `/thumb/${f}`} onPick={onPick} {...over} />);
  return onPick;
};
const cards = () => screen.getAllByTestId(/^finding-(?!boxes)/).map((c) => c.getAttribute("data-testid")!.replace("finding-", ""));

test("sameSpot: two different targets whose centres are closer than half the smaller box are on the same spot", () => {
  expect(sameSpot(BOXES["a.png"])).toEqual([]);
  expect(sameSpot(BOXES["b.png"])).toEqual([["left", "right"]]);
  expect(sameSpot(BOXES["c.png"])).toEqual([]);
  expect(sameSpot(undefined)).toEqual([]);
});

test("every picture is a card with its boxes drawn on it; the legend counts what each target found", () => {
  setup();
  expect(cards()).toEqual(FRAMES);
  expect(screen.getByTestId("finding-boxes-a.png").querySelectorAll("g")).toHaveLength(2);
  expect(screen.getByTestId("finding-boxes-c.png").querySelectorAll("g")).toHaveLength(1);
  expect(screen.getByTestId("finding-boxes-d.png").querySelectorAll("g")).toHaveLength(0);
  expect(screen.getByText(/left 3\/4/)).toBeInTheDocument();
  expect(screen.getByText(/right 2\/4/)).toBeInTheDocument();
  expect(screen.getByTestId("finding-b.png")).toHaveTextContent("same spot: left = right");
  expect(screen.getByTestId("finding-c.png")).toHaveTextContent("✗ right");
  expect(screen.getByTestId("finding-a.png")).toHaveTextContent("✓ found");
  expect(screen.getByTestId("finding-a.png")).toHaveAttribute("aria-current", "true");
});

test("no boxes are drawn until the size of the picture is known", () => {
  setup({ size: null });
  expect(screen.queryByTestId("finding-boxes-a.png")).toBeNull();
  expect(cards()).toEqual(FRAMES);
});

test("filter by what was found, and by the targets on the same spot", async () => {
  setup();
  await userEvent.selectOptions(screen.getByLabelText("Show"), "same");
  expect(cards()).toEqual(["b.png"]);
  await userEvent.selectOptions(screen.getByLabelText("Show"), "missing");
  expect(cards()).toEqual(["c.png", "d.png"]);
  await userEvent.selectOptions(screen.getByLabelText("Show"), "found");
  expect(cards()).toEqual(["a.png", "b.png"]);
});

test("filter by target: only that target's boxes are drawn and counted for found / not found", async () => {
  setup();
  await userEvent.selectOptions(screen.getByLabelText("Target"), "right");
  expect(screen.getByTestId("finding-boxes-a.png").querySelectorAll("g")).toHaveLength(1);
  await userEvent.selectOptions(screen.getByLabelText("Show"), "missing");
  expect(cards()).toEqual(["c.png", "d.png"]);
  await userEvent.selectOptions(screen.getByLabelText("Target"), "left");
  expect(cards()).toEqual(["d.png"]);
});

test("a box a person moved is drawn dashed; clicking a card loads that picture", async () => {
  const onPick = setup({ boxes: { ...BOXES, "a.png": { left: box(50, 50, { source: "human" }), right: box(150, 50) } } });
  const dashed = screen.getByTestId("finding-boxes-a.png").querySelectorAll("rect[stroke-dasharray]");
  expect(dashed).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Load c.png in the canvas" }));
  expect(onPick).toHaveBeenCalledWith("c.png");
});

test("the thumbnail and the boxes share one frame with the picture's proportions, so the boxes lie on the same spot", () => {
  setup();
  const svg = screen.getByTestId("finding-boxes-a.png");
  expect(svg).toHaveAttribute("viewBox", "0 0 200 100");
  expect(svg).toHaveAttribute("preserveAspectRatio", "none");
  const button = svg.parentElement as HTMLElement;
  expect(button.style.aspectRatio).toBe("200 / 100");
  expect(button.querySelector("img")!.style.objectFit).toBe("fill");
});
