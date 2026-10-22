import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import type { FlowSummaryStep } from "../api";
import StepIcons, { stepCounts } from "./StepIcons";

const crop = (enabled = true): FlowSummaryStep => ({ op: "crop", rect: null, enabled });
const filter = (enabled = true): FlowSummaryStep => ({ op: "filter", label: "Gaussian blur", enabled });

test("an icon appears only for a step type that is in the list, with its count", () => {
  expect(stepCounts(undefined)).toEqual([]);
  expect(stepCounts([crop()])).toEqual([{ op: "crop", count: 1, allOff: false }]);
  expect(stepCounts([filter(), crop(), filter(), filter()])).toEqual([
    { op: "crop", count: 1, allOff: false },
    { op: "filter", count: 3, allOff: false },
  ]);
});

test("a type is dimmed only when every step of it is off", () => {
  expect(stepCounts([filter(false), filter(true)])[0].allOff).toBe(false);
  expect(stepCounts([filter(false), filter(false)])[0].allOff).toBe(true);
  expect(stepCounts([{ op: "filter", label: "x" }])[0].allOff).toBe(false); // a summary without the flag counts as on
});

test("the box shows a badge only when a type is used more than once", () => {
  render(<StepIcons steps={[crop(), filter(), filter(), filter(false)]} />);
  expect(screen.getByTestId("step-icon-crop")).not.toHaveTextContent(/\d/);
  expect(screen.getByTestId("step-icon-filter")).toHaveTextContent("3");
  expect(screen.getByTestId("step-icon-filter")).not.toHaveClass("off");
});

test("no steps: a short note and no icon; a list with only filters shows only the filter icon", () => {
  const { rerender } = render(<StepIcons steps={[]} />);
  expect(screen.getByText("no steps yet")).toBeInTheDocument();
  expect(screen.queryByTestId("step-icon-crop")).not.toBeInTheDocument();
  rerender(<StepIcons steps={[filter(false)]} />);
  expect(screen.queryByTestId("step-icon-crop")).not.toBeInTheDocument();
  expect(screen.getByTestId("step-icon-filter")).toHaveClass("off");
});
