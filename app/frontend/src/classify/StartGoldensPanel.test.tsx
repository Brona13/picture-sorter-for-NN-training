import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import StartGoldensPanel from "./StartGoldensPanel";

let calls: { url: string; method: string; body?: any }[];
let reply: any;
const base = {
  available: true, backbone: "resnet50", cls: "OK", method: "facility", count: 40,
  picks: [{ frame: "a.png", label: "OK" }, { frame: "b.png", label: "OK" }, { frame: "c.png", label: "OK" }],
  coverage: [0.3, 0.6, 0.9], suggested: 3, radius: 0.1, left_out: 0, risky: false, n_max: 20,
};
beforeEach(() => {
  calls = [];
  reply = base;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url.includes("/classify/start-goldens")) return new Response(JSON.stringify({ ...reply, cls: new URL(url, "http://x").searchParams.get("cls") }));
    if (url.includes("/classify/promote")) return new Response(JSON.stringify({ card: {}, counts: { OK: 1 } }));
    return new Response("{}", { status: 404 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

const mount = (onPromoted = vi.fn(), onError = vi.fn()) => {
  render(<StartGoldensPanel camera="camA" feature="pick" classes={["OK", "NG"]} revision={0} onPromoted={onPromoted} onError={onError} />);
  return { onPromoted, onError };
};
const last = () => calls.filter((c) => c.url.includes("start-goldens")).at(-1)!.url;

test("asks for the first class with the recommended method and shows the picks, curve and suggested count", async () => {
  mount();
  await screen.findByTestId("start-a.png");
  expect(last()).toContain("cls=OK");
  expect(last()).toContain("method=facility");
  expect(last()).toContain("n=3");
  expect(screen.getByTestId("coverage-curve")).toBeTruthy();
  expect(screen.getByTestId("suggested-count").textContent).toContain("90%");
  expect(screen.getByText(/classical scores are not mixed in/)).toBeTruthy();
});

test("the other class and the method are asked for separately", async () => {
  mount();
  await screen.findByTestId("start-a.png");
  fireEvent.click(screen.getByRole("tab", { name: "NG" }));
  await waitFor(() => expect(last()).toContain("cls=NG"));
  fireEvent.change(screen.getByLabelText("Method"), { target: { value: "boundary" } });
  await waitFor(() => expect(last()).toContain("method=boundary"));
});

test("the count slider is per class and 'Use N' takes the suggestion", async () => {
  reply = { ...base, suggested: 2, coverage: [0.5, 0.9, 0.92] };
  mount();
  await screen.findByTestId("start-a.png");
  fireEvent.click(screen.getByRole("button", { name: "Use 2" }));
  await waitFor(() => expect(last()).toContain("n=2"));
  fireEvent.click(screen.getByRole("tab", { name: "NG" }));
  await waitFor(() => expect(last()).toContain("n=3"));
});

test("Make golden promotes with the class of the pick and never by itself", async () => {
  const { onPromoted } = mount();
  await screen.findByTestId("start-b.png");
  expect(calls.some((c) => c.url.includes("/promote"))).toBe(false);
  fireEvent.click(screen.getAllByRole("button", { name: /Make golden \(OK\)/ })[1]);
  await waitFor(() => expect(onPromoted).toHaveBeenCalledWith("b.png", "OK", { OK: 1 }));
  expect(calls.find((c) => c.url.includes("/promote"))!.body).toMatchObject({ feature: "pick", frame: "b.png", cls: "OK" });
});

test("boundary picks carry the mislabel warning; a missing ResNet says so in one line", async () => {
  reply = { ...base, method: "boundary", risky: true };
  mount();
  await screen.findByTestId("start-a.png");
  expect(screen.getByRole("note").textContent).toContain("likeliest mislabels");
});

test("without a ResNet there are no picks and the panel says why", async () => {
  reply = { ...base, available: false, backbone: null, picks: [], coverage: [], suggested: 0 };
  mount();
  expect(await screen.findByText(/No ResNet is switched on/)).toBeTruthy();
  expect(screen.queryByTestId("coverage-curve")).toBeNull();
});
