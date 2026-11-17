import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import FrameViewer from "./FrameViewer";

afterEach(() => vi.unstubAllGlobals());

function setup(over: Partial<React.ComponentProps<typeof FrameViewer>> = {}) {
  const fns = { onLabel: vi.fn(), onGolden: vi.fn(), onDelete: vi.fn(), onClose: vi.fn(), onShow: vi.fn() };
  const marks: Record<string, { label: string | null; golden: string | null }> = { "b.png": { label: "OK", golden: null } };
  const props = {
    camera: "camA",
    frames: ["a.png", "b.png", "c.png"],
    start: "b.png",
    classes: ["OK", "NG"],
    marks: (f: string) => marks[f] ?? { label: null, golden: null },
    busy: false,
    ...fns,
    ...over,
  };
  render(<FrameViewer {...props} />);
  return fns;
}

test("opens on the chosen frame, full size, and walks the grid order with the arrows", () => {
  const { onShow } = setup();
  expect(screen.getByRole("dialog", { name: "Full-size picture" })).toBeInTheDocument();
  expect(screen.getByTestId("viewer-position")).toHaveTextContent("2 / 3");
  expect(screen.getByTestId("viewer-filename")).toHaveTextContent("b.png");
  expect(screen.getByRole("img", { name: "b.png" })).toHaveAttribute("src", "/api/cameras/camA/frames/b.png/image");
  fireEvent.keyDown(window, { key: "ArrowRight" });
  expect(screen.getByTestId("viewer-position")).toHaveTextContent("3 / 3");
  expect(onShow).toHaveBeenLastCalledWith("c.png");
  fireEvent.keyDown(window, { key: "ArrowRight" }); // stays on the last one
  expect(screen.getByTestId("viewer-position")).toHaveTextContent("3 / 3");
  fireEvent.keyDown(window, { key: "ArrowLeft" });
  fireEvent.keyDown(window, { key: "ArrowLeft" });
  expect(screen.getByTestId("viewer-position")).toHaveTextContent("1 / 3");
  expect(screen.getByRole("img", { name: "a.png" })).toBeInTheDocument();
});

test("Escape, the close button and the backdrop close it", async () => {
  const { onClose } = setup();
  fireEvent.keyDown(window, { key: "Escape" });
  await userEvent.click(screen.getByRole("button", { name: "Close" }));
  await userEvent.click(screen.getByTestId("frame-viewer"));
  expect(onClose).toHaveBeenCalledTimes(3);
});

test("keys label, clear, golden and delete the frame on screen", () => {
  const { onLabel, onGolden, onDelete } = setup();
  fireEvent.keyDown(window, { key: "2" });
  expect(onLabel).toHaveBeenLastCalledWith("b.png", "NG");
  fireEvent.keyDown(window, { key: "1" }); // already OK -> removes it
  expect(onLabel).toHaveBeenLastCalledWith("b.png", null);
  fireEvent.keyDown(window, { key: "0" });
  expect(onLabel).toHaveBeenLastCalledWith("b.png", null);
  fireEvent.keyDown(window, { key: "`", code: "Backquote" });
  expect(onGolden).toHaveBeenLastCalledWith("b.png", true);
  fireEvent.keyDown(window, { key: "Delete" });
  expect(onDelete).toHaveBeenLastCalledWith("b.png");
});

test("M mutes or unmutes the frame on screen when the grid can mute, and does nothing otherwise", () => {
  const onMute = vi.fn();
  setup({ onMute, isMuted: (f) => f === "b.png" });
  fireEvent.keyDown(window, { key: "m" });
  expect(onMute).toHaveBeenLastCalledWith("b.png");
  expect(screen.getByRole("button", { name: "Unmute" })).toBeInTheDocument();
});

test("without a mute handler M is not a key of the viewer", () => {
  const fns = setup();
  fireEvent.keyDown(window, { key: "m" });
  expect(fns.onDelete).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Mute" })).toBeNull();
});

test("a golden needs a label, and nothing acts while busy", () => {
  const first = setup({ start: "a.png" });
  fireEvent.keyDown(window, { key: "`", code: "Backquote" });
  expect(first.onGolden).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Make golden" })).toBeDisabled();
});

test("handled keys do not reach the page's own listeners", () => {
  setup();
  const page = vi.fn();
  window.addEventListener("keydown", page);
  fireEvent.keyDown(window, { key: "1" });
  fireEvent.keyDown(window, { key: "ArrowRight" });
  window.removeEventListener("keydown", page);
  expect(page).not.toHaveBeenCalled();
});

