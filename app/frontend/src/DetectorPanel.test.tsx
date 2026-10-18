import { createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { endReviewPaint } from "./reviewPaint";
import DetectorView from "./views/DetectorView";

const EXEMPLAR = { frame: "f1.png", box: { x: 0.2, y: 0.2, w: 0.2, h: 0.2 } };
let calls: { url: string; method: string; body?: any }[];
let detections: any;
let infoExtra: object;
let saveGate: Promise<void> | null; // holds the server's answer to a decision, to see what the screen does meanwhile
let saveFails: boolean;

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
      if (url.includes("/classify/delete") || url.includes("/classify/restore")) {
        if (saveFails) return new Response(JSON.stringify({ detail: "disk full" }), { status: 500 });
        const frame = JSON.parse(init!.body as string).frame;
        return new Response(JSON.stringify({ card: { frame, label: null, golden: null, deleted: url.includes("/delete") }, counts: {} }));
      }
      if (url.includes("/detections") && method !== "GET") {
        if (saveGate) await saveGate;
        if (saveFails) return new Response(JSON.stringify({ detail: "disk full" }), { status: 500 });
        // the server remembers what was decided
        const frame = decodeURIComponent(url.split("/detections/")[1]?.split("/")[0] ?? "");
        const row = detections.frames.find((f: any) => f.frame === frame);
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        if (row && method === "PUT") Object.assign(row, { state: "human", status: body.status, boxes: [{ ...body.box, conf: row.boxes[0]?.conf ?? 1 }] });
        else if (row && method === "DELETE") Object.assign(row, { state: "none", status: null, boxes: [] });
        else if (row && method === "POST")
          Object.assign(row, { state: body.rows.length ? "review" : "none", status: body.rows[0]?.status ?? null, boxes: body.rows.map(({ status, ...b }: any) => b) });
        return new Response('{"ok":true}');
      }
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
  saveGate = null;
  saveFails = false;
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON() {},
  } as DOMRect);
});
afterEach(() => {
  endReviewPaint();
  vi.unstubAllGlobals();
});

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
  expect(within(queue).getByRole("option", { name: "Needs review (1)" })).toBeInTheDocument();
  expect(within(queue).getByRole("option", { name: "Trusted (0)" })).toBeInTheDocument(); // counted from the frames listed
  await userEvent.click(within(await screen.findByTestId("review-card-f1.png")).getByRole("button", { name: /Accept/ }));
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

test("the input size is a choice between the model's own size and a faster one, saved with the settings", async () => {
  install({ exemplars: [EXEMPLAR], topk: 2, threshold: 0.3, method: "model", size: 768 });
  render(<DetectorView camera="camA" />);
  await userEvent.click(await screen.findByRole("tab", { name: /Detector/ }));
  const size = await screen.findByLabelText("Input size");
  await waitFor(() => expect(size).toHaveValue("768"));
  expect(within(size).getAllByRole("option").map((o) => o.textContent)).toEqual(["768 (precise)", "512 (about 2x faster, boxes less exact)"]);
  await userEvent.selectOptions(size, "512");
  await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await waitFor(() => {
    const put = calls.find((c) => c.method === "PUT" && c.url.endsWith("/vision/seal"));
    expect(put?.body.detector).toMatchObject({ size: 512 });
  });
});

test("a detector saved before the size existed shows the model's own size", async () => {
  install({ exemplars: [EXEMPLAR], topk: 2, threshold: 0.3, method: "model" });
  render(<DetectorView camera="camA" />);
  await userEvent.click(await screen.findByRole("tab", { name: /Detector/ }));
  await waitFor(async () => expect(await screen.findByLabelText("Input size")).toHaveValue("768"));
});

