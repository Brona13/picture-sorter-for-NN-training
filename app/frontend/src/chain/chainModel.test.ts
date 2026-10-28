import { expect, test } from "vitest";
import type { ChainCanvas, ChainNode } from "../api";
import { connectAction, describeFlow, describeNode, disconnectAction, freshName, layoutOf, productOfHandle } from "./chainModel";

const node = (over: Partial<ChainNode>): ChainNode => ({
  id: "roi:x", kind: "roi", ref: "x", label: "x", x: 0, y: 0, role: "quality", scope: "camera", product: null,
  products: [], classes: ["OK", "NG"], frames: 4, labeled: 1, product_counts: {}, unlabeled: 0, ...over,
});

const canvas: ChainCanvas = {
  camera: "c",
  products: ["A", "B"],
  classify: "type",
  viewport: null,
  edges: [],
  nodes: [
    node({ id: "ingest", kind: "ingest", ref: null, role: null, scope: null }),
    node({ id: "roi:type", ref: "type", role: "classify", mode: "product", scope: "classify", classes: ["A", "B"], labeled: 3, unlabeled: 1, product_counts: { A: 2, B: 1 } }),
    node({ id: "roi:seal", ref: "seal", scope: "products", products: ["A"] }),
    node({ id: "roi:edge", ref: "edge" }),
    node({ id: "roi:B::rod", ref: "B::rod", scope: "name", product: "B", label: "rod" }),
  ],
};

test("a product handle adds its product to the feature", () => {
  expect(connectAction(canvas, { source: "roi:type", sourceHandle: "p:B", target: "roi:seal" })).toEqual({
    feature: "seal", products: ["A", "B"],
  });
  expect(connectAction(canvas, { source: "roi:type", sourceHandle: "p:A", target: "roi:edge" })).toEqual({
    feature: "edge", products: ["A"],
  });
});

test("the same product twice does not repeat it", () => {
  expect(connectAction(canvas, { source: "roi:type", sourceHandle: "p:A", target: "roi:seal" })).toEqual({
    feature: "seal", products: ["A"],
  });
});

test("an arrow from Ingest puts the feature back on the whole camera", () => {
  expect(connectAction(canvas, { source: "ingest", sourceHandle: null, target: "roi:seal" })).toEqual({
    feature: "seal", products: [],
  });
});

test("refuses arrows that mean nothing", () => {
  const bad = [
    { source: "roi:type", sourceHandle: null, target: "roi:seal" },
    { source: "roi:edge", sourceHandle: "p:OK", target: "roi:seal" }, // a feature Classifier's dots feed nothing yet
    { source: "roi:seal", sourceHandle: null, target: "roi:edge" },
    { source: "roi:seal", sourceHandle: null, target: "roi:type" }, // the product Classifier takes only Ingest
    { source: "ingest", sourceHandle: null, target: "ingest" },
    { source: "roi:type", sourceHandle: "p:A", target: "roi:B::rod" },
  ];
  for (const c of bad) expect(connectAction(canvas, c)).toHaveProperty("error");
});

test("a line from Ingest onto the product Classifier draws it again", () => {
  expect(connectAction(canvas, { source: "ingest", sourceHandle: null, target: "roi:type" })).toEqual({ feature: "type", products: [], attach: true });
});

test("the all dot puts every product on the feature; deleting that line sends it back to the whole camera", () => {
  expect(connectAction(canvas, { source: "roi:type", sourceHandle: "all", target: "roi:edge" })).toEqual({ feature: "edge", products: ["A", "B"] });
  expect(disconnectAction(canvas, { id: "e", source: "roi:type", source_handle: "all", target: "roi:seal", locked: false })).toEqual({ feature: "seal", products: [] });
});

test("deleting a product arrow drops that product; the last one means the whole camera", () => {
  const edge = { id: "e", source: "roi:type", source_handle: "p:A", target: "roi:seal", locked: false };
  expect(disconnectAction(canvas, edge)).toEqual({ feature: "seal", products: [] });
  const two = { ...canvas, nodes: canvas.nodes.map((n) => (n.id === "roi:seal" ? { ...n, products: ["A", "B"] } : n)) };
  expect(disconnectAction(two, edge)).toEqual({ feature: "seal", products: ["B"] });
});

