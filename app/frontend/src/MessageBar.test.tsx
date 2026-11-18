import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import MessageBar, { INFO_BAR_MS } from "./MessageBar";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function Page({ kind }: { kind: "info" | "error" }) {
  const [text, setText] = useState<string | null>("Saved.");
  return <MessageBar kind={kind} text={text} onClose={() => setText(null)} />;
}

test("an information bar goes away by itself in under two seconds", () => {
  expect(INFO_BAR_MS).toBeLessThan(2000);
  render(<Page kind="info" />);
  expect(screen.getByRole("status")).toHaveTextContent("Saved.");
  act(() => void vi.advanceTimersByTime(INFO_BAR_MS - 50));
  expect(screen.getByRole("status")).toBeInTheDocument();
  act(() => void vi.advanceTimersByTime(100));
  expect(screen.queryByRole("status")).toBeNull();
});

test("an error bar stays until the cross is pressed", () => {
  render(<Page kind="error" />);
  act(() => void vi.advanceTimersByTime(60_000));
  expect(screen.getByRole("alert")).toHaveTextContent("Saved.");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss message" }));
  expect(screen.queryByRole("alert")).toBeNull();
});

test("the cross also discards an information bar by hand", () => {
  render(<Page kind="info" />);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss message" }));
  expect(screen.queryByRole("status")).toBeNull();
});

test("nothing is shown without a message", () => {
  const { container } = render(<MessageBar kind="error" text={null} onClose={() => {}} />);
  expect(container).toBeEmptyDOMElement();
});