test("when the shown frame is deleted it carries on with its neighbour, and closes on an empty list", () => {
  const onClose = vi.fn();
  const base = { camera: "camA", start: "b.png", classes: ["OK"], marks: () => ({ label: null, golden: null }), busy: false, onLabel: vi.fn(), onGolden: vi.fn(), onDelete: vi.fn(), onClose };
  const { rerender } = render(<FrameViewer {...base} frames={["a.png", "b.png", "c.png"]} />);
  rerender(<FrameViewer {...base} frames={["a.png", "c.png"]} />);
  expect(screen.getByTestId("viewer-position")).toHaveTextContent("2 / 2");
  expect(screen.getByRole("img", { name: "c.png" })).toBeInTheDocument();
  rerender(<FrameViewer {...base} frames={[]} />);
  expect(onClose).toHaveBeenCalled();
});

const roiBody = (feature: string) => ({
  rois: [{ feature, short_name: feature.split("::").pop(), owner_product: null, role: "quality", classes: ["OK", "NG"], shared_products: null, x: 0.25, y: 0.1, w: 0.5, h: 0.4, frames_seen: 1, inbox_total: 1, labeled: 0, goldens: 0, version_count: 0, active_version: null }],
  classify_feature: null,
});

test("the feature's ROI is outlined on the full frame, and the toggle hides it", async () => {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => (urls.push(url), new Response(JSON.stringify(roiBody("seal"))))));
  setup({ feature: "seal" });
  const box = await screen.findByTestId("viewer-roi");
  expect(box).toHaveStyle({ left: "25%", top: "10%", width: "50%", height: "40%" });
  expect(urls.filter((u) => !u.includes("/measures"))).toEqual(["/api/cameras/camA/rois"]); // (the step-1 measures summary is asked too)
  const toggle = screen.getByRole("button", { name: "Show ROI" });
  expect(toggle).toHaveAttribute("aria-pressed", "true");
  await userEvent.click(toggle);
  expect(screen.queryByTestId("viewer-roi")).toBeNull();
  expect(toggle).toHaveAttribute("aria-pressed", "false");
});

test("a product's ROI is looked up in that product's scope; without a ROI there is no outline or toggle", async () => {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => (urls.push(url), new Response(JSON.stringify(roiBody("P1::seal"))))));
  setup({ feature: "P1::seal" });
  await screen.findByTestId("viewer-roi");
  expect(urls.filter((u) => !u.includes("/measures"))).toEqual(["/api/cameras/camA/rois?product=P1"]);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
});

test("the outline is simply absent when the ROI cannot be loaded", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
  setup({ feature: "seal" });
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByTestId("viewer-roi")).toBeNull();
  expect(screen.queryByRole("button", { name: "Show ROI" })).toBeNull();
});

test("the zoom and pan stay when moving to another picture; Reset still fits it", async () => {
  setup();
  const fitted = screen.getByTestId("zoom-level").textContent!;
  await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  const zoomed = screen.getByTestId("zoom-level").textContent;
  expect(zoomed).not.toBe(fitted);
  fireEvent.keyDown(window, { key: "ArrowRight" });
  expect(screen.getByRole("img", { name: "c.png" })).toBeInTheDocument();
  expect(screen.getByTestId("zoom-level")).toHaveTextContent(zoomed!);
  fireEvent.keyDown(window, { key: "ArrowLeft" });
  fireEvent.keyDown(window, { key: "ArrowLeft" });
  expect(screen.getByTestId("zoom-level")).toHaveTextContent(zoomed!);
  await userEvent.click(screen.getByRole("button", { name: "Reset zoom" }));
  expect(screen.getByTestId("zoom-level")).toHaveTextContent(fitted);
});

test("an anchored ROI is outlined where the detector put it on this picture, and says so when there is none", async () => {
  const anchored = { ...roiBody("seal"), rois: [{ ...roiBody("seal").rois[0], anchored: true }] };
  const rects: Record<string, unknown> = {
    "b.png": { anchored: true, rect: { x: 0.5, y: 0.25, w: 0.2, h: 0.1 } },
    "c.png": { anchored: true, rect: null },
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const frame = decodeURIComponent(url.split("rect?frame=")[1] ?? "");
    return new Response(JSON.stringify(url.includes("/rect") ? rects[frame] : anchored));
  }));
  setup({ feature: "seal" });
  expect(await screen.findByTestId("viewer-roi")).toHaveStyle({ left: "50%", top: "25%", width: "20%", height: "10%" });
  fireEvent.keyDown(window, { key: "ArrowRight" });
  expect(await screen.findByText(/found no box here/)).toBeInTheDocument();
  expect(screen.queryByTestId("viewer-roi")).toBeNull();
});