test("a locked arrow cannot be deleted; the line from Ingest can (the box then hangs alone)", () => {
  expect(disconnectAction(canvas, { id: "l", source: "roi:type", source_handle: "p:B", target: "roi:B::rod", locked: true }))
    .toHaveProperty("error");
  expect(disconnectAction(canvas, { id: "i", source: "ingest", source_handle: null, target: "roi:edge", locked: false }))
    .toEqual({ feature: "edge", products: [], detach: true });
});

test("freshName picks the first free name, ignoring case", () => {
  expect(freshName("feature", [])).toBe("feature");
  expect(freshName("feature", ["Feature", "feature 2"])).toBe("feature 3");
});

test("productOfHandle", () => {
  expect(productOfHandle("p:4x4")).toBe("4x4");
  expect(productOfHandle(null)).toBeNull();
  expect(productOfHandle("out")).toBeNull();
});

test("layoutOf keeps a name only when there is one", () => {
  expect(layoutOf([{ id: "a", x: 1, y: 2, label: "Seal" }, { id: "b", x: 3, y: 4 }], null)).toEqual({
    nodes: { a: { x: 1, y: 2, label: "Seal" }, b: { x: 3, y: 4 } },
    viewport: null,
  });
});

test("describeNode", () => {
  expect(describeNode(canvas.nodes[0])).toBe("4 pictures");
  expect(describeNode(canvas.nodes[1])).toBe("Product · 3/4 labeled");
  expect(describeNode(canvas.nodes[2])).toBe("Feature · A · 1/4 labeled");
  expect(describeNode(canvas.nodes[3])).toBe("Feature · whole camera · 1/4 labeled");
  expect(describeNode(canvas.nodes[4])).toBe("Feature · B · 1/4 labeled");
});

import { flowConnect, isMergeLineEdge, mergeLineOf } from "./chainModel";

const flowCanvas: ChainCanvas = {
  ...canvas,
  nodes: [
    ...canvas.nodes,
    node({ id: "det:1", kind: "detector", ref: null, role: null, scope: null, label: "Detector 1" }),
    node({ id: "det:2", kind: "detector", ref: null, role: null, scope: null, label: "Detector 2" }),
    node({ id: "calc:1", kind: "calc", ref: null, role: null, scope: null, label: "Calculate 1" }),
    node({ id: "eval:1", kind: "evaluation", ref: null, role: null, scope: null, label: "Evaluation 1" }),
  ],
};
const link = (source: string, target: string) => ({ source, sourceHandle: null, target });

test("flowConnect accepts the typed chain Ingest -> detector -> detector -> Calculate -> Evaluation", () => {
  for (const [s, t] of [["ingest", "det:1"], ["det:1", "det:2"], ["det:2", "calc:1"], ["calc:1", "eval:1"]]) {
    expect(flowConnect(flowCanvas, link(s, t))).toEqual({ source: s, target: t });
  }
});

test("flowConnect refuses arrows whose types do not fit, and leaves ROI arrows to connectAction", () => {
  for (const [s, t] of [["eval:1", "calc:1"], ["det:1", "eval:1"], ["calc:1", "det:1"], ["ingest", "calc:1"], ["det:1", "det:1"], ["roi:type", "det:1"]]) {
    expect(flowConnect(flowCanvas, link(s, t))).toHaveProperty("error");
  }
  expect(flowConnect(flowCanvas, link("ingest", "roi:seal"))).toBeNull();
});

test("a Picture edits box dropped on an ROI becomes the ROI's input, also the Product Classifier's", () => {
  const withBox: ChainCanvas = { ...flowCanvas, nodes: [...flowCanvas.nodes, node({ id: "crop:1", kind: "crop", ref: null, role: null, scope: null, label: "Picture edits 1" })] };
  expect(flowConnect(withBox, link("crop:1", "roi:seal"))).toEqual({ roiInput: { feature: "seal", box: "crop:1" } });
  expect(flowConnect(withBox, link("crop:1", "roi:type"))).toEqual({ roiInput: { feature: "type", box: "crop:1" } });
  expect(flowConnect(withBox, { source: "crop:1", sourceHandle: "t:x", target: "roi:seal" })).toHaveProperty("error");
});

