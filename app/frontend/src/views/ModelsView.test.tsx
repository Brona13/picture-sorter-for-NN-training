import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import ModelsView, { draftOf, payload } from "./ModelsView";

const freeze = (id: number, number: number, ok: number, ng: number, extra: object = {}) => ({
  id, number, name: `Export ${number}`, created: 1, ok, ng, no_rect: 0, sizes: { "200x200": ok + ng }, size: "200x200", mixed: false, ...extra,
});
const catalog = {
  size: null,
  sizes: { "200x200": 3 },
  mixed: 1,
  cameras: [
    { camera: "camA", freezes: [freeze(12, 2, 5, 2), freeze(11, 1, 4, 1)] },
    { camera: "camB", freezes: [freeze(21, 1, 3, 3, { sizes: { "200x200": 3, "640x480": 3 }, size: null, mixed: true })] },
  ],
};
const classes = [
  { id: 101, name: "camA-OK", color: "#06e52b", datasets: ["camA"], as_ok: ["camA"], as_ng: [] },
  { id: 102, name: "camA-NG", color: "#f44336", datasets: ["camA"], as_ok: [], as_ng: ["camA"] },
];
const detail = (over: object = {}) => ({
  id: 7, name: "Round one", created: 1, updated: 1, include_without_box: false, dataset_count: 1, builds: 0, last_build: null, folder: "models/Round one",
  datasets: [{ camera: "camA", version_id: 11, folder_name: "camA", ok_name: "camA-OK", ng_name: "camA-NG", ok_color: "#06e52b", ng_color: "#f44336",
    gone: false, number: 1, newer: { id: 12, number: 2, name: "Export 2", created: 1 } }],
  build_list: [], next_build: { number: 1, collection_name: "Round one_v001" }, changed: false, stale: ["camA"], classes, notes: [], ...over,
});

type Call = { url: string; method: string; body: unknown };
function mockServer(handlers: Record<string, (c: Call) => unknown> = {}) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const call = { url: url.replace(/^\/api/, ""), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const key = `${call.method} ${call.url.split("?")[0]}`;
    const body = handlers[key]?.(call);
    if (body === undefined) {
      const defaults: Record<string, unknown> = {
        "GET /models/datasets": catalog,
        "GET /models": { models: [{ id: 7, name: "Round one", dataset_count: 1, builds: 0 }] },
        "POST /models/preview": { classes, notes: [] },
      };
      return new Response(JSON.stringify(defaults[key] ?? {}));
    }
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body));
  }));
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

test("ticking a camera pins its newest freeze, shows the class list and creates the model", async () => {
  const calls = mockServer({ "POST /models": () => detail({ datasets: [] }) });
  render(<ModelsView />);
  await userEvent.click(await screen.findByRole("button", { name: "New model" }));
  await userEvent.type(screen.getByLabelText(/Model name/), "Round one");
  await userEvent.click(await screen.findByLabelText("Use camA"));
  expect(screen.getByLabelText("Freeze of camA")).toHaveValue("12");
  expect(await screen.findByText("camA-OK")).toBeInTheDocument();
  expect(screen.getByText(/Total:/).textContent).toContain("5 OK");
  await userEvent.click(screen.getByRole("button", { name: "Create model" }));
  await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url === "/models")).toBe(true));
  expect(calls.find((c) => c.url === "/models" && c.method === "POST")!.body).toEqual({
    name: "Round one", datasets: [{ camera: "camA", version_id: 12 }], include_without_box: false,
  });
});

test("a freeze of mixed sizes is shown under All sizes with its counts and hidden when a size is chosen", async () => {
  mockServer();
  render(<ModelsView />);
  await userEvent.click(await screen.findByRole("button", { name: "New model" }));
  await userEvent.click(await screen.findByLabelText("Use camB"));
  expect(screen.getByRole("note")).toHaveTextContent("Mixed sizes: 200x200 ×3, 640x480 ×3");
  await userEvent.click(screen.getByLabelText("Use camB")); // untick
  await userEvent.selectOptions(screen.getByLabelText("Picture size"), "200x200");
  expect(screen.getByText(/1 freezes with mixed sizes are hidden/)).toBeInTheDocument();
  expect(screen.getByLabelText("Use camB")).toBeDisabled(); // nothing of that size to pin
  expect(screen.getByLabelText("Use camA")).toBeEnabled();
});

test("a saved model offers the newer freeze and saves the change", async () => {
  const calls = mockServer({
    "GET /models/7": () => detail(),
    "PUT /models/7": () => detail({ datasets: [{ ...detail().datasets[0], version_id: 12, newer: null }], stale: [] }),
  });
  render(<ModelsView />);
  await userEvent.click(await screen.findByRole("button", { name: "Round one" }));
  expect(await screen.findByText(/Newer freeze #2 exists/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^Build/ })).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "Use it" }));
  expect(screen.getByLabelText("Freeze of camA")).toHaveValue("12");
  expect(screen.getByRole("button", { name: /^Build/ })).toBeDisabled(); // unsaved change
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
  expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ name: "Round one", datasets: [{ camera: "camA", version_id: 12 }], include_without_box: false });
  await waitFor(() => expect(screen.getByRole("button", { name: /^Build/ })).toBeEnabled());
});

test("building reports the zip and lists the build with a download link", async () => {
  const build = { id: 1, number: 1, collection_name: "Round one_v001", created: 1, zip: "models/Round one/Round one_v001.zip", exists: true, written: 9, include_without_box: false };
  let built = false;
  mockServer({
    "GET /models/7": () => detail({ builds: built ? 1 : 0, build_list: built ? [build] : [] }),
    "POST /models/7/build": () => {
      built = true;
      return build;
    },
  });
  render(<ModelsView />);
  await userEvent.click(await screen.findByRole("button", { name: "Round one" }));
  await userEvent.click(await screen.findByRole("button", { name: "Build Round one_v001" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Built Round one_v001: 9 pictures");
  const table = await screen.findByRole("table", { name: "Builds" });
  expect(within(table).getByRole("link", { name: "Download" })).toHaveAttribute("href", "/api/models/7/builds/1/zip");
});

test("a refusal from the server is shown", async () => {
  mockServer({
    "GET /models/7": () => detail(),
    "POST /models/7/build": () => new Response(JSON.stringify({ detail: "camA: the pinned freeze 11 was deleted." }), { status: 422 }),
  });
  render(<ModelsView />);
  await userEvent.click(await screen.findByRole("button", { name: "Round one" }));
  await userEvent.click(await screen.findByRole("button", { name: /^Build/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("was deleted");
});

test("payload leaves out defaults and draftOf turns a saved model back into the same payload", () => {
  const m = detail({
    datasets: [{ ...detail().datasets[0], folder_name: "left", ok_name: "Good", ng_name: "left-NG", ok_color: "#010203" }],
  }) as never;
  const d = draftOf(m);
  expect(d.rows.camA).toMatchObject({ folder_name: "left", ok_name: "Good", ng_name: "", ok_color: "#010203" });
  expect(payload(d, ["camA", "camB"])).toEqual([{ camera: "camA", version_id: 11, folder_name: "left", ok_name: "Good", ok_color: "#010203" }]);
});
