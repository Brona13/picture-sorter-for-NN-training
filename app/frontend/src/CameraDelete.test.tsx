import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import CameraDelete, { formatBytes } from "./CameraDelete";

let calls: { url: string; method: string }[];

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.endsWith("/delete-preview"))
        return new Response(JSON.stringify({ camera: "camA", rows: { frames: 120, labels: 30, settings: 4, score_cache: 0, versions: 2 }, files: 150, bytes: 5 * 1024 * 1024 }));
      if (method === "DELETE") return new Response(JSON.stringify({ removed: { rows: { frames: 120 }, files: 150, bytes: 1 } }));
      return new Response("{}", { status: 404 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

test("shows what would be lost and does not delete yet", async () => {
  const user = userEvent.setup();
  render(<CameraDelete camera="camA" onDeleted={() => {}} />);
  await user.click(screen.getByRole("button", { name: "Delete camera camA" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog).toHaveTextContent("150 files on disk (5.0 MB)");
  expect(dialog).toHaveTextContent("120 pictures");
  expect(dialog).toHaveTextContent("30 labels");
  expect(dialog).toHaveTextContent("2 versions");
  expect(dialog).toHaveTextContent("4 more database records");
  expect(calls.some((c) => c.method === "DELETE")).toBe(false);
});

test("the delete button stays disabled until the camera's name is typed exactly", async () => {
  const user = userEvent.setup();
  render(<CameraDelete camera="camA" onDeleted={() => {}} />);
  await user.click(screen.getByRole("button", { name: "Delete camera camA" }));
  const confirm = await screen.findByRole("button", { name: "Delete camera permanently" });
  expect(confirm).toBeDisabled();
  await user.type(screen.getByLabelText("Camera name to confirm"), "cama");
  expect(confirm).toBeDisabled();
  await user.clear(screen.getByLabelText("Camera name to confirm"));
  await user.type(screen.getByLabelText("Camera name to confirm"), "camA");
  expect(confirm).toBeEnabled();
});

test("confirming calls the delete with the name and reports it", async () => {
  const user = userEvent.setup();
  const onDeleted = vi.fn();
  render(<CameraDelete camera="camA" onDeleted={onDeleted} />);
  await user.click(screen.getByRole("button", { name: "Delete camera camA" }));
  await user.type(await screen.findByLabelText("Camera name to confirm"), "camA");
  await user.click(screen.getByRole("button", { name: "Delete camera permanently" }));
  await waitFor(() => expect(onDeleted).toHaveBeenCalledWith("camA"));
  expect(calls.find((c) => c.method === "DELETE")!.url).toBe("/api/cameras/camA?confirm=camA");
});

test("Keep it closes the warning without deleting", async () => {
  const user = userEvent.setup();
  render(<CameraDelete camera="camA" onDeleted={() => {}} />);
  await user.click(screen.getByRole("button", { name: "Delete camera camA" }));
  await user.click(await screen.findByRole("button", { name: "Keep it" }));
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(calls.some((c) => c.method === "DELETE")).toBe(false);
});

test("a refused delete shows the reason and keeps the warning open", async () => {
  const user = userEvent.setup();
  const onDeleted = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) =>
      url.endsWith("/delete-preview")
        ? new Response(JSON.stringify({ camera: "camA", rows: {}, files: 0, bytes: 0 }))
        : new Response(JSON.stringify({ detail: "A job is still running on this camera; wait for it to finish." }), { status: 409 }),
    ),
  );
  render(<CameraDelete camera="camA" onDeleted={onDeleted} />);
  await user.click(screen.getByRole("button", { name: "Delete camera camA" }));
  await user.type(await screen.findByLabelText("Camera name to confirm"), "camA");
  await user.click(screen.getByRole("button", { name: "Delete camera permanently" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("A job is still running");
  expect(onDeleted).not.toHaveBeenCalled();
});

test("formatBytes", () => {
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(1536)).toBe("1.5 KB");
  expect(formatBytes(3 * 1024 ** 3)).toBe("3.0 GB");
});