test("describeNode says what a flow box does", () => {
  const f = (over: object) => node({ kind: "evaluation", flow: over as ChainNode["flow"] });
  expect(describeNode(node({ kind: "detector", flow: { targets: ["A", "B"], status: "fresh", frames: 10, complete: 8 } }))).toBe("2 targets · 8/10 complete");
  expect(describeNode(node({ kind: "calc", flow: { op: "angle", a: "A", b: "B" } }))).toBe("angle A → B");
  expect(describeNode(f({ nominal: 175, tolerance: 3, unit: "deg", counts: { pass: 5, fail: 2, undetermined: 0 } }))).toBe("175 ± 3 deg · 5 pass, 2 fail");
  expect(describeNode(f({ nominal: null, tolerance: 3 }))).toBe("set the nominal");
});

test("a detector target's dot dropped on an ROI feature anchors it; the main handle and Classify boxes are refused; the anchor arrow is recognised", async () => {
  const { isAnchorEdge, targetHandle } = await import("./chainModel");
  expect(flowConnect(flowCanvas, { source: "det:1", sourceHandle: targetHandle("left hole"), target: "roi:seal" })).toEqual({
    anchor: { feature: "seal", detector: "det:1", target: "left hole" },
  });
  expect(flowConnect(flowCanvas, link("det:1", "roi:seal"))).toEqual({ error: expect.stringContaining("target dots") });
  expect(flowConnect(flowCanvas, { source: "det:1", sourceHandle: targetHandle("x"), target: "roi:type" })).toEqual({ anchor: { feature: "type", detector: "det:1", target: "x" } }); // the Product Classifier too
  expect(isAnchorEdge(flowCanvas, { id: "e", source: "det:1", source_handle: "t:left hole", target: "roi:seal", locked: false })).toBe(true);
  expect(isAnchorEdge(flowCanvas, { id: "e", source: "ingest", source_handle: null, target: "roi:seal", locked: false })).toBe(false);
});

test("the '(all)' dot of a target that looks for several elements anchors a Classifier on all its boxes, and feeds nothing else", async () => {
  const { targetHandle } = await import("./chainModel");
  const many: ChainCanvas = {
    ...flowCanvas,
    nodes: flowCanvas.nodes.map((n) => (n.id === "det:1" ? { ...n, flow: { targets: ["hole 1", "hole 2"], groups: ["hole"] } } : n)),
  };
  expect(flowConnect(many, { source: "det:1", sourceHandle: targetHandle("hole"), target: "roi:seal" })).toEqual({ anchor: { feature: "seal", detector: "det:1", target: "hole" } });
  expect(flowConnect(many, { source: "det:1", sourceHandle: targetHandle("hole 2"), target: "roi:seal" })).toEqual({ anchor: { feature: "seal", detector: "det:1", target: "hole 2" } });
  expect(flowConnect(many, { source: "det:1", sourceHandle: targetHandle("hole"), target: "calc:1" })).toEqual({ error: expect.stringContaining("only feed a Classifier") });
});

test("flowConnect: Ingest or a Crop feeds a Crop or a detector; nothing feeds Ingest, a Crop is not fed by a detector", () => {
  const withCrop: ChainCanvas = { ...flowCanvas, nodes: [...flowCanvas.nodes, node({ id: "crop:1", kind: "crop", ref: null, role: null, scope: null, label: "Crop 1" }), node({ id: "crop:2", kind: "crop", ref: null, role: null, scope: null, label: "Crop 2" })] };
  for (const [s, t] of [["ingest", "crop:1"], ["crop:1", "crop:2"], ["crop:2", "det:1"], ["crop:1", "det:2"]]) {
    expect(flowConnect(withCrop, link(s, t))).toEqual({ source: s, target: t });
  }
  for (const [s, t] of [["det:1", "crop:1"], ["crop:1", "calc:1"], ["crop:1", "eval:1"]]) {
    expect(flowConnect(withCrop, link(s, t))).toHaveProperty("error");
  }
  expect(describeNode(node({ kind: "crop", flow: { steps: [{ op: "crop", rect: [0, 0, 0.5, 0.25] }] } }))).toBe("50 × 25 % of the picture");
  expect(describeNode(node({ kind: "crop", flow: { steps: [{ op: "crop", rect: null }] } }))).toBe("no crop drawn yet");
});

