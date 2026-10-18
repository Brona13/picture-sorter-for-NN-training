import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import ProductNamesEditor, { problemOf } from "./ProductNamesEditor";

const renderIt = (products = ["4x4", "2x4"], onSave = vi.fn(async () => undefined)) => {
  render(<ProductNamesEditor products={products} onSave={onSave} />);
  return onSave;
};
const save = () => screen.getByRole("button", { name: "Save products" });
const field = (i: number) => screen.getByLabelText(`Product ${i}`);

test("lists the products, one field each, and nothing to save until something changes", () => {
  renderIt();
  expect(field(1)).toHaveValue("4x4");
  expect(field(2)).toHaveValue("2x4");
  expect(save()).toBeDisabled();
});

test("changing a name sends a rename (old to new) with the final list, not a removal plus an addition", async () => {
  const onSave = renderIt();
  await userEvent.clear(field(1));
  await userEvent.type(field(1), "Alpha");
  expect(screen.getByText("was 4x4")).toBeInTheDocument();
  await userEvent.click(save());
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(["Alpha", "2x4"], { "4x4": "Alpha" }));
});

test("several renames at once, and the order of the list is kept", async () => {
  const onSave = renderIt(["A", "B", "C"]);
  await userEvent.clear(field(1));
  await userEvent.type(field(1), "x");
  await userEvent.clear(field(3));
  await userEvent.type(field(3), "z");
  await userEvent.click(save());
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(["x", "B", "z"], { A: "x", C: "z" }));
});

test("an added product is just in the list, no rename; a removed one is gone from it", async () => {
  const onSave = renderIt(["A", "B", "C"]);
  await userEvent.click(screen.getByRole("button", { name: "+ Add product" }));
  await userEvent.type(field(4), "D");
  await userEvent.click(screen.getByRole("button", { name: "Remove product 1" }));
  await userEvent.click(save());
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(["B", "C", "D"], {}));
});

test("renaming and removing together do not mix the names up", async () => {
  const onSave = renderIt(["A", "B", "C"]);
  await userEvent.click(screen.getByRole("button", { name: "Remove product 1" })); // A goes; the fields move up
  await userEvent.clear(field(1)); // this is B now
  await userEvent.type(field(1), "Bee");
  await userEvent.click(save());
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(["Bee", "C"], { B: "Bee" }));
});

test("blank rows are ignored", async () => {
  const onSave = renderIt(["A", "B"]);
  await userEvent.click(screen.getByRole("button", { name: "+ Add product" }));
  await userEvent.click(screen.getByRole("button", { name: "+ Add product" }));
  await userEvent.type(field(3), "C");
  await userEvent.click(save());
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(["A", "B", "C"], {}));
});

test("it will not save a list that cannot work, and says why", async () => {
  renderIt(["A", "B"]);
  await userEvent.clear(field(2));
  expect(save()).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent("Keep at least two products.");
  await userEvent.type(field(2), "a");
  expect(save()).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent("Two products are called a.");
  await userEvent.clear(field(2));
  await userEvent.type(field(2), "x::y");
  expect(screen.getByRole("alert")).toHaveTextContent("reserved");
});

test("problemOf", () => {
  expect(problemOf(["A", "B"])).toBeNull();
  expect(problemOf(["A", " "])).toMatch(/at least two/);
  expect(problemOf(["A", "a/b"])).toMatch(/slashes/);
  expect(problemOf(["A", "@b"])).toMatch(/@/);
  expect(problemOf(["A", "B", "b"])).toMatch(/Two products/);
  expect(problemOf(["A  B", "A B"])).toMatch(/Two products/); // spaces are folded
});

test("after a save the list starts again from the products the camera now has", async () => {
  const onSave = vi.fn(async () => undefined);
  const { rerender } = render(<ProductNamesEditor products={["A", "B"]} onSave={onSave} />);
  await userEvent.clear(field(1));
  await userEvent.type(field(1), "Alpha");
  rerender(<ProductNamesEditor products={["Alpha", "B"]} onSave={onSave} />);
  expect(field(1)).toHaveValue("Alpha");
  expect(screen.queryByText(/^was /)).toBeNull();
  expect(save()).toBeDisabled();
});
