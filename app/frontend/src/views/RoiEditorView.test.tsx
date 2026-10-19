import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
      if (url.endsWith("/product-names")) return new Response(JSON.stringify({ products: JSON.parse(init!.body as string).names }));
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
  // on the same row as the bin, not in a block under the card
  expect(dialog.parentElement).toBe(screen.getByRole("button", { name: "Delete seal" }).parentElement);
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

test("picture size slider scales the drawing canvas and is remembered", async () => {
  localStorage.removeItem("roi.pictureSize");
  install(base());
  const { unmount } = render(<RoiEditorView camera="camA" />);
  const slider = await screen.findByLabelText("Picture size");
  expect(screen.getByTestId("roi-canvas")).toHaveStyle({ width: "900px" });
  fireEvent.change(slider, { target: { value: "1200" } });
  expect(screen.getByTestId("roi-canvas")).toHaveStyle({ width: "1200px" });
  unmount();
  render(<RoiEditorView camera="camA" />);
  await screen.findByLabelText("Picture size");
  expect(screen.getByTestId("roi-canvas")).toHaveStyle({ width: "1200px" });
  localStorage.removeItem("roi.pictureSize");
});

// --- focused editor (opened from the Chain canvas) ---------------------------------------------------------------
const focusData = () =>
  base({
    rois: [
      roi({ feature: "type", short_name: "type", role: "classify", classes: ["A", "B"], x: 0.05, y: 0.05, w: 0.9, h: 0.9 }),
      roi({ feature: "seal", short_name: "seal", x: 0.1, y: 0.2, w: 0.3, h: 0.4 }),
      roi({ feature: "edge", short_name: "edge", x: 0.5, y: 0.5, w: 0.2, h: 0.2 }),
    ],
    classify_feature: "type",
    products: ["A", "B"],
  });

test("opened on one feature, it shows only that ROI: no other rectangles, no drawing, no ROI creation, no product options", async () => {
  install(focusData());
  const onBack = vi.fn();
  render(<RoiEditorView camera="camA" focus={{ feature: "seal", onBack }} />);
  expect(await screen.findByRole("heading", { name: /ROI editor — camA › seal/ })).toBeInTheDocument();
  await waitFor(() => expect(screen.getByLabelText("x")).toHaveValue(0.1)); // the box is the feature's own, ready to adjust
  // no other ROI's rectangle on the picture
  expect(document.querySelectorAll('[title="type"], [title="edge"], [title="seal"]')).toHaveLength(0);
  // nothing that creates or lists ROIs, picks a mode, sets products or deletes
  expect(screen.queryByText("Mode")).toBeNull();
  expect(screen.queryByRole("button", { name: /Add \/ update ROI/ })).toBeNull();
  expect(screen.queryByLabelText(/Feature name/)).toBeNull();
  expect(screen.queryByText(/product-sorting/)).toBeNull();
  expect(screen.queryByText("Defined ROIs")).toBeNull();
  expect(screen.queryByText(/Applies to products/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete seal" })).toBeNull();
  expect(screen.queryByText(/Products — classes/)).toBeNull();
  // the way back
  await userEvent.click(screen.getByRole("button", { name: /Back to chain/ }));
  expect(onBack).toHaveBeenCalled();
});

test("in the focused editor the rectangle can still be moved and saved", async () => {
  install(focusData());
  render(<RoiEditorView camera="camA" focus={{ feature: "seal", onBack: () => {} }} />);
  await waitFor(() => expect(screen.getByLabelText("x")).toHaveValue(0.1));
  const x = screen.getByLabelText("x");
  await userEvent.clear(x);
  await userEvent.type(x, "0.3");
  await userEvent.click(screen.getByRole("button", { name: /Save position/ }));
  await waitFor(() => expect(calls.some((c) => c.url.includes("/rois/seal/geometry"))).toBe(true));
  expect(calls.find((c) => c.url.includes("/geometry"))!.body).toEqual({ x: 0.3, y: 0.2, w: 0.3, h: 0.4 });
});

test("opened on the product-sorting ROI, it shows only that rectangle and keeps the product names", async () => {
  install(focusData());
  render(<RoiEditorView camera="camA" focus={{ feature: "type", onBack: () => {} }} />);
  await waitFor(() => expect(screen.getByLabelText("w")).toHaveValue(0.9));
  expect(screen.getByText(/Products — classes of 'type'/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Add \/ update ROI/ })).toBeNull();
  expect(screen.queryByText("Mode")).toBeNull();
});

test("a focused ROI that no longer exists says so", async () => {
  install(focusData());
  render(<RoiEditorView camera="camA" focus={{ feature: "gone", onBack: () => {} }} />);
  expect(await screen.findByText(/no longer exists/)).toBeInTheDocument();
});

test("without a focus the editor is unchanged: modes, add form and the list of all ROIs", async () => {
  install(focusData());
  render(<RoiEditorView camera="camA" />);
  expect(await screen.findByText("Defined ROIs")).toBeInTheDocument();
  expect(screen.getByText("Mode")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Add \/ update ROI/ })).toBeInTheDocument();
});