test("flowConnect: a detector's main dot feeds the whole detector to Calculate, a target dot feeds one point; target dots feed nothing else", async () => {
  const { targetHandle } = await import("./chainModel");
  expect(flowConnect(flowCanvas, link("det:1", "calc:1"))).toEqual({ source: "det:1", target: "calc:1" });
  expect(flowConnect(flowCanvas, { source: "det:1", sourceHandle: targetHandle("left"), target: "calc:1" })).toEqual({ source: "det:1", target: "calc:1", point: "left" });
  expect(flowConnect(flowCanvas, { source: "det:1", sourceHandle: targetHandle("left"), target: "det:2" })).toHaveProperty("error");
});


test("flowConnect: a detector's target dot feeds a Crop (the Crop follows that target); the main dot does not", async () => {
  const { targetHandle } = await import("./chainModel");
  const withCrop: ChainCanvas = { ...flowCanvas, nodes: [...flowCanvas.nodes, node({ id: "crop:1", kind: "crop", ref: null, role: null, scope: null, label: "Crop 1" })] };
  expect(flowConnect(withCrop, { source: "det:1", sourceHandle: targetHandle("hole"), target: "crop:1" })).toEqual({ source: "det:1", target: "crop:1", point: "hole" });
  expect(flowConnect(withCrop, link("det:1", "crop:1"))).toEqual({ error: expect.stringContaining("one target") });
  expect(flowConnect(withCrop, { source: "ingest", sourceHandle: targetHandle("hole"), target: "crop:1" })).toHaveProperty("error");
});

test("describeNode: a Crop that follows a target says which and how big its rectangle is", () => {
  const follow = { detector: "det:1", target: "hole", size: [90, 80] as [number, number] };
  const steps = [{ op: "crop" as const, follows: true }];
  expect(describeNode(node({ kind: "crop", flow: { steps, follow } }))).toBe("follows hole · 90 × 80 px");
  expect(describeNode(node({ kind: "crop", flow: { steps, follow: { ...follow, size: null } } }))).toBe("follows hole · draw the rectangle");
});

test("describeNode: a Picture edits box lists its steps in order", () => {
  const steps = [{ op: "filter" as const, label: "Gaussian blur" }, { op: "crop" as const, rect: [0, 0, 0.5, 0.25] as [number, number, number, number] }, { op: "filter" as const, label: "Median blur" }];
  expect(describeNode(node({ kind: "crop", flow: { steps } }))).toBe("Gaussian blur → crop 50 × 25 % → Median blur");
  expect(describeNode(node({ kind: "crop", flow: { steps: [{ op: "filter", label: "Box filter" }] } }))).toBe("Box filter");
  expect(describeNode(node({ kind: "crop", flow: { steps: [{ op: "filter", label: "Box filter" }, { op: "crop", rect: null }] } }))).toBe("Box filter");
  expect(describeNode(node({ kind: "crop", flow: { steps: [] } }))).toBe("no steps yet");
});

