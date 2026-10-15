import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import SimilarPanel from "./SimilarPanel";

const result = {
  seed: { frame: "seed.png", label: "OK" },
  method: "resnet50",
  neighbors: [
    { frame: "a.png", distance: 0.01 },
    { frame: "b.png", distance: 0.05 },
    { frame: "c.png", distance: 0.2 },
  ],
  classes: ["OK", "NG"],
};

let calls: { url: string; method: string; body?: any }[];
let labelResponse: any;
const onLabeled = vi.fn();
const onClose = vi.fn();
const onError = vi.fn();

beforeEach(() => {
  calls = [];
  labelResponse = { labeled: 2, skipped: [], counts: { OK: 5, NG: 1 } };
  [onLabeled, onClose, onError].forEach((f) => f.mockClear());
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, method: init?.method ?? "GET", body });
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (url.endsWith("/classify/similar")) return ok({ id: "s1", status: "queued", progress: {}, result: null, error: null });
      if (url === "/api/jobs/s1") return ok({ id: "s1", status: "done", progress: {}, result, error: null });
      if (url.endsWith("/classify/label-frames")) return ok(labelResponse);
      return new Response("{}", { status: 404 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

async function open() {
  const user = userEvent.setup();
  render(
    <SimilarPanel
      camera="camA"
      feature="seal"
      seed={{ frame: "seed.png", label: "OK" }}
      methods={["resnet18", "resnet50"]}
      classes={["OK", "NG"]}
      onLabeled={onLabeled}
      onClose={onClose}
      onError={onError}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Find similar" }));
  await screen.findByLabelText("Tick a.png");
  return user;
}

test("searches with the chosen method and limit, nothing is ticked by default", async () => {
  await open();
  expect(calls.find((c) => c.url.endsWith("/classify/similar"))?.body).toEqual({ feature: "seal", frame: "seed.png", method: "resnet50", limit: 60 });
  expect((screen.getByLabelText("Tick a.png") as HTMLInputElement).checked).toBe(false);
  expect((screen.getByRole("button", { name: /Label 0 ticked as OK/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(calls.some((c) => c.url.endsWith("/label-frames"))).toBe(false);
});

test("the distance slider ticks everything up to that distance and single ticks still work", async () => {
  const user = await open();
  fireEvent.change(screen.getByLabelText("Distance"), { target: { value: "0.06" } });
  expect((screen.getByLabelText("Tick a.png") as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText("Tick b.png") as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText("Tick c.png") as HTMLInputElement).checked).toBe(false);
  await user.click(screen.getByLabelText("Tick b.png"));
  expect(screen.getByRole("button", { name: /Label 1 ticked as OK/ })).toBeTruthy();
});

test("labeling sends only the ticked frames with the seed's label, then drops them from the list", async () => {
  const user = await open();
  await user.click(screen.getByLabelText("Tick a.png"));
  await user.click(screen.getByLabelText("Tick c.png"));
  await user.click(screen.getByRole("button", { name: /Label 2 ticked as OK/ }));
  await waitFor(() => expect(onLabeled).toHaveBeenCalledWith(2, 0, "OK", { OK: 5, NG: 1 }));
  expect(calls.find((c) => c.url.endsWith("/label-frames"))?.body).toEqual({ feature: "seal", frames: ["a.png", "c.png"], cls: "OK" });
  await waitFor(() => expect(screen.queryByLabelText("Tick a.png")).toBeNull());
  expect(screen.getByLabelText("Tick b.png")).toBeTruthy();
});

test("frames the server skipped stay in the list and are reported", async () => {
  labelResponse = { labeled: 1, skipped: ["c.png"], counts: { OK: 4, NG: 1 } };
  const user = await open();
  await user.click(screen.getByLabelText("Tick a.png"));
  await user.click(screen.getByLabelText("Tick c.png"));
  await user.click(screen.getByRole("button", { name: /Label 2 ticked as OK/ }));
  await waitFor(() => expect(onLabeled).toHaveBeenCalledWith(1, 1, "OK", { OK: 4, NG: 1 }));
  await waitFor(() => expect(screen.queryByLabelText("Tick a.png")).toBeNull());
  expect(screen.getByLabelText("Tick c.png")).toBeTruthy();
});
