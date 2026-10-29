import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import StartupBanner from "./StartupBanner";

afterEach(() => vi.unstubAllGlobals());

const answer = (body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body))));

test("shows the step being loaded while the backend is not ready", async () => {
  answer({
    ready: false,
    version: "1.2.3",
    steps: [
      { key: "cameras", label: "Reading the camera list", status: "done", detail: "2 cameras", seconds: 0.1 },
      { key: "pytorch", label: "Loading PyTorch for neural scoring (about 6 s the first time)", status: "running", detail: "", seconds: null },
      { key: "device", label: "Detecting the device", status: "waiting", detail: "", seconds: null },
    ],
  });
  render(<StartupBanner />);
  expect(await screen.findByRole("status")).toHaveTextContent("Starting up (2 of 3): Loading PyTorch for neural scoring…");
});

test("shows nothing once the backend is ready", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ready: true, version: "1.2.3", steps: [] })));
  vi.stubGlobal("fetch", fetchMock);
  render(<StartupBanner />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

test("shows nothing when the answer is not a start-up state (an older backend)", async () => {
  answer([]);
  render(<StartupBanner />);
  await new Promise((r) => setTimeout(r, 30));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