test("Dedup boxes: Ingest / Picture edits / a Classifier dot feed them, they feed a Classifier, a detector or Picture edits, nothing else", () => {
  const withBox: ChainCanvas = {
    ...flowCanvas,
    nodes: [
      ...flowCanvas.nodes,
      node({ id: "dedup:1", kind: "dedup", ref: null, role: null, scope: null, label: "Dedup 1" }),
      node({ id: "crop:1", kind: "crop", ref: null, role: null, scope: null, label: "Picture edits 1" }),
    ],
  };
  expect(flowConnect(withBox, link("ingest", "dedup:1"))).toEqual({ source: "ingest", target: "dedup:1" });
  expect(flowConnect(withBox, link("crop:1", "dedup:1"))).toEqual({ source: "crop:1", target: "dedup:1" });
  expect(flowConnect(withBox, { source: "roi:seal", sourceHandle: "p:OK", target: "dedup:1" })).toEqual({ dedupSource: { box: "dedup:1", feature: "seal", dot: "OK" } });
  expect(flowConnect(withBox, link("dedup:1", "roi:seal"))).toEqual({ dedupInput: { feature: "seal", box: "dedup:1" } });
  expect(flowConnect(withBox, link("dedup:1", "det:1"))).toEqual({ source: "dedup:1", target: "det:1" });
  expect(flowConnect(withBox, link("dedup:1", "crop:1"))).toEqual({ source: "dedup:1", target: "crop:1" });
  for (const [s, t] of [["dedup:1", "calc:1"]]) {
    expect(flowConnect(withBox, link(s, t))).toHaveProperty("error");
  }
});

test("a Classifier dot feeds a detector or a Picture edits box, which then works on that dot's pictures", () => {
  const withBoxes: ChainCanvas = {
    ...flowCanvas,
    nodes: [
      ...flowCanvas.nodes,
      node({ id: "crop:9", kind: "crop", ref: null, role: null, scope: null, label: "Picture edits 9" }),
      node({ id: "det:9", kind: "detector", ref: null, role: null, scope: null, label: "Detector 9" }),
    ],
  };
  expect(flowConnect(withBoxes, { source: "roi:seal", sourceHandle: "p:OK", target: "det:9" })).toEqual({ dedupSource: { box: "det:9", feature: "seal", dot: "OK" } });
  expect(flowConnect(withBoxes, { source: "roi:seal", sourceHandle: "all", target: "crop:9" })).toEqual({ dedupSource: { box: "crop:9", feature: "seal", dot: "all" } });
  expect(flowConnect(withBoxes, { source: "roi:seal", sourceHandle: null, target: "det:9" })).toHaveProperty("error");
  expect(describeFlow("detector", { targets: ["P"], status: "none", source: { feature: "seal", dot: "OK" }, in_scope: 12 })).toBe("1 target · not run · OK · 12 pictures");
  expect(describeFlow("detector", { targets: ["P"], status: "none" })).toBe("1 target · not run");
});

test("an Evaluation dot feeds Dedup, Picture edits or a detector, and nothing else", () => {
  const withBoxes: ChainCanvas = {
    ...flowCanvas,
    nodes: [
      ...flowCanvas.nodes,
      node({ id: "eval:1", kind: "evaluation", ref: null, role: null, scope: null, label: "Evaluation 1" }),
      node({ id: "dedup:7", kind: "dedup", ref: null, role: null, scope: null, label: "Dedup 7" }),
      node({ id: "crop:7", kind: "crop", ref: null, role: null, scope: null, label: "Picture edits 7" }),
      node({ id: "det:7", kind: "detector", ref: null, role: null, scope: null, label: "Detector 7" }),
    ],
  };
  expect(flowConnect(withBoxes, { source: "eval:1", sourceHandle: "p:pass", target: "dedup:7" })).toEqual({ dedupSource: { box: "dedup:7", evaluation: "eval:1", dot: "pass" } });
  expect(flowConnect(withBoxes, { source: "eval:1", sourceHandle: "p:fail", target: "crop:7" })).toEqual({ dedupSource: { box: "crop:7", evaluation: "eval:1", dot: "fail" } });
  expect(flowConnect(withBoxes, { source: "eval:1", sourceHandle: "all", target: "det:7" })).toEqual({ dedupSource: { box: "det:7", evaluation: "eval:1", dot: "all" } });
  expect(flowConnect(withBoxes, { source: "eval:1", sourceHandle: null, target: "dedup:7" })).toHaveProperty("error");
  expect(flowConnect(withBoxes, { source: "eval:1", sourceHandle: "p:maybe", target: "dedup:7" })).toHaveProperty("error");
  // onto a Classifier its verdicts become the labels, whichever dot the line leaves from
  expect(flowConnect(withBoxes, { source: "eval:1", sourceHandle: "p:pass", target: "roi:seal" })).toEqual({ evaluationOf: { feature: "seal", box: "eval:1" } });
  expect(flowConnect(withBoxes, { source: "eval:1", sourceHandle: "all", target: "roi:seal" })).toEqual({ evaluationOf: { feature: "seal", box: "eval:1" } });
  expect(describeFlow("dedup", { eval_source: { box: "eval:1", dot: "pass" } } as never)).toContain("pass");
});