test("the method is template matching by default, saved with the settings, and the model-only options appear only for the model", async () => {
  install({ exemplars: [EXEMPLAR], topk: 2, threshold: 0.3 });
  render(<DetectorView camera="camA" />);
  await userEvent.click(await screen.findByRole("tab", { name: /Detector/ }));
  const method = await screen.findByLabelText("Method");
  await waitFor(() => expect(method).toHaveValue("template"));
  expect(within(method).getAllByRole("option").map((o) => o.textContent)).toEqual(["Template matching (fast, exact size)", "Model (OWL-ViT)"]);
  expect(screen.queryByLabelText("Input size")).toBeNull();
  await userEvent.selectOptions(method, "model");
  expect(screen.getByLabelText("Input size")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await waitFor(() => {
    const put = calls.find((c) => c.method === "PUT" && c.url.endsWith("/vision/seal"));
    expect(put?.body.detector).toMatchObject({ method: "model" });
  });
});

test("template matching needs no model: no download prompt and no missing-dependency warning", async () => {
  infoExtra = { ...MISSING_MODEL, available: false };
  install({ exemplars: [EXEMPLAR], topk: 1, threshold: 0.3, method: "template" });
  render(<DetectorView camera="camA" />);
  await userEvent.click(await screen.findByRole("tab", { name: /Detector/ }));
  const run = await screen.findByRole("button", { name: "Run detection" });
  await waitFor(() => expect(run).toBeEnabled());
  expect(screen.queryByText(/First run downloads the model/)).toBeNull();
  expect(screen.queryByText(/Detector dependencies are missing/)).toBeNull();
  await userEvent.click(run);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await waitFor(() => expect(calls.some((c) => c.url.endsWith("/detect"))).toBe(true));
  expect(calls.find((c) => c.url.endsWith("/detect"))?.body?.accept_download).not.toBe(true); // nothing to confirm
});

test("All frames lists every frame, least confident first by default", async () => {
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
  expect(await screen.findByRole("option", { name: "Needs review (0)" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "Trusted (2)" })).toBeInTheDocument();
  expect(screen.getByText("Nothing here.")).toBeInTheDocument();
  await userEvent.selectOptions(screen.getByLabelText("Show"), "all");
  const cards = within(await screen.findByLabelText("Review grid")).getAllByTestId(/^review-card-/);
  expect(cards.map((c) => c.getAttribute("data-testid"))).toEqual(["review-card-mid.png", "review-card-hi.png"]); // least confident first
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

const reviewRows = () => {
  const row = (frame: string, x: number) => ({ frame, state: "review", status: "auto", boxes: [{ x, y: 0.1, w: 0.3, h: 0.3, conf: 0.2 }] });
  return { threshold: 0.3, counts: { review: 2 }, frames: [row("a.png", 0.1), row("b.png", 0.2)] };
};

test("the review queue is a grid of cards with the detected box, state, confidence and Accept / Clear buttons", async () => {
  detections = reviewRows();
  install({ exemplars: [EXEMPLAR], topk: 1, threshold: 0.3 });
  render(<DetectorView camera="camA" />);
  await userEvent.click(await screen.findByRole("tab", { name: /Review/ }));
  const card = await screen.findByTestId("review-card-a.png");
  expect(card).toHaveTextContent("unsure · 20%");
  expect(within(card).getByTestId("review-box-a.png")).toHaveStyle({ left: "10%", top: "10%", width: "30%", height: "30%" });
  expect(screen.getByTestId("review-card-b.png")).toBeInTheDocument();
  expect(screen.queryByRole("group", { name: "Frame strip" })).toBeNull(); // the thumbnail strip is gone from Review
  expect(screen.getByRole("navigation", { name: "Pagination review top" })).toBeInTheDocument();
  await userEvent.click(within(card).getByRole("button", { name: /Clear/ }));
  await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url.includes("/detections/a.png"))).toBe(true));
});

async function openReview() {
  render(<DetectorView camera="camA" />);
  await userEvent.click(await screen.findByRole("tab", { name: /Review/ }));
}

