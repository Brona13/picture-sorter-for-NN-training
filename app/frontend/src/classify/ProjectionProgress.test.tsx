import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { ProjectionProgress } from "./ScatterWorkbench";

test("the layout step shows a percentage and a filled bar", () => {
  render(<ProjectionProgress progress={{ phase: "projecting", done: 250, total: 1000 }} />);
  expect(screen.getByText(/Projecting 25 %/)).toBeInTheDocument();
  expect(document.querySelector("progress")).toHaveAttribute("max", "1000");
  expect(document.querySelector("progress")).toHaveAttribute("value", "250");
});

test("the embedding step counts pictures", () => {
  render(<ProjectionProgress progress={{ phase: "embedding", done: 3, total: 10 }} />);
  expect(screen.getByText(/Embedding 3\/10/)).toBeInTheDocument();
});

test("before anything is reported the bar is unfilled and the text has no number", () => {
  render(<ProjectionProgress progress={{}} />);
  expect(screen.getByText(/Projecting…/)).toBeInTheDocument();
  expect(document.querySelector("progress")).not.toHaveAttribute("value");
});