test("Calculate says how many points it has and what it needs", () => {
  expect(describeFlow("calc", { op: "angle", a: null, b: null })).toBe("needs two points · connect a detector with two targets");
  expect(describeFlow("calc", { op: "angle", a: "Detector 1 · P", b: null })).toBe("1 of 2 points (Detector 1 · P) · needs one more target");
  expect(describeFlow("calc", { op: "angle", a: "A", b: "B" })).toBe("angle A → B");
});

test("a detector target dot can be read by a Dedup box, the whole detector cannot", () => {
  const c: ChainCanvas = {
    ...flowCanvas,
    nodes: [...flowCanvas.nodes, node({ id: "dedup:1", kind: "dedup", ref: null, role: null, scope: null, label: "Dedup 1" })],
  };
  expect(flowConnect(c, { source: "det:1", sourceHandle: "t:P", target: "dedup:1" })).toEqual({ source: "det:1", target: "dedup:1", point: "P" });
  expect(flowConnect(c, { source: "det:1", sourceHandle: null, target: "dedup:1" })).toHaveProperty("error");
});

test("describeNode: an Evaluation behind an Offset says its zone", () => {
  const f = (flow: object) => node({ kind: "evaluation", flow: { mode: "zone", ...flow } });
  const counts = { pass: 5, fail: 2, undetermined: 0 };
  expect(describeNode(f({ zone: { shape: "circle", center: null, radius: 10, half: [10, 10] } }))).toBe("set the nominal and zone");
  expect(describeNode(f({ zone: { shape: "circle", center: [100, 0.04], radius: 6, half: [10, 10] }, counts }))).toBe("circle r 6 around nominal 100, 0 px · 5 pass, 2 fail");
  expect(describeNode(f({ zone: { shape: "rect", center: [1, 2], radius: 6, half: [10, 4] } }))).toBe("rectangle 20 × 8 around nominal 1, 2 px");
});

test("Export boxes: a Classifier or Evaluation dot or a passing box feeds the OK or NG input; nothing leaves Export", () => {
  const withExport: ChainCanvas = {
    ...flowCanvas,
    nodes: [
      ...flowCanvas.nodes,
      node({ id: "export:1", kind: "export", ref: null, role: null, scope: null, label: "Export" }),
      node({ id: "eval:1", kind: "evaluation", ref: null, role: null, scope: null, label: "Evaluation 1" }),
      node({ id: "dedup:1", kind: "dedup", ref: null, role: null, scope: null, label: "Dedup 1" }),
    ],
  };
  const to = (source: string, sourceHandle: string | null, targetHandle: string | null) => flowConnect(withExport, { source, sourceHandle, target: "export:1", targetHandle });
  expect(to("roi:seal", "p:OK", "in:ok")).toEqual({ exportLine: { box: "export:1", input: "ok", ref: { feature: "seal", dot: "OK" } } });
  expect(to("roi:seal", "all", "in:ng")).toEqual({ exportLine: { box: "export:1", input: "ng", ref: { feature: "seal", dot: "all" } } });
  expect(to("eval:1", "p:fail", "in:ng")).toEqual({ exportLine: { box: "export:1", input: "ng", ref: { box: "eval:1", dot: "fail" } } });
  expect(to("dedup:1", null, "in:ok")).toEqual({ exportLine: { box: "export:1", input: "ok", ref: { from: "dedup:1" } } });
  expect(to("ingest", null, "in:ok")).toEqual({ exportLine: { box: "export:1", input: "ok", ref: { from: "ingest" } } });
  expect(to("roi:seal", "p:OK", null)).toHaveProperty("error"); // no input chosen
  expect(to("eval:1", "p:maybe", "in:ok")).toHaveProperty("error");
  expect(flowConnect(withExport, { source: "export:1", sourceHandle: null, target: "dedup:1" })).toHaveProperty("error");
});

