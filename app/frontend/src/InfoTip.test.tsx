import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import InfoTip from "./InfoTip";

test("the icon is a labelled button that describes itself with the tip text", () => {
  render(<InfoTip label="Clusters">Groups near-identical pictures.</InfoTip>);
  const icon = screen.getByRole("button", { name: "Info: Clusters" });
  expect(icon).toHaveAccessibleDescription("Groups near-identical pictures.");
  expect(screen.getByRole("tooltip")).toHaveTextContent("Groups near-identical pictures.");
});