test("an ROI fed by a Picture edits box is shown on that box's output picture, outlined in its own fractions", async () => {
  const fed = { ...roiBody("seal"), rois: [{ ...roiBody("seal").rois[0], input: "crop:1", x: 0.1, y: 0.2, w: 0.5, h: 0.5 }] };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(fed))));
  setup({ feature: "seal" });
  expect(await screen.findByTestId("viewer-roi")).toHaveStyle({ left: "10%", top: "20%", width: "50%", height: "50%" });
  // the picture changes to the box's output one render after the ROI arrives (the old one is held until then)
  await waitFor(() => expect((screen.getByAltText("b.png") as HTMLImageElement).getAttribute("src")).toMatch(/flow\/nodes\/crop%3A1\/picture\?frame=b\.png&stage=output/));
});

test("with filters in the Picture edits box a switch chooses the original or the filtered picture, and keeps the choice", async () => {
  const fed = { ...roiBody("seal"), rois: [{ ...roiBody("seal").rois[0], input: "crop:1" }] };
  const box = {
    kind: "crop",
    steps: [{ id: "s1", op: "crop", rect: [0.1, 0.1, 0.5, 0.5] }, { id: "s2", op: "filter", name: "gaussian", params: { sigma: 2 } }],
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("/flow/nodes/") ? box : fed))));
  setup({ feature: "seal" });
  const img = (name = "b.png") => decodeURIComponent((screen.getByAltText(name) as HTMLImageElement).getAttribute("src") ?? "");
  const toggle = await screen.findByRole("button", { name: "Picture version" });
  expect(toggle).toHaveTextContent("Filtered");
  expect(img()).not.toContain("steps=");
  await userEvent.click(toggle);
  expect(toggle).toHaveTextContent("Original");
  expect(img()).toContain('steps=[{"id":"s1","op":"crop","rect":[0.1,0.1,0.5,0.5]}]'); // crops stay, the filter is out
  fireEvent.keyDown(window, { key: "ArrowRight" });
  expect(await screen.findByAltText("c.png")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Picture version" })).toHaveTextContent("Original"); // the choice is locked
  expect(img("c.png")).toContain("steps=");
  await userEvent.click(screen.getByRole("button", { name: "Picture version" }));
  expect(img("c.png")).not.toContain("steps="); // and one click back to the filtered picture
});

test("no switch when the box has no filter", async () => {
  const fed = { ...roiBody("seal"), rois: [{ ...roiBody("seal").rois[0], input: "crop:1" }] };
  const box = { kind: "crop", steps: [{ id: "s1", op: "crop", rect: null }] };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("/flow/nodes/") ? box : fed))));
  setup({ feature: "seal" });
  await screen.findByTestId("viewer-roi");
  expect(screen.queryByRole("button", { name: "Picture version" })).toBeNull();
});

test("a Dedup box fed by a detector target: the cutout or the whole picture with the found box, the choice kept while browsing", async () => {
  localStorage.clear();
  const rects: Record<string, unknown> = {
    "a.png": { anchored: true, box: true, rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } },
    "b.png": { anchored: true, box: true, rect: { x: 0.5, y: 0.25, w: 0.2, h: 0.1 } },
    "c.png": { anchored: true, box: true, rect: null },
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/rect?frame=")) return new Response(JSON.stringify(rects[decodeURIComponent(url.split("rect?frame=")[1])]));
    return new Response(JSON.stringify(roiBody("seal")));
  }));
  setup({ feature: "seal", pictureFeature: "dedup:2" });
  const toggle = await screen.findByRole("button", { name: "Picture view" });
  expect(toggle).toHaveTextContent("Cutout");
  const src = (name: string) => decodeURIComponent((screen.getByAltText(name) as HTMLImageElement).getAttribute("src") ?? "");
  expect(src("b.png")).toContain("/frames/b.png/cutout?feature=dedup:2");
  expect(screen.queryByTestId("viewer-roi")).toBeNull();
  await userEvent.click(toggle);
  expect(toggle).toHaveTextContent("Whole");
  expect(src("b.png")).toBe("/api/cameras/camA/frames/b.png/image");
  expect(await screen.findByTestId("viewer-roi")).toHaveStyle({ left: "50%", top: "25%", width: "20%", height: "10%" });
  fireEvent.keyDown(window, { key: "ArrowLeft" });
  expect(await screen.findByAltText("a.png")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Picture view" })).toHaveTextContent("Whole"); // the choice stays
  await userEvent.click(screen.getByRole("button", { name: "Picture view" })); // back to the cutout for the next pictures
  fireEvent.keyDown(window, { key: "ArrowRight" });
  fireEvent.keyDown(window, { key: "ArrowRight" });
  expect(await screen.findByText(/detector found no box on this picture/)).toBeInTheDocument();
  expect(src("c.png")).toBe("/api/cameras/camA/frames/c.png/image"); // no cutout to show: the whole picture
});