test("describeFlow: an Export box says its lines, counts and freeze", () => {
  expect(describeFlow("export", { lines: { ok: 0, ng: 0 } } as any)).toBe("connect lines to OK or NG");
  expect(describeFlow("export", { lines: { ok: 1, ng: 1 }, ok: 5, ng: 2, frozen: 3, changed: true } as any)).toBe("5 OK · 2 NG · frozen v3 (changed)");
});

const mergeCanvas: ChainCanvas = {
  ...flowCanvas,
  nodes: [
    ...flowCanvas.nodes,
    node({ id: "merge:1", kind: "merge", ref: null, role: null, scope: null, label: "Merge 1" }),
    node({ id: "merge:2", kind: "merge", ref: null, role: null, scope: null, label: "Merge 2" }),
    node({ id: "export:1", kind: "export", ref: null, role: null, scope: null, label: "Export 1" }),
  ],
};

test("a Classifier class dot, an Evaluation pass or fail and another Merge can be dropped on a Merge", () => {
  expect(flowConnect(mergeCanvas, { source: "roi:seal", sourceHandle: "p:OK", target: "merge:1" })).toEqual({ mergeLine: { box: "merge:1", ref: { feature: "seal", dot: "OK" } } });
  expect(flowConnect(mergeCanvas, { source: "eval:1", sourceHandle: "p:fail", target: "merge:1" })).toEqual({ mergeLine: { box: "merge:1", ref: { box: "eval:1", dot: "fail" } } });
  expect(flowConnect(mergeCanvas, { source: "merge:2", sourceHandle: null, target: "merge:1" })).toEqual({ mergeLine: { box: "merge:1", ref: { from: "merge:2" } } });
});

test("a Merge refuses what has no single meaning, with the reason", () => {
  const all = flowConnect(mergeCanvas, { source: "roi:seal", sourceHandle: "all", target: "merge:1" });
  expect(all).toHaveProperty("error");
  expect((all as { error: string }).error).toMatch(/all dot has no single meaning/);
  expect(flowConnect(mergeCanvas, { source: "eval:1", sourceHandle: "all", target: "merge:1" })).toHaveProperty("error");
  expect(flowConnect(mergeCanvas, { source: "det:1", sourceHandle: null, target: "merge:1" })).toHaveProperty("error");
  expect(flowConnect(mergeCanvas, { source: "merge:1", sourceHandle: null, target: "merge:1" })).toHaveProperty("error");
});

test("a Merge feeds Export, Dedup, Picture edits and a detector, one line out", () => {
  expect(flowConnect(mergeCanvas, { source: "merge:1", sourceHandle: null, target: "export:1", targetHandle: "in:ok" })).toEqual({ exportLine: { box: "export:1", input: "ok", ref: { from: "merge:1" } } });
  for (const t of ["det:1"]) expect(flowConnect(mergeCanvas, link("merge:1", t))).toEqual({ source: "merge:1", target: t });
  expect(flowConnect(mergeCanvas, link("merge:1", "calc:1"))).toHaveProperty("error");
});

test("the stored line of an edge into a Merge", () => {
  const edge = { id: "e", source: "roi:seal", source_handle: "p:NG", target: "merge:1", locked: false };
  expect(isMergeLineEdge(mergeCanvas, edge)).toBe(true);
  expect(mergeLineOf(mergeCanvas, edge)).toEqual({ feature: "seal", dot: "NG" });
  expect(mergeLineOf(mergeCanvas, { ...edge, source: "eval:1", source_handle: "p:pass" })).toEqual({ box: "eval:1", dot: "pass" });
});

test("describeNode tells what a Merge collects", () => {
  expect(describeNode(node({ kind: "merge", flow: { inputs: 0 } }))).toBe("drop OK or NG dots here");
  expect(describeNode(node({ kind: "merge", flow: { inputs: 3, meaning: "OK", merge_mode: "all", frames: 7 } }))).toBe("OK · in every line · 3 lines · 7 pictures");
});
