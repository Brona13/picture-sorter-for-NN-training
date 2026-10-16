import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, test } from "vitest";
import WheelRange from "./WheelRange";

function Demo({ step = 1 }: { step?: number }) {
  const [v, setV] = useState(5);
  return (
    <>
      <WheelRange aria-label="k" min={1} max={7} step={step} value={v} onValue={setV} />
      <output>{v}</output>
    </>
  );
}

test("wheel up raises and wheel down lowers the value by one step, within the limits", () => {
  render(<Demo />);
  const s = screen.getByLabelText("k");
  fireEvent.wheel(s, { deltaY: -100 });
  expect(screen.getByRole("status")).toHaveTextContent("6");
  fireEvent.wheel(s, { deltaY: -100 });
  fireEvent.wheel(s, { deltaY: -100 });
  expect(screen.getByRole("status")).toHaveTextContent("7"); // capped at max
  fireEvent.wheel(s, { deltaY: 100 });
  expect(screen.getByRole("status")).toHaveTextContent("6");
});

test("fractional steps do not accumulate float noise, and the page is kept from scrolling", () => {
  render(<Demo step={0.1} />);
  const s = screen.getByLabelText("k");
  const ev = new WheelEvent("wheel", { deltaY: -1, cancelable: true, bubbles: true });
  act(() => {
    s.dispatchEvent(ev);
  });
  expect(ev.defaultPrevented).toBe(true);
  fireEvent.wheel(s, { deltaY: -1 });
  fireEvent.wheel(s, { deltaY: -1 });
  expect(screen.getByRole("status")).toHaveTextContent("5.3");
});

test("dragging or typing still works through onValue", () => {
  render(<Demo />);
  fireEvent.change(screen.getByLabelText("k"), { target: { value: "2" } });
  expect(screen.getByRole("status")).toHaveTextContent("2");
});
