import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import CardGrid from "./CardGrid";
import { createPainter } from "./painter";

const painter = createPainter<"a" | "b">((e) => (e.key === "a" || e.key === "b" ? (e.key as "a" | "b") : null));
painter.track();
afterEach(() => painter.end());

const cursorOf = (m: "a" | "b") => `cursor-${m}`;
const shown = () => (document.documentElement.classList.contains("painting") ? document.documentElement.style.getPropertyValue("--paint-cursor") : null);
const moved = { movementX: 4, movementY: 1 };

test("the cursor shows as soon as the key goes down with the pointer over a card, not only after a move", () => {
  painter.enter(cursorOf);
  expect(shown()).toBeNull();
  fireEvent.keyDown(window, { key: "a" });
  expect(shown()).toBe("cursor-a");
  fireEvent.keyUp(window, { key: "a" });
  expect(shown()).toBeNull();
});

test("a key pressed with the pointer outside every card shows nothing, and the cursor follows the card once it is entered", () => {
  painter.leave();
  fireEvent.keyDown(window, { key: "b" });
  expect(shown()).toBeNull();
  painter.move(moved, "x", cursorOf, () => false);
  expect(shown()).toBe("cursor-b");
});

test("the cursor stays while the key is held even if the pointer leaves the cards, and goes with the key or the window losing focus", () => {
  painter.enter(cursorOf);
  fireEvent.keyDown(window, { key: "a" });
  painter.leave();
  expect(shown()).toBe("cursor-a");
  fireEvent.blur(window);
  expect(shown()).toBeNull();
  expect(painter.held()).toBeNull();
});

test("a mode with no cursor (null) shows none but still paints", () => {
  const paint = vi.fn(() => true);
  fireEvent.keyDown(window, { key: "a" });
  painter.move(moved, "x", () => null, paint);
  expect(shown()).toBeNull();
  expect(paint).toHaveBeenCalledWith("a");
});

test("each card is painted once per stroke, only when the card acts, and never by a scroll", () => {
  const paint = vi.fn((m: string) => m === "a");
  fireEvent.keyDown(window, { key: "a" });
  painter.move({ movementX: 0, movementY: 0 }, "f1", cursorOf, paint); // a scroll under a still pointer
  expect(paint).not.toHaveBeenCalled();
  painter.move(moved, "f1", cursorOf, paint);
  painter.move(moved, "f1", cursorOf, paint); // same stroke
  expect(paint).toHaveBeenCalledTimes(1);
  const ineligible = vi.fn(() => false);
  painter.move(moved, "f2", cursorOf, ineligible);
  painter.move(moved, "f2", cursorOf, ineligible); // it did not act, so it may be tried again
  expect(ineligible).toHaveBeenCalledTimes(2);
  painter.mark("f3");
  const marked = vi.fn(() => true);
  painter.move(moved, "f3", cursorOf, marked); // the card the key was pressed on
  expect(marked).not.toHaveBeenCalled();
});

test("a new stroke starts clean, and keys with no mode, modifiers, repeats and typing fields never start one", () => {
  const paint = vi.fn(() => true);
  fireEvent.keyDown(window, { key: "a" });
  painter.move(moved, "f1", cursorOf, paint);
  fireEvent.keyUp(window, { key: "a" });
  fireEvent.keyDown(window, { key: "a" });
  painter.move(moved, "f1", cursorOf, paint);
  expect(paint).toHaveBeenCalledTimes(2);
  painter.end();
  fireEvent.keyDown(window, { key: "q" });
  fireEvent.keyDown(window, { key: "a", ctrlKey: true });
  expect(painter.held()).toBeNull();
  render(<input aria-label="note" />);
  fireEvent.keyDown(screen.getByLabelText("note"), { key: "a" });
  expect(painter.held()).toBeNull();
});

test("the painting cursor is one rule on the page that beats the hand cursor of links and buttons, added once", () => {
  painter.enter(cursorOf);
  fireEvent.keyDown(window, { key: "a" });
  fireEvent.keyUp(window, { key: "a" });
  fireEvent.keyDown(window, { key: "a" });
  const rules = document.querySelectorAll("style[data-painting-cursor]");
  expect(rules).toHaveLength(1);
  expect(rules[0].textContent).toMatch(/html\.painting,\s*html\.painting \*\s*\{[^}]*cursor:\s*var\(--paint-cursor[^}]*!important/);
});

test("the shared grid layout: pager above and below with the tool's name, the columns, a page of cards and a header", () => {
  const settings = { per_page: 2, cols: 3, per_page_options: [2, 4], cols_options: [3, 4] };
  const onPage = vi.fn();
  render(
    <CardGrid
      items={["a", "b", "c"]}
      keyOf={(x) => x}
      renderCard={(x) => <li data-testid={`c-${x}`}>{x}</li>}
      settings={settings}
      onSettings={() => undefined}
      page={2}
      onPage={onPage}
      where="demo"
      header={<p>my header</p>}
      label="Demo grid"
    />,
  );
  expect(screen.getByLabelText("Demo grid")).toHaveTextContent("my header");
  expect(screen.getByTestId("c-c")).toBeInTheDocument();
  expect(screen.queryByTestId("c-a")).toBeNull(); // page 2 of 2
  expect(screen.getByRole("navigation", { name: "Pagination demo top" })).toBeInTheDocument();
  expect(screen.getByRole("navigation", { name: "Pagination demo bottom" })).toBeInTheDocument();
  expect((screen.getByTestId("c-c").parentElement as HTMLElement).style.gridTemplateColumns).toBe("repeat(3, minmax(0, 1fr))");
});

test("a card removed while the pointer is over it does not leave the cursor armed", async () => {
  const { useGridCard } = await import("./useGridCard");
  function Card() {
    const { props } = useGridCard(painter, "f", { onKey: () => false, paint: () => false, cursorOf });
    return <li data-testid="card" {...props} />;
  }
  const { unmount } = render(<ul><Card /></ul>);
  fireEvent.mouseEnter(screen.getByTestId("card"));
  unmount();
  fireEvent.keyDown(window, { key: "a" });
  expect(shown()).toBeNull(); // nothing is under the pointer any more
});