test("a step-2 Classifier's viewer draws the step-1 measurements behind a switch, rule only, per picture", async () => {
  localStorage.clear();
  const box = (x: number, y: number) => ({ x, y, w: 10, h: 6, angle: 0, score: 1, source: "auto" });
  const zone = { evaluation: "eval:1", mode: "zone", op: "offset", clockwise: false, zone: { shape: "circle", center: [40, 0], radius: 5, half: [5, 5] }, nominal: null, tolerance: 0, unit: "px", a: box(30, 30) };
  const angle = { evaluation: "eval:2", mode: "tolerance", op: "angle", clockwise: false, zone: { shape: "circle", center: null, radius: 5, half: [5, 5] }, nominal: 0, tolerance: 2, unit: "°", verdict: "pass", a: box(30, 30), b: box(70, 30) };
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    urls.push(url);
    if (url.endsWith("/rois/pick/measures")) return new Response(JSON.stringify({ available: true, evaluations: 2, changed: true }));
    if (url.includes("/rois/pick/measures?frame=b.png")) return new Response(JSON.stringify({ frame: "b.png", measures: [{ ...zone, verdict: "pass", b: box(70, 30) }, angle] }));
    if (url.includes("/rois/pick/measures?frame=c.png")) return new Response(JSON.stringify({ frame: "c.png", measures: [{ ...zone, verdict: "fail", b: box(90, 30) }] }));
    return new Response(JSON.stringify({ rois: [] }));
  }));
  setup({ feature: "pick" });
  const toggle = await screen.findByRole("button", { name: "Show step 1 measurements" });
  expect(toggle).toHaveAttribute("aria-pressed", "false"); // off until switched on
  expect(screen.queryByTestId("rule-geometry")).toBeNull();
  expect(urls.some((u) => u.includes("measures?frame="))).toBe(false); // nothing fetched while off
  await userEvent.click(toggle);
  expect(localStorage.getItem("picturesorter.viewer.measures")).toBe("1");
  await waitFor(() => expect(screen.getAllByTestId("rule-geometry")).toHaveLength(2)); // every Evaluation draws
  expect(toggle).toHaveTextContent("⚠"); // step 1 changed since its freeze
  const [zoneLayer, angleLayer] = screen.getAllByTestId("rule-geometry");
  expect(zoneLayer.querySelector("[data-testid=evaluation-geometry]")).toHaveAttribute("data-verdict", "pass");
  expect(zoneLayer.querySelectorAll("text")).toHaveLength(0); // no numbers, no names
  expect(zoneLayer.querySelectorAll("rect")).toHaveLength(2); // box B only (outline and its dark edge), no box A
  expect(zoneLayer.querySelector("[data-testid=rule-b-centre]")).not.toBeNull();
  expect(zoneLayer.querySelector("[data-testid=rule-a-point]")).toBeNull(); // a zone does not need A on screen
  expect(angleLayer.querySelector("[data-testid=rule-a-point]")).not.toBeNull(); // an angle is measured from A
  expect(angleLayer.querySelectorAll("text")).toHaveLength(0);
  fireEvent.keyDown(window, { key: "ArrowRight" });
  await waitFor(() => expect(screen.getAllByTestId("rule-geometry")).toHaveLength(1)); // the next picture's own measurements
  expect(screen.getByTestId("evaluation-geometry")).toHaveAttribute("data-verdict", "fail");
  await userEvent.click(toggle);
  expect(screen.queryByTestId("rule-geometry")).toBeNull();
  expect(localStorage.getItem("picturesorter.viewer.measures")).toBe("0");
});

test("a viewer of a Classifier without step-1 measurements has no switch", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("/measures") ? { available: false, evaluations: 0, changed: false } : { rois: [] }))));
  setup({ feature: "seal" });
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByRole("button", { name: "Show step 1 measurements" })).toBeNull();
});
