import { createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import DetectorView from "./views/DetectorView";

const EXEMPLAR = { frame: "f1.png", box: { x: 0.2, y: 0.2, w: 0.2, h: 0.2 } };
let calls: { url: string; method: string; body?: any }[];
let detections: any;
let infoExtra: object;

function install(savedDetector: any) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url.endsWith("/vision/filters")) return new Response(JSON.stringify({ filters: {} }));
      if (url.endsWith("/vision/detector"))
        return new Response(JSON.stringify({ available: true, model: "m", max_exemplars: 3, topk: [1, 5], ...infoExtra }));
      if (url.includes("/detections") && method === "GET") {
        const reviewOnly = url.includes("review_only=true");
        const frames = detections.frames.filter(
          (f: any) => !reviewOnly || f.state === "review" || f.state === "none",
        );
        return new Response(JSON.stringify({ ...detections, frames }));
      }
      if (url.includes("/detections") && method === "PUT") return new Response('{"ok":true}');
      if (url.includes("/detections") && method === "DELETE") return new Response('{"ok":true}');
      if (url.endsWith("/detect"))
        return new Response(JSON.stringify({ id: "j1", status: "queued", progress: {}, result: null, error: null }));
      if (url.includes("/jobs/j1"))
        return new Response(
          JSON.stringify({ id: "j1", status: "done", progress: {}, error: null, result: { detected: 3, needs_review: 1, skipped_human: 0 } }),
        );
      if (url.includes("/versions/features")) return new Response(JSON.stringify([{ feature: "seal", label: "seal" }]));
      if (url.includes("/frames"))
        return new Response(JSON.stringify({ frames: ["f1.png"], showing_all: false, total: 1, reference_frame: null }));
      if (url.endsWith("/preview")) return { ok: true, blob: async () => new Blob(["x"]) } as unknown as Response;
      if (url.includes("/vision/seal") && method === "PUT") return new Response(init!.body as string);
      if (url.includes("/vision/seal"))
        return new Response(JSON.stringify({ filter: null, mask: null, detector: savedDetector }));
      return new Response("{}", { status: 404 });
    }),
  );
}

function pointer(target: Element, type: string, clientX: number, clientY: number) {
  const ev = createEvent[type as "pointerDown"](target, { pointerId: 1, bubbles: true });
  Object.defineProperty(ev, "clientX", { value: clientX });
  Object.defineProperty(ev, "clientY", { value: clientY });
  fireEvent(target, ev);
}

beforeEach(() => {
  calls = [];
  detections = { threshold: 0.3, counts: {}, frames: [] };
  infoExtra = {};
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON() {},
  } as DOMRect);
});
afterEach(() => vi.unstubAllGlobals());