test("a decision shows at once and the card stays where it is, even while the save is still on its way", async () => {
  detections = reviewRows();
  let release!: () => void;
  saveGate = new Promise<void>((r) => (release = r));
  install({ exemplars: [EXEMPLAR], topk: 1, threshold: 0.3 });
  await openReview();
  const card = await screen.findByTestId("review-card-a.png");
  await userEvent.click(within(card).getByRole("button", { name: /Accept/ }));
  expect(card).toHaveTextContent("decided"); // before the server has answered
  expect(within(card).getByRole("button", { name: "Accept box" })).toBeDisabled();
  expect(screen.getByTestId("review-card-a.png")).toBe(card); // the same card, in the same place
  expect(screen.getByTestId("review-card-b.png")).toBeInTheDocument();
  release();
  await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.url.includes("/detections/a.png"))).toBe(true));
  expect(screen.getByTestId("review-card-a.png")).toBe(card); // and still there after the save
});

test("Remove decided takes the decided cards out of the grid", async () => {
  detections = reviewRows();
  install({ exemplars: [EXEMPLAR], topk: 1, threshold: 0.3 });
  await openReview();
  expect(screen.queryByRole("button", { name: "Remove them" })).toBeNull();
  detections = { ...reviewRows(), counts: { review: 1, human: 1 }, frames: [{ ...reviewRows().frames[0], state: "human", status: "reviewed" }, reviewRows().frames[1]] }; // what the server will say
  await userEvent.click(within(await screen.findByTestId("review-card-a.png")).getByRole("button", { name: /Accept/ }));
  const remove = await screen.findByRole("button", { name: "Remove them" });
  expect(screen.getByTestId("review-card-a.png")).toBeInTheDocument();
  await userEvent.click(remove);
  await waitFor(() => expect(screen.queryByTestId("review-card-a.png")).toBeNull());
  expect(screen.getByTestId("review-card-b.png")).toBeInTheDocument();
});

test("undo (button or Z) puts a decision back as it was, through the restore call", async () => {
  detections = reviewRows();
  install({ exemplars: [EXEMPLAR], topk: 1, threshold: 0.3 });
  await openReview();
  const card = await screen.findByTestId("review-card-a.png");
  expect(within(card).queryByRole("button", { name: /Undo/ })).toBeNull();
  await userEvent.click(within(card).getByRole("button", { name: /Accept/ }));
  expect(card).toHaveTextContent("decided");
  await userEvent.hover(card);
  await userEvent.keyboard("z");
  expect(card).toHaveTextContent("unsure · 20%");
  await waitFor(() => {
    const restore = calls.find((c) => c.method === "POST" && c.url.endsWith("/detections/a.png/restore"));
    expect(restore?.body).toEqual({ rows: [{ x: 0.1, y: 0.1, w: 0.3, h: 0.3, conf: 0.2, status: "auto" }] });
  });
  expect(within(card).queryByRole("button", { name: /Undo/ })).toBeNull();
});

