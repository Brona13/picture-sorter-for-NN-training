import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import FrameViewer from "./FrameViewer";

function setup(over: Partial<React.ComponentProps<typeof FrameViewer>> = {}) {
  const fns = { onLabel: vi.fn(), onGolden: vi.fn(), onDelete: vi.fn(), onClose: vi.fn(), onShow: vi.fn() };
  const marks: Record<string, { label: string | null; golden: string | null }> = { "b.png": { label: "OK", golden: null } };
  const props = {
    camera: "camA",
    frames: ["a.png", "b.png", "c.png"],
    start: "b.png",
    classes: ["OK", "NG"],
    marks: (f: string) => marks[f] ?? { label: null, golden: null },
    busy: false,
    ...fns,
    ...over,
  };
  render(<FrameViewer {...props} />);
  return fns;
}

test("opens on the chosen frame, full size, and walks the grid order with the arrows", () => {
  const { onShow } = setup();
  expect(screen.getByRole("dialog", { name: "Full-size picture" })).toBeInTheDocument();
  expect(screen.getByTestId("viewer-position")).toHaveTextContent("2 / 3");
  expect(screen.getByRole("img", { name: "b.png" })).toHaveAttribute("src", "/api/cameras/camA/frames/b.png/image");
  fireEvent.keyDown(window, { key: "ArrowRight" });
  expect(screen.getByTestId("viewer-position")).toHaveTextContent("3 / 3");
  expect(onShow).toHaveBeenLastCalledWith("c.png");
  fireEvent.keyDown(window, { key: "ArrowRight" }); // stays on the last one
  expect(screen.getByTestId("viewer-position")).toHaveTextContent("3 / 3");
  fireEvent.keyDown(window, { key: "ArrowLeft" });
  fireEvent.keyDown(window, { key: "ArrowLeft" });
  expect(screen.getByTestId("viewer-position")).toHaveTextContent("1 / 3");
  expect(screen.getByRole("img", { name: "a.png" })).toBeInTheDocument();
});

test("Escape, the close button and the backdrop close it", async () => {
  const { onClose } = setup();
  fireEvent.keyDown(window, { key: "Escape" });
  await userEvent.click(screen.getByRole("button", { name: "Close" }));
  await userEvent.click(screen.getByTestId("frame-viewer"));
  expect(onClose).toHaveBeenCalledTimes(3);
});

test("keys label, clear, golden and delete the frame on screen", () => {
  const { onLabel, onGolden, onDelete } = setup();
  fireEvent.keyDown(window, { key: "2" });
  expect(onLabel).toHaveBeenLastCalledWith("b.png", "NG");
  fireEvent.keyDown(window, { key: "1" }); // already OK -> removes it
  expect(onLabel).toHaveBeenLastCalledWith("b.png", null);
  fireEvent.keyDown(window, { key: "0" });
  expect(onLabel).toHaveBeenLastCalledWith("b.png", null);
  fireEvent.keyDown(window, { key: "`", code: "Backquote" });
  expect(onGolden).toHaveBeenLastCalledWith("b.png", true);
  fireEvent.keyDown(window, { key: "Delete" });
  expect(onDelete).toHaveBeenLastCalledWith("b.png");
});

test("a golden needs a label, and nothing acts while busy", () => {
  const first = setup({ start: "a.png" });
  fireEvent.keyDown(window, { key: "`", code: "Backquote" });
  expect(first.onGolden).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Make golden" })).toBeDisabled();
});

test("handled keys do not reach the page's own listeners", () => {
  setup();
  const page = vi.fn();
  window.addEventListener("keydown", page);
  fireEvent.keyDown(window, { key: "1" });
  fireEvent.keyDown(window, { key: "ArrowRight" });
  window.removeEventListener("keydown", page);
  expect(page).not.toHaveBeenCalled();
});

test("when the shown frame is deleted it carries on with its neighbour, and closes on an empty list", () => {
  const onClose = vi.fn();
  const base = { camera: "camA", start: "b.png", classes: ["OK"], marks: () => ({ label: null, golden: null }), busy: false, onLabel: vi.fn(), onGolden: vi.fn(), onDelete: vi.fn(), onClose };
  const { rerender } = render(<FrameViewer {...base} frames={["a.png", "b.png", "c.png"]} />);
  rerender(<FrameViewer {...base} frames={["a.png", "c.png"]} />);
  expect(screen.getByTestId("viewer-position")).toHaveTextContent("2 / 2");
  expect(screen.getByRole("img", { name: "c.png" })).toBeInTheDocument();
  rerender(<FrameViewer {...base} frames={[]} />);
  expect(onClose).toHaveBeenCalled();
});