// --- renaming products ----------------------------------------------------------------------------------------------
test("the product-sorting ROI's products can be renamed in the editor; labels and ROIs follow on the server, and the app is told", async () => {
  const withProducts = base({
    rois: [roi({ feature: "type", short_name: "type", role: "classify", classes: ["4x4", "2x4"] }), roi()],
    classify_feature: "type",
    products: ["4x4", "2x4"],
  });
  install(withProducts);
  const renamed = vi.fn();
  window.addEventListener("picturesorter:products-renamed", renamed);
  try {
    render(<RoiEditorView camera="camA" />);
    await userEvent.click(await screen.findByText(/Products — classes of 'type'/));
    const field = screen.getByLabelText("Product 1");
    expect(field).toHaveValue("4x4");
    await userEvent.clear(field);
    await userEvent.type(field, "Alpha");
    await userEvent.click(screen.getByRole("button", { name: "Save products" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/product-names"))).toBe(true));
    expect(calls.find((c) => c.url.endsWith("/product-names"))!.body).toEqual({ names: ["Alpha", "2x4"], renames: { "4x4": "Alpha" } });
    expect(await screen.findByText(/renamed 4x4 → Alpha: labels and ROIs kept/)).toBeInTheDocument();
    expect(renamed).toHaveBeenCalled();
    expect((renamed.mock.calls[0][0] as CustomEvent).detail).toEqual({ "4x4": "Alpha" });
  } finally {
    window.removeEventListener("picturesorter:products-renamed", renamed);
  }
});

test("adding a product sends no renames and does not tell the app about any", async () => {
  install(base({ rois: [roi({ feature: "type", short_name: "type", role: "classify", classes: ["A", "B"] })], classify_feature: "type", products: ["A", "B"] }));
  const renamed = vi.fn();
  window.addEventListener("picturesorter:products-renamed", renamed);
  try {
    render(<RoiEditorView camera="camA" />);
    await userEvent.click(await screen.findByText(/Products — classes of 'type'/));
    await userEvent.click(screen.getByRole("button", { name: "+ Add product" }));
    await userEvent.type(screen.getByLabelText("Product 3"), "C");
    await userEvent.click(screen.getByRole("button", { name: "Save products" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/product-names"))).toBe(true));
    expect(calls.find((c) => c.url.endsWith("/product-names"))!.body).toEqual({ names: ["A", "B", "C"], renames: {} });
    expect(renamed).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("picturesorter:products-renamed", renamed);
  }
});

function withAnchor(body: unknown) {
  const inner = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) =>
    url.includes("/rois/seal/anchor") && (init?.method ?? "GET") === "GET" ? new Response(JSON.stringify(body)) : inner(url, init)));
}

test("a ROI anchored with its own rectangle opens on the example picture, locked, with the detector's found box outlined", async () => {
  install(focusData());
  withAnchor({
    anchor: { detector: "det:1", target: "hole", mode: "rect", margin: 0.1, frame: "f2.png", follow_rotation: false },
    context: { frame: "f2.png", target: "hole", box: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 } },
  });
  render(<RoiEditorView camera="camA" focus={{ feature: "seal", onBack: () => {} }} />);
  await waitFor(() => expect(screen.getByLabelText(/Frame to draw on/)).toHaveValue("f2.png"));
  expect(screen.getByLabelText(/Frame to draw on/)).toBeDisabled();
  expect(document.querySelector('[title="hole (found by the detector)"]')).not.toBeNull();
  expect(screen.getByText(/relative to the green outline/)).toBeInTheDocument();
});

test("a ROI that is the found box has nothing to draw: the page says so", async () => {
  install(focusData());
  withAnchor({ anchor: { detector: "det:1", target: "hole", mode: "box", margin: 0.1, follow_rotation: false }, context: null });
  render(<RoiEditorView camera="camA" focus={{ feature: "seal", onBack: () => {} }} />);
  expect(await screen.findByText(/there is nothing to draw here/)).toBeInTheDocument();
  expect(screen.getByLabelText(/Frame to draw on/)).not.toBeDisabled();
});