test("a failed save puts the card back and says so", async () => {
  detections = reviewRows();
  saveFails = true;
  install({ exemplars: [EXEMPLAR], topk: 1, threshold: 0.3 });
  await openReview();
  const card = await screen.findByTestId("review-card-a.png");
  await userEvent.click(within(card).getByRole("button", { name: /Accept/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/disk full/);
  await waitFor(() => expect(card).toHaveTextContent("unsure · 20%"));
  expect(within(card).getByRole("button", { name: "Accept box" })).toBeEnabled();
});

test("deciding in the grid renders no preview of the frame behind it", async () => {
  detections = reviewRows();
  install({ exemplars: [EXEMPLAR], topk: 1, threshold: 0.3 });
  await openReview();
  await screen.findByTestId("review-card-a.png");
  await new Promise((r) => setTimeout(r, 400)); // longer than the preview's debounce
  calls.length = 0;
  await userEvent.click(within(screen.getByTestId("review-card-a.png")).getByRole("button", { name: /Accept/ }));
  await userEvent.click(within(screen.getByTestId("review-card-b.png")).getByRole("button", { name: /Clear/ }));
  await new Promise((r) => setTimeout(r, 400));
  expect(calls.some((c) => c.url.endsWith("/preview"))).toBe(false);
});

test("the card buttons are icons only, with what they do and the key in the hover hint", async () => {
  detections = reviewRows();
  install({ exemplars: [EXEMPLAR], topk: 1, threshold: 0.3 });
  await openReview();
  const card = await screen.findByTestId("review-card-a.png");
  const buttons = within(card).getAllByRole("button").filter((b) => !/^Adjust /.test(b.getAttribute("aria-label") ?? ""));
  expect(buttons.map((b) => b.textContent)).toEqual(["✓", "✕", "🗑"]); // no words; the undo icon only once there is something to undo
  expect(within(card).getByRole("button", { name: "Accept box" })).toHaveAttribute("title", expect.stringContaining("Enter or A"));
  expect(within(card).getByRole("button", { name: "Clear box" })).toHaveAttribute("title", expect.stringContaining("X"));
  expect(within(card).getByRole("button", { name: "Delete picture" })).toHaveAttribute("title", expect.stringContaining("Delete"));
  await userEvent.click(within(card).getByRole("button", { name: "Accept box" }));
  expect(within(card).getByRole("button", { name: "Undo" })).toHaveTextContent("↶");
});

test("Delete on a hovered card or its button deletes the picture like everywhere else; the card stays, dimmed, and Z or the undo icon brings it back", async () => {
  detections = reviewRows();
  install({ exemplars: [EXEMPLAR], topk: 1, threshold: 0.3 });
  await openReview();
  await userEvent.hover(await screen.findByTestId("review-card-a.png"));
  await userEvent.keyboard("{Delete}");
  await waitFor(() => expect(calls.find((c) => c.url.endsWith("/classify/delete"))?.body).toEqual({ feature: "seal", frame: "a.png", via: "Detector" }));
  const card = screen.getByTestId("review-card-a.png"); // still in its place
  expect(card).toHaveTextContent("deleted");
  expect(within(card).getByRole("button", { name: "Accept box" })).toBeDisabled();
  expect(within(card).getByRole("button", { name: "Delete picture" })).toBeDisabled();
  expect(calls.some((c) => c.method === "DELETE" && c.url.includes("/detections/"))).toBe(false); // the box is not cleared, the picture is deleted
  await userEvent.keyboard("a"); // a deleted card takes nothing but undo
  expect(calls.some((c) => c.method === "PUT" && c.url.includes("/detections/"))).toBe(false);
  await userEvent.keyboard("z");
  await waitFor(() => expect(calls.find((c) => c.url.endsWith("/classify/restore"))?.body).toMatchObject({ frame: "a.png" }));
  await waitFor(() => expect(card).not.toHaveTextContent("deleted"));
  await userEvent.click(within(card).getByRole("button", { name: "Delete picture" }));
  await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/classify/delete")).length).toBe(2));
});

test("a failed delete puts the card back and says so", async () => {
  detections = reviewRows();
  saveFails = true;
  install({ exemplars: [EXEMPLAR], topk: 1, threshold: 0.3 });
  await openReview();
  const card = await screen.findByTestId("review-card-a.png");
  await userEvent.click(within(card).getByRole("button", { name: "Delete picture" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/disk full/);
  await waitFor(() => expect(card).not.toHaveTextContent("deleted"));
});

test("undoing is never painted: holding Z and sweeping over decided cards does nothing", async () => {
  detections = reviewRows();
  install({ exemplars: [EXEMPLAR], topk: 1, threshold: 0.3 });
  await openReview();
  await userEvent.click(within(await screen.findByTestId("review-card-a.png")).getByRole("button", { name: "Accept box" }));
  await userEvent.click(within(screen.getByTestId("review-card-b.png")).getByRole("button", { name: "Accept box" }));
  await waitFor(() => expect(puts()).toEqual(["a.png", "b.png"]));
  fireEvent.mouseLeave(screen.getByTestId("review-card-a.png")); // the pointer is on no card: only a sweep could act
  fireEvent.mouseLeave(screen.getByTestId("review-card-b.png"));
  fireEvent.keyDown(window, { key: "z" });
  sweep("a.png");
  sweep("b.png");
  await new Promise((r) => setTimeout(r, 50));
  fireEvent.keyUp(window, { key: "z" });
  expect(calls.filter((c) => c.url.endsWith("/restore")).map((c) => c.url)).toEqual([]);
});

test("the filter lists what you ask for and says how many each has; the order can be changed; both are remembered", async () => {
  const row = (frame: string, state: string, status: string | null, conf: number | null, x = 0.1) => ({ frame, state, status, boxes: conf === null ? [] : [{ x, y: 0.1, w: 0.2, h: 0.2, conf }] });
  detections = {
    threshold: 0.3,
    counts: { review: 2, trusted: 1, human: 2, none: 1 },
    frames: [row("u1.png", "review", "auto", 0.2), row("u2.png", "review", "auto", 0.4, 0.6), row("t.png", "trusted", "auto", 0.9), row("acc.png", "human", "reviewed", 0.7), row("adj.png", "human", "manual", 0.5), row("n.png", "none", null, null)],
  };
  install({ exemplars: [EXEMPLAR], topk: 1, threshold: 0.3 });
  await openReview();
  const show = await screen.findByLabelText("Show");
  const names = () => within(screen.getByLabelText("Review grid")).queryAllByTestId(/^review-card-/).map((c) => c.getAttribute("data-testid")!.replace("review-card-", ""));
  expect(within(show).getAllByRole("option").map((o) => o.textContent)).toEqual([
    "Needs review (3)", "Unsure (2)", "No detection (1)", "Trusted (1)", "Accepted (1)", "Adjusted by me (1)", "All frames (6)",
  ]);
  expect(names()).toEqual(["n.png", "u1.png", "u2.png"]); // needs review, least confident first
  await userEvent.selectOptions(show, "trusted");
  expect(names()).toEqual(["t.png"]);
  await userEvent.selectOptions(show, "accepted");
  expect(names()).toEqual(["acc.png"]);
  await userEvent.selectOptions(show, "adjusted");
  expect(names()).toEqual(["adj.png"]);
  await userEvent.selectOptions(show, "all");
  await userEvent.selectOptions(screen.getByLabelText("Sort"), "most");
  expect(names()).toEqual(["t.png", "acc.png", "adj.png", "u2.png", "u1.png", "n.png"]);
  await userEvent.selectOptions(screen.getByLabelText("Sort"), "name");
  expect(names()).toEqual(["acc.png", "adj.png", "n.png", "t.png", "u1.png", "u2.png"]);
  await userEvent.selectOptions(screen.getByLabelText("Sort"), "far"); // the exemplar's centre is (0.3, 0.3)
  expect(names()[0]).toBe("u2.png"); // the box at x 0.6 is the furthest
  expect(names().at(-1)).toBe("n.png"); // no box: last
  // remembered for the next visit
  expect(localStorage.getItem("picturesorter.review.filter")).toBe("all");
  expect(localStorage.getItem("picturesorter.review.sort")).toBe("far");
});

test("the editor deletes the picture on Delete and the box on X, and undoes on Z", async () => {
  detections = reviewRows();
  install({ exemplars: [EXEMPLAR], topk: 1, threshold: 0.3 });
  await openReview();
  await userEvent.click(await screen.findByRole("button", { name: "Adjust a.png" }));
  const viewer = await screen.findByTestId("box-editor");
  expect(within(within(viewer).getByRole("group", { name: "Decide" })).getAllByRole("button").map((b) => b.textContent)).toEqual(["✓", "✕", "🗑"]); // icons only
  await userEvent.keyboard("{Delete}");
  await waitFor(() => expect(calls.find((c) => c.url.endsWith("/classify/delete"))?.body).toMatchObject({ frame: "a.png", via: "Detector" }));
  await waitFor(() => expect(within(viewer).getByTestId("viewer-filename")).toHaveTextContent("b.png")); // moved on
  await userEvent.keyboard("x");
  await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url.includes("/detections/b.png"))).toBe(true));
});

test("the review header has the two choices and a hover hint, and no keys written out on the page", async () => {
  detections = reviewRows();
  install({ exemplars: [EXEMPLAR], topk: 1, threshold: 0.3 });
  await openReview();
  const panel = await screen.findByRole("region", { name: "Review queue" });
  expect(within(panel).getByLabelText("Show")).toBeInTheDocument();
  expect(within(panel).getByLabelText("Sort")).toBeInTheDocument();
  const tip = within(panel).getByRole("button", { name: "Info: Review keys" });
  expect(tip).toHaveAccessibleDescription(/Hold A or X and move the mouse across the cards/);
  expect(screen.queryByText(/Shortcuts/)).toBeNull();
});

test("the editor is the shared picture viewer: file name under the picture, position, hints", async () => {
  detections = reviewRows();
  install({ exemplars: [EXEMPLAR], topk: 1, threshold: 0.3 });
  await openReview();
  await userEvent.click(await screen.findByRole("button", { name: "Adjust b.png" }));
  const viewer = await screen.findByTestId("box-editor");
  expect(within(viewer).getByTestId("viewer-filename")).toHaveTextContent("b.png");
  expect(within(viewer).getByTestId("viewer-position")).toHaveTextContent("2 / 2");
  expect(within(viewer).getByRole("button", { name: "Previous picture" })).toBeEnabled();
  expect(within(viewer).getByRole("button", { name: "Next picture" })).toBeDisabled();
  await userEvent.click(within(viewer).getByRole("button", { name: "Previous picture" }));
  expect(within(viewer).getByTestId("viewer-filename")).toHaveTextContent("a.png");
  await userEvent.click(within(viewer).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByTestId("box-editor")).toBeNull());
});

