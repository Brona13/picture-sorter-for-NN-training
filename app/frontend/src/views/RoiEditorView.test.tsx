import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import RoiEditorView from "./RoiEditorView";

const roi = (over: Record<string, unknown> = {}) => ({
  feature: "seal",
  short_name: "seal",
  owner_product: null,
  role: "quality",
  classes: ["OK", "NG"],
  shared_products: null,
  x: 0.1,
  y: 0.2,
  w: 0.3,
  h: 0.4,
  frames_seen: 4,
  inbox_total: 4,
  labeled: 2,
  goldens: 1,
  version_count: 1,
  active_version: 1,
  ...over,
});

let calls: { url: string; method: string; body?: any }[];
let rois: any;

function install(roisBody: any, framesBody?: any) {
  rois = roisBody;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url.includes("/frames?") || url.endsWith("/frames"))
        return new Response(JSON.stringify(framesBody ?? { frames: ["f1.png", "f2.png"], showing_all: false, total: 2, reference_frame: null }));
      if (url.includes("/rois") && method === "GET") return new Response(JSON.stringify(rois));
      if (url.includes("/geometry")) return new Response(JSON.stringify(roi({ ...init!.body && JSON.parse(init!.body as string) })));
      if (url.includes("/rois") && method === "DELETE") return new Response(JSON.stringify({ removed: { labels: 2, goldens: 1, versions: 1, settings: 0 } }));
      if (url.includes("/rois") && method === "PUT") return new Response(JSON.stringify(roi({ feature: "new", short_name: "new" })));
      if (url.includes("/reference-frame")) return new Response(JSON.stringify({ reference_frame: "f2.png" }));
      return new Response("{}", { status: 404 });
    }),
  );
}

const base = (over: Record<string, unknown> = {}) => ({
  rois: [roi()],
  classify_feature: null,
  products: [],
  inbox_total: 4,
  unclassified_frames: 0,
  shared_here: [],
  ...over,
});

beforeEach(() => {
  calls = [];
});
afterEach(() => vi.unstubAllGlobals());

test("empty camera prompts to ingest first", async () => {
  install(base(), { frames: [], showing_all: false, total: 0, reference_frame: null });
  render(<RoiEditorView camera="camA" />);
  expect(await screen.findByText(/add some in/)).toBeInTheDocument();
});

test("add form requires a drawn box, then saves name and rounded geometry", async () => {
  install(base({ rois: [] }));
  render(<RoiEditorView camera="camA" />);
  await screen.findByRole("heading", { name: /ROI editor — camA/ });
  await userEvent.type(screen.getByLabelText(/Feature name/), "cap");
  await userEvent.click(screen.getByRole("button", { name: /Add \/ update ROI/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Draw a rectangle first.");
  expect(calls.some((c) => c.method === "PUT")).toBe(false);

  await userEvent.type(screen.getByLabelText("w"), "0.5"); // seeds box from defaults
  await userEvent.click(screen.getByRole("button", { name: /Add \/ update ROI/ }));
  await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
  const put = calls.find((c) => c.method === "PUT")!;
  expect(put.body.name).toBe("cap");
  expect(put.body.product).toBeNull();
  expect(put.body.w).toBeGreaterThan(0);
});

test("edit mode seeds the box, warns when labeled ROI is moved, saves geometry", async () => {
  install(base());
  render(<RoiEditorView camera="camA" />);
  await screen.findByText("Defined ROIs");
  await userEvent.click(screen.getByLabelText(/Move & resize/));
  await waitFor(() => expect(screen.getByLabelText("x")).toHaveValue(0.1));
  expect(screen.getByRole("button", { name: /Save position/ })).toBeDisabled();

  const x = screen.getByLabelText("x");
  await userEvent.clear(x);
  await userEvent.type(x, "0.3");
  expect(screen.getByRole("alert")).toHaveTextContent("already has 2 labels and 1 golden marks");
  await userEvent.click(screen.getByRole("button", { name: /Save position/ }));
  await waitFor(() => expect(calls.some((c) => c.url.includes("/rois/seal/geometry"))).toBe(true));
  expect(calls.find((c) => c.url.includes("/geometry"))!.body).toEqual({ x: 0.3, y: 0.2, w: 0.3, h: 0.4 });
});

test("delete asks for confirmation and states what will be lost", async () => {
  install(base());
  render(<RoiEditorView camera="camA" />);
  await userEvent.click(await screen.findByRole("button", { name: "Delete seal" }));
  const dialog = screen.getByRole("alertdialog");
  expect(dialog).toHaveTextContent("2 labels, 1 golden marks and 1 versions");
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(calls.some((c) => c.method === "DELETE")).toBe(false);

  await userEvent.click(screen.getByRole("button", { name: "Delete seal" }));
  await userEvent.click(screen.getByRole("button", { name: /Yes, delete/ }));
  expect(await screen.findByText(/Deleted 'seal': removed 2 labels \/ 1 golden marks \/ 1 versions/)).toBeInTheDocument();
});

test("pin as reference posts the selected frame", async () => {
  install(base());
  render(<RoiEditorView camera="camA" />);
  await screen.findByText("Defined ROIs");
  await userEvent.selectOptions(screen.getByLabelText(/Frame to draw on/), "f2.png");
  await userEvent.click(screen.getByRole("button", { name: /Pin as reference/ }));
  await waitFor(() => expect(calls.some((c) => c.url.includes("/reference-frame"))).toBe(true));
  expect(calls.find((c) => c.url.includes("/reference-frame"))!.body).toEqual({ frame: "f2.png" });
});

test("camera with products: applies-to checkboxes save on change, hint about unsorted frames", async () => {
  install(
    base({
      classify_feature: "prod",
      products: ["A", "B"],
      unclassified_frames: 3,
      rois: [roi({ feature: "prod", short_name: "prod", role: "classify", classes: ["A", "B"] }), roi()],
    }),
  );
  render(<RoiEditorView camera="camA" />);
  expect(await screen.findByText(/3 of 4 frames have no product yet/)).toBeInTheDocument();
  expect(screen.getByText(/Products — classes of 'prod'/)).toBeInTheDocument();
  const cards = screen.getAllByRole("listitem");
  const classifyCard = cards.find((c) => c.textContent?.includes("product sorter"))!;
  const sealCard = cards.find((c) => c.textContent?.includes("all frames"))!;
  expect(within(classifyCard).queryByRole("checkbox")).toBeNull(); // sorter can't be shared
  await userEvent.click(within(sealCard).getByRole("checkbox", { name: "B" }));
  await waitFor(() => expect(calls.some((c) => c.url.includes("/rois/seal/products"))).toBe(true));
  const patch = calls.find((c) => c.url.includes("/rois/seal/products"))!;
  expect(patch.method).toBe("PATCH");
  expect(patch.body).toEqual({ products: ["B"] });
});
