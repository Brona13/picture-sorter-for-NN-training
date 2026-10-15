import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import CopyButton, { copyText } from "./CopyButton";

afterEach(() => {
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  vi.restoreAllMocks();
});

test("falls back to execCommand when the clipboard API is missing", async () => {
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  const exec = vi.fn().mockReturnValue(true);
  (document as any).execCommand = exec;
  expect(await copyText("C:\\data\\exports")).toBe(true);
  expect(exec).toHaveBeenCalledWith("copy");
  expect(document.querySelector("textarea")).toBeNull(); // helper element is removed again
});

test("reports a failure when nothing can copy", async () => {
  Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) }, configurable: true });
  (document as any).execCommand = vi.fn().mockReturnValue(false);
  render(<CopyButton text="/x" />);
  await userEvent.click(screen.getByRole("button", { name: "Copy to clipboard" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Copy failed");
});