test("hover keys act on the card under the mouse: Enter or A accepts, X clears the box", async () => {
  detections = reviewRows();
  install({ exemplars: [EXEMPLAR], topk: 1, threshold: 0.3 });
  render(<DetectorView camera="camA" />);
  await userEvent.click(await screen.findByRole("tab", { name: /Review/ }));
  await userEvent.hover(await screen.findByTestId("review-card-a.png"));
  await userEvent.keyboard("a");
  await waitFor(() => {
    const put = calls.find((c) => c.method === "PUT" && c.url.includes("/detections/a.png"));
    expect(put?.body).toEqual({ box: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, status: "reviewed" });
  });
  await userEvent.unhover(screen.getByTestId("review-card-a.png"));
  await userEvent.hover(screen.getByTestId("review-card-b.png"));
  await userEvent.keyboard("x");
  await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url.includes("/detections/b.png"))).toBe(true));
  expect(calls.some((c) => c.method === "DELETE" && c.url.includes("/detections/a.png"))).toBe(false); // only the hovered card
});

const sweepRows = () => {
  const row = (frame: string, state: string, status: string) => ({ frame, state, status, boxes: [{ x: 0.1, y: 0.1, w: 0.3, h: 0.3, conf: 0.2 }] });
  return { threshold: 0.3, counts: { review: 3, human: 1 }, frames: [row("a.png", "review", "auto"), row("b.png", "review", "auto"), row("c.png", "human", "reviewed"), row("d.png", "review", "auto")] };
};
const sweep = (frame: string) => fireEvent.mouseMove(screen.getByTestId(`review-card-${frame}`), { movementX: 6, movementY: 2 });
const puts = () => calls.filter((c) => c.method === "PUT" && c.url.includes("/detections/")).map((c) => c.url.split("/detections/")[1]);
const pictureDeletes = () => calls.filter((c) => c.url.endsWith("/classify/delete")).map((c) => c.body.frame);
const deletes = () => calls.filter((c) => c.method === "DELETE").map((c) => c.url.split("/detections/")[1]);

