import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { PipelineInfo } from "./api";
import PipelineChips, { LabelProgress } from "./PipelineChips";

const stage = (id: string, label: string, view: string, status: PipelineInfo["stages"][number]["status"], optional = false, detail = "") => ({ id, label, view, status, optional, detail });

const pipeline: PipelineInfo = {
  feature: "seal",
  frames: 40,
  labeled: 10,
  next: "goldens",
  stages: [
    stage("roi", "ROI", "roi", "done"),
    stage("vision", "Filter & detector", "detector", "todo", true),
    stage("labeled", "Labels", "classify", "done", false, "10 of 40 · OK 6 · NG 4"),
    stage("goldens", "Goldens", "classify", "partial", false, "OK 2 · NG 0"),
    stage("scored", "Scores", "classify", "stale", false, "goldens changed since"),
  ],
};

test("every stage is a button that says its state, detail and whether it is optional", () => {
  render(<PipelineChips pipeline={pipeline} onOpen={() => undefined} />);
  expect(screen.getByRole("button", { name: "ROI: done" })).toHaveAttribute("data-status", "done");
  expect(screen.getByRole("button", { name: "Filter & detector: not started (optional)" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Labels: done — 10 of 40 · OK 6 · NG 4" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Goldens: in progress — OK 2 · NG 0" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Scores: out of date — goldens changed since" })).toHaveAttribute("data-status", "stale");
  expect(screen.getByRole("list", { name: "Pipeline of seal" })).toBeInTheDocument();
});

test("the next required stage is emphasised and clicking a stage reports it", async () => {
  const onOpen = vi.fn();
  render(<PipelineChips pipeline={pipeline} onOpen={onOpen} />);
  expect(screen.getByTestId("stage-goldens")).toHaveStyle({ fontWeight: "700" });
  expect(screen.getByTestId("stage-labeled")).toHaveStyle({ fontWeight: "400" });
  await userEvent.click(screen.getByTestId("stage-goldens"));
  expect(onOpen).toHaveBeenCalledWith(pipeline.stages[3]);
});

test("the stages of the page being shown are marked as the current step", () => {
  render(<PipelineChips pipeline={pipeline} current="classify" onOpen={() => undefined} />);
  const current = screen.getAllByRole("button").filter((b) => b.getAttribute("aria-current") === "step");
  expect(current.map((b) => b.getAttribute("data-testid"))).toEqual(["stage-labeled", "stage-goldens", "stage-scored"]);
});

test("the label progress shows the share of frames and caps at the whole", () => {
  const { rerender } = render(<LabelProgress pipeline={pipeline} />);
  const bar = screen.getByRole("progressbar", { name: "Labeled frames" });
  expect(bar).toHaveAttribute("aria-valuenow", "10");
  expect(bar).toHaveAttribute("aria-valuemax", "40");
  expect(bar.firstElementChild).toHaveStyle({ width: "25%" });
  expect(screen.getByText("10 of 40 frames labeled")).toBeInTheDocument();
  rerender(<LabelProgress pipeline={{ ...pipeline, labeled: 50 }} />);
  expect(screen.getByRole("progressbar").firstElementChild).toHaveStyle({ width: "100%" });
  rerender(<LabelProgress pipeline={{ ...pipeline, frames: 0, labeled: 0 }} />);
  expect(screen.getByRole("progressbar").firstElementChild).toHaveStyle({ width: "0%" });
});
