import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import SidePanel from "./SidePanel";

const page = () => (
  <SidePanel panel={<label>Feature (ROI)<select /></label>}>
    <p>page body</p>
  </SidePanel>
);

test("shows the panel next to the page and collapses it on request", async () => {
  render(page());
  expect(screen.getByText("page body")).toBeInTheDocument();
  expect(screen.getByLabelText("Feature (ROI)")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Hide options panel" }));
  expect(screen.queryByLabelText("Feature (ROI)")).toBeNull();
  expect(screen.getByText("page body")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Show options panel" }));
  expect(screen.getByLabelText("Feature (ROI)")).toBeInTheDocument();
});

test("a collapsed panel stays collapsed on the next page", async () => {
  const first = render(page());
  await userEvent.click(screen.getByRole("button", { name: "Hide options panel" }));
  first.unmount();
  render(page());
  expect(screen.queryByLabelText("Feature (ROI)")).toBeNull();
  expect(screen.getByRole("button", { name: "Show options panel" })).toHaveAttribute("aria-expanded", "false");
});