test("holding A and sweeping the mouse over the cards accepts each one the pointer enters, once, and leaves decided cards alone", async () => {
  detections = sweepRows();
  install({ exemplars: [EXEMPLAR], topk: 1, threshold: 0.3 });
  await openReview();
  await userEvent.selectOptions(await screen.findByLabelText("Show"), "all"); // the decided card is only listed then
  await screen.findByTestId("review-card-c.png");
  fireEvent.keyDown(window, { key: "a" });
  for (const f of ["a.png", "b.png", "c.png", "d.png"]) sweep(f);
  await waitFor(() => expect(puts()).toEqual(["a.png", "b.png", "d.png"])); // c.png was already decided
  sweep("a.png");
  sweep("b.png"); // again in the same stroke: nothing more
  expect(puts()).toHaveLength(3);
  fireEvent.keyUp(window, { key: "a" });
  expect(document.documentElement.classList.contains("painting")).toBe(false);
});

test("the sweep cursor is a green tick for A and a red cross for X, from the moment the key goes down over a card", async () => {
  detections = sweepRows();
  install({ exemplars: [EXEMPLAR], topk: 1, threshold: 0.3 });
  await openReview();
  await userEvent.hover(await screen.findByTestId("review-card-a.png"));
  const cursor = () => (document.documentElement.classList.contains("painting") ? decodeURIComponent(document.documentElement.style.getPropertyValue("--paint-cursor")) : null);
  expect(cursor()).toBeNull();
  fireEvent.keyDown(window, { key: "x" });
  expect(cursor()).toContain("#c0392b"); // before any move
  fireEvent.keyUp(window, { key: "x" });
  expect(cursor()).toBeNull();
  fireEvent.keyDown(window, { key: "a" });
  expect(cursor()).toContain("#2e9e5b");
  fireEvent.keyUp(window, { key: "a" });
});

