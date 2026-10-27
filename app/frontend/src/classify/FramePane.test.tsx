import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import FramePane from "./FramePane";

// A 400 x 300 picture in a 400 px wide pane is drawn at zoom 1: one screen pixel per picture pixel.
const sized = (img: HTMLElement, w: number, h: number) => {
  Object.defineProperty(img, "naturalWidth", { value: w, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: h, configurable: true });
  fireEvent.load(img);
};
const content = () => screen.getByTestId("zoom-viewport").firstElementChild as HTMLElement;
const left = () => parseFloat(content().style.left);
const top = () => parseFloat(content().style.top);

const pane = (frame: string, fix?: { on: boolean; point: { x: number; y: number } | null }) => (
  <FramePane camera="cam" frame={frame} width={400} fixPoint={fix} />
);
const load = (name: string) => sized(screen.getByAltText(name), 400, 300);

test("off: the view stays on the same place of the picture when the next picture comes", () => {
  const { rerender } = render(pane("a.png", { on: false, point: { x: 100, y: 100 } }));
  load("a.png");
  const before = [left(), top()];
  rerender(pane("b.png", { on: false, point: { x: 140, y: 90 } }));
  load("b.png");
  expect([left(), top()]).toEqual(before);
});

test("on: the picture shifts so the reference point stays where it was on screen", () => {
  const { rerender } = render(pane("a.png", { on: true, point: { x: 100, y: 100 } }));
  load("a.png");
  const screenOf = (p: { x: number; y: number }) => [left() + p.x, top() + p.y]; // zoom 1, one pixel per pixel
  const before = screenOf({ x: 100, y: 100 });
  rerender(pane("b.png", { on: true, point: { x: 140, y: 90 } }));
  load("b.png");
  const after = screenOf({ x: 140, y: 90 });
  expect(after[0]).toBeCloseTo(before[0]);
  expect(after[1]).toBeCloseTo(before[1]);
});

test("on: a picture with no point leaves the view alone, and the next one with a point is kept where the first was", () => {
  const { rerender } = render(pane("a.png", { on: true, point: { x: 100, y: 100 } }));
  load("a.png");
  const before = [left() + 100, top() + 100];
  rerender(pane("b.png", { on: true, point: null }));
  load("b.png");
  rerender(pane("c.png", { on: true, point: { x: 120, y: 130 } }));
  load("c.png");
  expect(left() + 120).toBeCloseTo(before[0]);
  expect(top() + 130).toBeCloseTo(before[1]);
});

test("compare: while on, the other picture is shown with its point exactly where the selected picture's point was", () => {
  const cmp = (on: boolean) => ({ on, frame: "ref.png", point: { x: 140, y: 90 } });
  const view = (on: boolean) => <FramePane camera="cam" frame="a.png" width={400} fixPoint={{ on: false, point: { x: 100, y: 100 } }} compare={cmp(on)} />;
  const { rerender, container } = render(view(false));
  load("a.png");
  sized(container.querySelector("img[aria-hidden]") as HTMLElement, 400, 300); // the preloaded reference
  const before = [left() + 100, top() + 100];
  rerender(view(true));
  expect(screen.getByAltText("ref.png")).toBeTruthy();
  expect(left() + 140).toBeCloseTo(before[0]);
  expect(top() + 90).toBeCloseTo(before[1]);
  rerender(view(false));
  expect(screen.getByAltText("a.png")).toBeTruthy();
  expect(left() + 100).toBeCloseTo(before[0]);
  expect(top() + 100).toBeCloseTo(before[1]);
});