test("drawing a box adds an exemplar that is saved with the settings", async () => {
  install(null);
  render(<DetectorView camera="camA" />);
  await userEvent.click(await screen.findByRole("tab", { name: /Detector/ }));
  const canvas = (await screen.findAllByTestId("roi-canvas"))[0];
  expect(screen.getByText("No exemplars yet.")).toBeInTheDocument();
  pointer(canvas, "pointerDown", 20, 10);
  pointer(canvas, "pointerMove", 120, 60);
  pointer(canvas, "pointerUp", 120, 60);
  await userEvent.click(screen.getByRole("button", { name: "Add exemplar" }));
  expect(screen.getByRole("button", { name: "Remove exemplar 1" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Run detection" })).toBeEnabled(); // saves first
  await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await waitFor(() => {
    const put = calls.find((c) => c.method === "PUT" && c.url.endsWith("/vision/seal"));
    expect(put?.body.detector.exemplars[0]).toMatchObject({ frame: "f1.png" });
    expect(put?.body.detector.exemplars[0].box.w).toBeCloseTo(0.5);
    expect(put?.body.detector).toMatchObject({ topk: 1, threshold: 0.3 });
  });
});

test("running detection reports the result; the review queue accepts a box", async () => {
  detections = {
    threshold: 0.3,
    counts: { trusted: 2, review: 1 },
    frames: [{ frame: "f1.png", state: "review", status: "auto", boxes: [{ x: 0.1, y: 0.1, w: 0.3, h: 0.3, conf: 0.2 }] }],
  };
  install({ exemplars: [EXEMPLAR], topk: 2, threshold: 0.3 });
  render(<DetectorView camera="camA" />);
  await userEvent.click(await screen.findByRole("tab", { name: /Detector/ }));
  const run = await screen.findByRole("button", { name: "Run detection" });
  await waitFor(() => expect(run).toBeEnabled());
  await userEvent.click(run);
  expect(await screen.findByText(/Detected 3 frames, 1 need review/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Go to Review" }));

  const queue = await screen.findByRole("region", { name: "Review queue" });
  expect(within(queue).getByText(/Review \(1 to check, 2 trusted/)).toBeInTheDocument();
  await userEvent.click(within(queue).getByRole("button", { name: "Accept box" }));
  await waitFor(() => {
    const put = calls.find((c) => c.method === "PUT" && c.url.includes("/detections/f1.png"));
    expect(put?.body).toEqual({ box: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, status: "reviewed" });
  });
});

test("threshold and candidate count edit the detector settings", async () => {
  install({ exemplars: [EXEMPLAR], topk: 2, threshold: 0.3 });
  render(<DetectorView camera="camA" />);
  await userEvent.click(await screen.findByRole("tab", { name: /Detector/ }));
  const topk = await screen.findByLabelText("Candidates per frame");
  await waitFor(() => expect(topk).toHaveValue("2"));
  await userEvent.selectOptions(topk, "4");
  fireEvent.change(screen.getByLabelText("Confidence threshold"), { target: { value: "55" } });
  await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await waitFor(() => {
    const put = calls.find((c) => c.method === "PUT" && c.url.endsWith("/vision/seal"));
    expect(put?.body.detector).toMatchObject({ topk: 4, threshold: 0.55 });
  });
});

test("show-all lists every frame least confident first, with the confidence range", async () => {
  const frame = (name: string, conf: number, state: string) => ({
    frame: name, state, status: "auto", boxes: [{ x: 0.1, y: 0.1, w: 0.3, h: 0.3, conf }],
  });
  detections = {
    threshold: 0.5,
    counts: { trusted: 2 },
    frames: [frame("hi.png", 0.97, "trusted"), frame("mid.png", 0.71, "trusted")],
  };
  install({ exemplars: [EXEMPLAR], topk: 1, threshold: 0.5 });
  render(<DetectorView camera="camA" />);
  await userEvent.click(await screen.findByRole("tab", { name: /Review/ }));
  expect(await screen.findByText(/Review \(0 to check, 2 trusted/)).toBeInTheDocument();
  expect(screen.getByText("Nothing to review.")).toBeInTheDocument();
  await userEvent.click(screen.getByLabelText(/Show all frames/));
  expect(await screen.findByText(/71% to 97% \(threshold 50%\)/)).toBeInTheDocument();
  const options = within(screen.getByRole("combobox", { name: /^Frame/ })).getAllByRole("option");
  expect(options.map((o) => o.textContent)).toEqual([expect.stringContaining("mid.png"), expect.stringContaining("hi.png")]);
});

test("run detection saves unsaved settings first", async () => {
  install({ exemplars: [EXEMPLAR], topk: 2, threshold: 0.3 });
  render(<DetectorView camera="camA" />);
  await userEvent.click(await screen.findByRole("tab", { name: /Detector/ }));
  const topk = await screen.findByLabelText("Candidates per frame");
  await waitFor(() => expect(topk).toHaveValue("2"));
  await userEvent.selectOptions(topk, "3");
  await userEvent.click(screen.getByRole("button", { name: "Run detection" }));
  await waitFor(() => expect(calls.some((c) => c.url.endsWith("/detect"))).toBe(true));
  const put = calls.findIndex((c) => c.method === "PUT" && c.url.endsWith("/vision/seal"));
  const detect = calls.findIndex((c) => c.url.endsWith("/detect"));
  expect(put).toBeGreaterThan(-1);
  expect(put).toBeLessThan(detect);
});

test("review keyboard: Enter accepts, Delete clears, arrows switch frame", async () => {
  const row = (frame: string, x: number) => ({
    frame, state: "review", status: "auto", boxes: [{ x, y: 0.1, w: 0.3, h: 0.3, conf: 0.2 }],
  });
  detections = { threshold: 0.3, counts: { review: 2 }, frames: [row("a.png", 0.1), row("b.png", 0.2)] };
  install({ exemplars: [EXEMPLAR], topk: 1, threshold: 0.3 });
  render(<DetectorView camera="camA" />);
  await userEvent.click(await screen.findByRole("tab", { name: /Review/ }));
  const frame = await screen.findByRole("combobox", { name: /^Frame/ });
  await waitFor(() => expect(frame).toHaveValue("a.png"));
  await userEvent.keyboard("{ArrowRight}");
  await waitFor(() => expect(frame).toHaveValue("b.png"));
  await userEvent.keyboard("{ArrowLeft}");
  await waitFor(() => expect(frame).toHaveValue("a.png"));
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    const put = calls.find((c) => c.method === "PUT" && c.url.includes("/detections/a.png"));
    expect(put?.body).toEqual({ box: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, status: "reviewed" });
  });
  await waitFor(() => expect(frame).toHaveValue("b.png")); // moves on to the next frame
  await userEvent.keyboard("{Delete}");
  await waitFor(() =>
    expect(calls.some((c) => c.method === "DELETE" && c.url.includes("/detections/b.png"))).toBe(true),
  );
});

test("the frame strip draws the detected box on each thumbnail", async () => {
  detections = {
    threshold: 0.3,
    counts: { trusted: 1 },
    frames: [{ frame: "f1.png", state: "trusted", status: "auto", boxes: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.4, conf: 0.9 }] }],
  };
  install({ exemplars: [EXEMPLAR], topk: 1, threshold: 0.3 });
  render(<DetectorView camera="camA" />);
  const box = await screen.findByTestId("strip-box-f1.png");
  expect(box).toHaveStyle({ left: "10%", top: "20%", width: "30%", height: "40%" });
});

test("opening the Mask step shows the first exemplar's frame", async () => {
  install({ exemplars: [{ frame: "f1.png", box: EXEMPLAR.box }], topk: 1, threshold: 0.3 });
  render(<DetectorView camera="camA" />);
  await userEvent.click(await screen.findByRole("tab", { name: /Mask/ }));
  expect(await screen.findByText(/The mask follows the detected object/)).toBeInTheDocument();
});

const MISSING_MODEL = { model_cached: false, download_mb: 600, download_source: "huggingface.co", cache_dir: "/home/u/.cache/huggingface/hub" };

test("a missing model asks for confirmation, with size and source, before anything is downloaded", async () => {
  infoExtra = MISSING_MODEL;
  install({ exemplars: [EXEMPLAR], topk: 1, threshold: 0.3 });
  render(<DetectorView camera="camA" />);
  await userEvent.click(await screen.findByRole("tab", { name: /Detector/ }));
  expect(await screen.findByText(/First run downloads the model \(about 600 MB\)/)).toBeInTheDocument();
  const run = screen.getByRole("button", { name: "Run detection" });
  await waitFor(() => expect(run).toBeEnabled());
  await userEvent.click(run);
  const dialog = await screen.findByRole("alertdialog", { name: "Model download" });
  expect(dialog).toHaveTextContent("about 600 MB");
  expect(dialog).toHaveTextContent("huggingface.co");
  expect(dialog).toHaveTextContent("/home/u/.cache/huggingface/hub");
  expect(calls.some((c) => c.url.endsWith("/detect"))).toBe(false);
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(calls.some((c) => c.url.endsWith("/detect"))).toBe(false);
});

test("agreeing to the download starts detection with the confirmation flag", async () => {
  infoExtra = MISSING_MODEL;
  install({ exemplars: [EXEMPLAR], topk: 1, threshold: 0.3 });
  render(<DetectorView camera="camA" />);
  await userEvent.click(await screen.findByRole("tab", { name: /Detector/ }));
  const run = await screen.findByRole("button", { name: "Run detection" });
  await waitFor(() => expect(run).toBeEnabled());
  await userEvent.click(run);
  await userEvent.click(await screen.findByRole("button", { name: "Download and run" }));
  await waitFor(() => {
    const detect = calls.find((c) => c.url.endsWith("/detect"));
    expect(detect?.body).toEqual({ accept_download: true });
  });
});

test("a cached model runs without any prompt", async () => {
  infoExtra = { model_cached: true };
  install({ exemplars: [EXEMPLAR], topk: 1, threshold: 0.3 });
  render(<DetectorView camera="camA" />);
  await userEvent.click(await screen.findByRole("tab", { name: /Detector/ }));
  const run = await screen.findByRole("button", { name: "Run detection" });
  await waitFor(() => expect(run).toBeEnabled());
  await userEvent.click(run);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await waitFor(() => expect(calls.some((c) => c.url.endsWith("/detect"))).toBe(true));
});