test("pressing A on a hovered card accepts it and the sweep carries on from there", async () => {
  detections = sweepRows();
  install({ exemplars: [EXEMPLAR], topk: 1, threshold: 0.3 });
  await openReview();
  await userEvent.hover(await screen.findByTestId("review-card-a.png"));
  fireEvent.keyDown(window, { key: "a" });
  await waitFor(() => expect(puts()).toEqual(["a.png"]));
  sweep("a.png"); // the pointer jittering on the card the key was pressed on does not act again
  sweep("b.png");
  await waitFor(() => expect(puts()).toEqual(["a.png", "b.png"]));
  expect(puts()).toHaveLength(2);
});

test("holding X and sweeping clears the boxes, never clears a box you accepted, and Delete is never painted", async () => {
  detections = sweepRows();
  install({ exemplars: [EXEMPLAR], topk: 1, threshold: 0.3 });
  await openReview();
  await userEvent.selectOptions(await screen.findByLabelText("Show"), "all");
  await screen.findByTestId("review-card-c.png");
  fireEvent.keyDown(window, { key: "x" });
  for (const f of ["a.png", "c.png", "b.png"]) sweep(f);
  await waitFor(() => expect(deletes()).toEqual(["a.png", "b.png"]));
  fireEvent.keyUp(window, { key: "x" });
  fireEvent.keyDown(window, { key: "Delete" }); // deleting a picture is a hover key only
  sweep("d.png");
  await new Promise((r) => setTimeout(r, 50));
  fireEvent.keyUp(window, { key: "Delete" });
  expect(deletes()).toEqual(["a.png", "b.png"]);
  expect(pictureDeletes()).toEqual([]);
  expect(puts()).toEqual([]);
});

test("moving the mouse without the key held, or a scroll under a still pointer, does nothing", async () => {
  detections = sweepRows();
  install({ exemplars: [EXEMPLAR], topk: 1, threshold: 0.3 });
  await openReview();
  await screen.findByTestId("review-card-a.png");
  sweep("a.png");
  fireEvent.keyDown(window, { key: "a" });
  fireEvent.mouseMove(screen.getByTestId("review-card-b.png"), { movementX: 0, movementY: 0 }); // cards scrolled under the pointer
  await new Promise((r) => setTimeout(r, 50));
  expect(puts()).toEqual([]);
});

