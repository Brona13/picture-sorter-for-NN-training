import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { FilterSpec } from "../api";
import FilterParams, { paramText } from "./FilterParams";

const spec: FilterSpec = {
  label: "Black and white",
  params: {
    objects: { label: "objects", options: { bright: "Bright objects", dark: "Dark objects" }, default: "bright" },
    mode: { label: "mode", options: { otsu: "Automatic", fixed: "Fixed", adaptive: "Adaptive" }, default: "otsu" },
    size: { label: "smallest blob", unit: "% of picture", min: 0.1, max: 50, step: 0.1, default: 10 },
    sigma: { min: 0.1, max: 10, step: 0.1, default: 1.5 },
  },
};

test("a choice of two is one toggle button, more is a drop-down, numbers are sliders with their unit", async () => {
  const onChange = vi.fn();
  render(<FilterParams spec={spec} params={{ objects: "bright" }} onChange={onChange} />);
  const toggle = screen.getByRole("button", { name: "objects" });
  expect(toggle).toHaveTextContent("Bright objects");
  await userEvent.click(toggle);
  expect(onChange).toHaveBeenLastCalledWith("objects", "dark");
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "mode" }), "adaptive");
  expect(onChange).toHaveBeenLastCalledWith("mode", "adaptive");
  expect(screen.getByLabelText("smallest blob")).toHaveValue("10");
  expect(screen.getByText("10 % of picture")).toBeInTheDocument();
  expect(screen.getByLabelText("sigma")).toHaveValue("1.5"); // no label: the key names it
});

test("the toggle shows the stored choice and flips back", async () => {
  const onChange = vi.fn();
  render(<FilterParams spec={spec} params={{ objects: "dark" }} onChange={onChange} />);
  expect(screen.getByRole("button", { name: "objects" })).toHaveTextContent("Dark objects");
  await userEvent.click(screen.getByRole("button", { name: "objects" }));
  expect(onChange).toHaveBeenLastCalledWith("objects", "bright");
});

test("paramText gives the option label or the number with its unit", () => {
  expect(paramText(spec.params.objects, "dark")).toBe("Dark objects");
  expect(paramText(spec.params.size, 5)).toBe("5 % of picture");
  expect(paramText(undefined, 3)).toBe("3");
});
