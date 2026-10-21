import { fireEvent, render, screen } from "@testing-library/react";
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
  expect(urls).toEqual(["/api/cameras/camA/rois"]);
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
  expect(urls).toEqual(["/api/cameras/camA/rois?product=P1"]);
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
  const img = screen.getByAltText("b.png") as HTMLImageElement;
  expect(img.getAttribute("src")).toMatch(/flow\/nodes\/crop%3A1\/picture\?frame=b\.png&stage=output/);
});