test("a card with nothing detected cannot be accepted, only adjusted", async () => {
  detections = { threshold: 0.3, counts: { none: 1 }, frames: [{ frame: "n.png", state: "none", status: null, boxes: [] }] };
  install({ exemplars: [EXEMPLAR], topk: 1, threshold: 0.3 });
  render(<DetectorView camera="camA" />);
  await userEvent.click(await screen.findByRole("tab", { name: /Review/ }));
  const card = await screen.findByTestId("review-card-n.png");
  expect(within(card).getByRole("button", { name: /Accept/ })).toBeDisabled();
  expect(within(card).getByText(/no detection/)).toBeInTheDocument();
  expect(within(card).queryByTestId("review-box-n.png")).toBeNull();
});

test("the editor opens from a card (E or a click on the picture): Enter accepts and moves on, arrows switch frame, Esc closes", async () => {
  detections = reviewRows();
  install({ exemplars: [EXEMPLAR], topk: 1, threshold: 0.3 });
  render(<DetectorView camera="camA" />);
  await userEvent.click(await screen.findByRole("tab", { name: /Review/ }));
  expect(screen.queryByRole("dialog", { name: "Adjust detection" })).toBeNull();
  await userEvent.click(await screen.findByRole("button", { name: "Adjust a.png" }));
  const dialog = await screen.findByRole("dialog", { name: "Adjust detection" });
  expect(within(dialog).getByText("a.png")).toBeInTheDocument();
  await userEvent.keyboard("{ArrowRight}");
  await waitFor(() => expect(within(dialog).getByText("b.png")).toBeInTheDocument());
  await userEvent.keyboard("{ArrowLeft}");
  await waitFor(() => expect(within(dialog).getByText("a.png")).toBeInTheDocument());
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    const put = calls.find((c) => c.method === "PUT" && c.url.includes("/detections/a.png"));
    expect(put?.body).toEqual({ box: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, status: "reviewed" });
  });
  await waitFor(() => expect(within(dialog).getByText("b.png")).toBeInTheDocument()); // moves on to the next frame
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Adjust detection" })).toBeNull());
});

test("while the editor is open the hover keys do not act on the cards behind it", async () => {
  detections = reviewRows();
  install({ exemplars: [EXEMPLAR], topk: 1, threshold: 0.3 });
  render(<DetectorView camera="camA" />);
  await userEvent.click(await screen.findByRole("tab", { name: /Review/ }));
  await userEvent.hover(await screen.findByTestId("review-card-b.png"));
  await userEvent.click(await screen.findByRole("button", { name: "Adjust a.png" }));
  await screen.findByRole("dialog", { name: "Adjust detection" });
  await userEvent.keyboard("x"); // clears the editor's frame (a.png), not the hovered card
  await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url.includes("/detections/a.png"))).toBe(true));
  expect(calls.some((c) => c.method === "DELETE" && c.url.includes("/detections/b.png"))).toBe(false);
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
  install({ exemplars: [EXEMPLAR], topk: 1, threshold: 0.3, method: "model" });
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
  install({ exemplars: [EXEMPLAR], topk: 1, threshold: 0.3, method: "model" });
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

test("picture size slider scales the picture on every tab", async () => {
  localStorage.removeItem("detector.pictureSize");
  install({ exemplars: [EXEMPLAR], topk: 1, threshold: 0.3 });
  render(<DetectorView camera="camA" />);
  const slider = await screen.findByLabelText("Picture size");
  await userEvent.click(screen.getByRole("tab", { name: /Detector/ }));
  expect(await screen.findByTestId("roi-canvas")).toHaveStyle({ width: "560px" });
  fireEvent.change(slider, { target: { value: "900" } });
  expect(screen.getByTestId("roi-canvas")).toHaveStyle({ width: "900px" });
  await userEvent.click(screen.getByRole("tab", { name: /Filter/ }));
  expect((await screen.findByAltText("Filtered preview")).parentElement).toHaveStyle({ width: "900px" });
  await userEvent.click(screen.getByRole("tab", { name: /Mask/ }));
  await userEvent.selectOptions(await screen.findByLabelText("Shape"), "circle");
  expect((await screen.findByAltText("Crop to mask")).parentElement).toHaveStyle({ width: "900px" });
  localStorage.removeItem("detector.pictureSize");
});
