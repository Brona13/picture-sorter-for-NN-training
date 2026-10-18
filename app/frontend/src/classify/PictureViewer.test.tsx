import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import PictureViewer from "./PictureViewer";

function setup(over: Partial<React.ComponentProps<typeof PictureViewer>> = {}) {
  const props = {
    label: "Demo viewer",
    testId: "demo",
    name: "a-very-long-file-name-that-would-take-up-the-room-at-the-top_000123.png",
    index: 1,
    total: 3,
    onGo: vi.fn(),
    onClose: vi.fn(),
    hint: "the hints",
    ...over,
  };
  render(
    <PictureViewer {...props} toolbar={<button>My action</button>} tools={<button>My tool</button>}>
      {(width) => <div data-testid="content">{width}</div>}
    </PictureViewer>,
  );
  return props;
}

test("shows browsing, the page's toolbar and tools, the picture, then the file name and the hints underneath", () => {
  setup();
  const dialog = screen.getByRole("dialog", { name: "Demo viewer" });
  expect(within(dialog).getByTestId("viewer-position")).toHaveTextContent("2 / 3");
  expect(within(dialog).getByRole("button", { name: "My action" })).toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: "My tool" })).toBeInTheDocument();
  const content = within(dialog).getByTestId("content");
  const name = within(dialog).getByTestId("viewer-filename");
  expect(name).toHaveTextContent("a-very-long-file-name-that-would-take-up-the-room-at-the-top_000123.png");
  expect(content.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // the name is under the picture
  expect(name.compareDocumentPosition(within(dialog).getByText("the hints")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(Number(content.textContent)).toBeGreaterThanOrEqual(240); // the picture gets the width the window leaves
});

test("the buttons and the arrow keys browse, and the ends are disabled", async () => {
  const p = setup();
  await userEvent.click(screen.getByRole("button", { name: "Next picture" }));
  expect(p.onGo).toHaveBeenLastCalledWith(2);
  await userEvent.click(screen.getByRole("button", { name: "Previous picture" }));
  expect(p.onGo).toHaveBeenLastCalledWith(0);
  fireEvent.keyDown(window, { key: "ArrowRight" });
  expect(p.onGo).toHaveBeenLastCalledWith(2);
  fireEvent.keyDown(window, { key: "ArrowLeft" });
  expect(p.onGo).toHaveBeenLastCalledWith(0);
});

test("Esc, the close button and a click outside close it", async () => {
  const p = setup();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(p.onClose).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(p.onClose).toHaveBeenCalledTimes(2);
  await userEvent.click(screen.getByRole("dialog"));
  expect(p.onClose).toHaveBeenCalledTimes(3);
});

test("the page's keys are tried after Esc and the arrows; a key it uses never reaches the page underneath", () => {
  const onKey = vi.fn((e: KeyboardEvent) => e.key === "1");
  setup({ onKey });
  const under = vi.fn();
  window.addEventListener("keydown", under); // a card under the overlay listens on window too
  fireEvent.keyDown(window, { key: "1" });
  expect(onKey).toHaveBeenCalled();
  expect(under).not.toHaveBeenCalled(); // taken
  fireEvent.keyDown(window, { key: "q" });
  expect(under).toHaveBeenCalledTimes(1); // not the viewer's: passes through
  window.removeEventListener("keydown", under);
});

test("typing in a field does not browse or trigger the page's keys", async () => {
  const onKey = vi.fn(() => true);
  const p = setup({ onKey });
  render(<input aria-label="note" />);
  await userEvent.type(screen.getByLabelText("note"), "{ArrowLeft}1");
  expect(p.onGo).not.toHaveBeenCalled();
  expect(onKey).not.toHaveBeenCalled();
});
