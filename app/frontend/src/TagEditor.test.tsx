import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import TagEditor from "./TagEditor";

test("Enter and comma add a trimmed tag, repeats in another case are ignored", async () => {
  const onChange = vi.fn();
  render(<TagEditor tags={["Trial"]} suggestions={["Trial", "Line 1"]} onChange={onChange} />);
  const input = screen.getByLabelText("Add tag");
  await userEvent.type(input, "  line   1 {Enter}");
  expect(onChange).toHaveBeenLastCalledWith(["Trial", "line 1"]);
  onChange.mockClear();
  await userEvent.type(input, "TRIAL,");
  expect(onChange).not.toHaveBeenCalled();
});

test("× removes only that tag and suggestions skip tags already on the camera", async () => {
  const onChange = vi.fn();
  const { container } = render(<TagEditor tags={["a", "b"]} suggestions={["a", "c"]} onChange={onChange} />);
  await userEvent.click(screen.getByRole("button", { name: "Remove tag a" }));
  expect(onChange).toHaveBeenCalledWith(["b"]);
  expect([...container.querySelectorAll("option")].map((o) => o.getAttribute("value"))).toEqual(["c"]);
});
