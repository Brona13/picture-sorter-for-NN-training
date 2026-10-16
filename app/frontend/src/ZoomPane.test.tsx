import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import ZoomPane from "./ZoomPane";
import { FIT_VIEW, View } from "./zoomGeometry";

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON() {},
  } as DOMRect);
});

function Harness({ onClick, panOnBackground = false }: { onClick?: () => void; panOnBackground?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>(FIT_VIEW);
  return (
    <ZoomPane
      imageSize={{ w: 400, h: 300 }}
      width={400}
      view={view}
      onViewChange={setView}
      panOnBackground={panOnBackground}
      contentRef={ref}
      contentTestId="content"
      contentHandlers={{ onClick }}
    >
      <div data-testid="inner" />
    </ZoomPane>
  );
}

function pointer(target: Element, type: string, clientX: number, clientY: number, button = 0) {
  const ev = createEvent[type as "pointerDown"](target, { pointerId: 1, bubbles: true });
  Object.defineProperty(ev, "clientX", { value: clientX });
  Object.defineProperty(ev, "clientY", { value: clientY });
  Object.defineProperty(ev, "button", { value: button });
  fireEvent(target, ev);
}

const level = () => screen.getByTestId("zoom-level").textContent;

test("shows 100% for a fitted 400 px picture in a 400 px box, and the buttons zoom and reset", () => {
  render(<Harness />);
  expect(level()).toBe("100%");
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  expect(level()).toBe("125%");
  fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
  fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
  expect(level()).toBe("80%");
  fireEvent.click(screen.getByRole("button", { name: "Reset zoom" }));
  expect(level()).toBe("100%");
});

test("the wheel zooms in and out and the 1:1 button returns to one picture pixel per screen pixel", () => {
  render(<Harness />);
  const viewport = screen.getByTestId("zoom-viewport");
  fireEvent.wheel(viewport, { deltaY: -100, clientX: 100, clientY: 100 });
  expect(Number.parseInt(level()!)).toBeGreaterThan(100);
  fireEvent.wheel(viewport, { deltaY: 300, clientX: 100, clientY: 100 });
  expect(Number.parseInt(level()!)).toBeLessThan(100);
  fireEvent.click(screen.getByRole("button", { name: "Reset zoom" }));
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  fireEvent.click(screen.getByRole("button", { name: "Actual pixels" }));
  expect(level()).toBe("100%");
});

test("the wheel keeps the picture point under the cursor fixed", () => {
  render(<Harness />);
  const content = screen.getByTestId("content");
  fireEvent.wheel(screen.getByTestId("zoom-viewport"), { deltaY: -200, clientX: 300, clientY: 100 });
  const left = Number.parseFloat(content.style.left);
  const top = Number.parseFloat(content.style.top);
  const w = Number.parseFloat(content.style.width);
  const h = Number.parseFloat(content.style.height);
  expect((300 - left) / w).toBeCloseTo(300 / 400);
  expect((100 - top) / h).toBeCloseTo(100 / 300);
});

test("the middle button pans", () => {
  render(<Harness />);
  const viewport = screen.getByTestId("zoom-viewport");
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  const content = screen.getByTestId("content");
  const before = Number.parseFloat(content.style.left);
  pointer(viewport, "pointerDown", 200, 150, 1);
  pointer(viewport, "pointerMove", 230, 150, 1);
  pointer(viewport, "pointerUp", 230, 150, 1);
  expect(Number.parseFloat(content.style.left)).toBeCloseTo(before + 30);
});

test("a background drag pans when allowed, and the click that follows it is swallowed", () => {
  const onClick = vi.fn();
  render(<Harness onClick={onClick} panOnBackground />);
  const viewport = screen.getByTestId("zoom-viewport");
  const content = screen.getByTestId("content");
  pointer(viewport, "pointerDown", 200, 150, 0);
  pointer(viewport, "pointerMove", 240, 150, 0);
  pointer(viewport, "pointerUp", 240, 150, 0);
  fireEvent.click(content);
  expect(onClick).not.toHaveBeenCalled();
  fireEvent.click(content); // a later, ordinary click gets through
  expect(onClick).toHaveBeenCalledTimes(1);
});

test("a plain click is not a pan, and a left drag does nothing when panning on the background is off", () => {
  const onClick = vi.fn();
  render(<Harness onClick={onClick} />);
  const viewport = screen.getByTestId("zoom-viewport");
  const content = screen.getByTestId("content");
  const before = content.style.left;
  pointer(viewport, "pointerDown", 200, 150, 0);
  pointer(viewport, "pointerMove", 260, 150, 0);
  pointer(viewport, "pointerUp", 260, 150, 0);
  expect(content.style.left).toBe(before);
  fireEvent.click(content);
  expect(onClick).toHaveBeenCalledTimes(1);
});

test("keys + - 0 zoom and reset", () => {
  render(<Harness />);
  const viewport = screen.getByTestId("zoom-viewport");
  fireEvent.keyDown(viewport, { key: "+" });
  expect(level()).toBe("125%");
  fireEvent.keyDown(viewport, { key: "0" });
  expect(level()).toBe("100%");
  fireEvent.keyDown(viewport, { key: "-" });
  expect(level()).toBe("80%");
});
