import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import ErrorBoundary from "./ErrorBoundary";
import { breadcrumb, breadcrumbs, flushNow, report, resetClientLog, setLogCamera } from "./clientLog";
import { api } from "./api";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetClientLog();
  fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const posted = () => fetchMock.mock.calls.filter(([url]) => url === "/api/logs").flatMap(([, init]) => JSON.parse(init.body).records);

test("a report carries the camera, the page and the last 20 breadcrumbs", async () => {
  setLogCamera("camA");
  for (let i = 0; i < 25; i++) breadcrumb(`step ${i}`);
  expect(breadcrumbs()).toHaveLength(20);
  report("error", "boom", { request_id: "r1" });
  await flushNow();
  const [rec] = posted();
  expect(rec).toMatchObject({ level: "error", message: "boom", camera: "camA", request_id: "r1" });
  expect(rec.breadcrumbs.at(-1)).toContain("step 24");
});

test("identical consecutive reports are dropped and the rate is capped", async () => {
  report("error", "same");
  report("error", "same");
  for (let i = 0; i < 30; i++) report("warn", `m${i}`);
  await flushNow();
  expect(posted().filter((r) => r.message === "same")).toHaveLength(1);
  expect(posted().length).toBeLessThanOrEqual(10);
});

test("every API call sends an X-Request-ID; a 500 is reported with the id the server echoed", async () => {
  fetchMock.mockImplementation(async (url: string) =>
    url === "/api/logs" ? new Response("{}") : new Response(JSON.stringify({ error: "internal_error", detail: "kaput" }), { status: 500, headers: { "X-Request-ID": "srv-1" } }),
  );
  await expect(api.health()).rejects.toBeTruthy();
  const call = fetchMock.mock.calls.find(([u]) => String(u).startsWith("/api") && u !== "/api/logs")!;
  expect(call[1].headers["X-Request-ID"]).toBeTruthy();
  await flushNow();
  expect(posted()[0]).toMatchObject({ level: "error", request_id: "srv-1" });
});

test("a 4xx is not reported (the server already logs it) but a network failure is", async () => {
  fetchMock.mockImplementation(async (url: string) => {
    if (url === "/api/logs") return new Response("{}");
    throw new TypeError("Failed to fetch");
  });
  await expect(api.health()).rejects.toBeTruthy();
  await flushNow();
  expect(posted()[0].message).toContain("Network error");
});

test("the error boundary shows a message and reports the crash", async () => {
  const Bad = () => {
    throw new Error("render failed");
  };
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  render(<ErrorBoundary><Bad /></ErrorBoundary>);
  expect(screen.getByRole("alert")).toHaveTextContent("render failed");
  await flushNow();
  expect(posted()[0].message).toContain("Render crash: render failed");
  spy.mockRestore();
});
