import { expect, test } from "vitest";
import type { ChainCanvas, ChainNode } from "../api";
import { connectAction, describeNode, disconnectAction, freshName, layoutOf, productOfHandle } from "./chainModel";

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
    node({ id: "roi:type", ref: "type", role: "classify", scope: "classify", classes: ["A", "B"] }),
    node({ id: "classify:type", kind: "classify", ref: "type", label: "Classify", role: "classify", scope: null, classes: ["A", "B"], labeled: 3, unlabeled: 1, product_counts: { A: 2, B: 1 } }),
    node({ id: "roi:seal", ref: "seal", scope: "products", products: ["A"] }),
    node({ id: "roi:edge", ref: "edge" }),
    node({ id: "roi:B::rod", ref: "B::rod", scope: "name", product: "B", label: "rod" }),
  ],
};

test("a product handle adds its product to the feature", () => {
  expect(connectAction(canvas, { source: "classify:type", sourceHandle: "p:B", target: "roi:seal" })).toEqual({
    feature: "seal", products: ["A", "B"],
  });
  expect(connectAction(canvas, { source: "classify:type", sourceHandle: "p:A", target: "roi:edge" })).toEqual({
    feature: "edge", products: ["A"],
  });
});

test("the same product twice does not repeat it", () => {
  expect(connectAction(canvas, { source: "classify:type", sourceHandle: "p:A", target: "roi:seal" })).toEqual({
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
    { source: "classify:type", sourceHandle: null, target: "roi:seal" },
    { source: "roi:type", sourceHandle: "p:A", target: "roi:seal" },
    { source: "ingest", sourceHandle: null, target: "classify:type" },
    { source: "roi:seal", sourceHandle: null, target: "roi:edge" },
    { source: "ingest", sourceHandle: null, target: "roi:type" },
    { source: "ingest", sourceHandle: null, target: "ingest" },
    { source: "classify:type", sourceHandle: "p:A", target: "roi:B::rod" },
  ];
  for (const c of bad) expect(connectAction(canvas, c)).toHaveProperty("error");
});

test("deleting a product arrow drops that product; the last one means the whole camera", () => {
  const edge = { id: "e", source: "classify:type", source_handle: "p:A", target: "roi:seal", locked: false };
  expect(disconnectAction(canvas, edge)).toEqual({ feature: "seal", products: [] });
  const two = { ...canvas, nodes: canvas.nodes.map((n) => (n.id === "roi:seal" ? { ...n, products: ["A", "B"] } : n)) };
  expect(disconnectAction(two, edge)).toEqual({ feature: "seal", products: ["B"] });
});

test("locked and Ingest arrows cannot be deleted", () => {
  expect(disconnectAction(canvas, { id: "l", source: "classify:type", source_handle: "p:B", target: "roi:B::rod", locked: true }))
    .toHaveProperty("error");
  expect(disconnectAction(canvas, { id: "i", source: "ingest", source_handle: null, target: "roi:edge", locked: false }))
    .toHaveProperty("error");
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
  expect(describeNode(canvas.nodes[1])).toBe("2 products");
  expect(describeNode(canvas.nodes[2])).toBe("3/4 labeled");
  expect(describeNode(canvas.nodes[3])).toBe("A · 1/4 labeled");
  expect(describeNode(canvas.nodes[4])).toBe("whole camera · 1/4 labeled");
  expect(describeNode(canvas.nodes[5])).toBe("B · 1/4 labeled");
});

import { flowConnect } from "./chainModel";

const flowCanvas: ChainCanvas = {
  ...canvas,
  nodes: [
    ...canvas.nodes,
    node({ id: "classify:seal", kind: "classify", ref: "seal", role: "quality", scope: null }),
    node({ id: "det:1", kind: "detector", ref: null, role: null, scope: null, label: "Detector 1" }),
    node({ id: "det:2", kind: "detector", ref: null, role: null, scope: null, label: "Detector 2" }),
    node({ id: "calc:1", kind: "calc", ref: null, role: null, scope: null, label: "Calculate 1" }),
    node({ id: "eval:1", kind: "evaluation", ref: null, role: null, scope: null, label: "Evaluation 1" }),
  ],
};
const link = (source: string, target: string) => ({ source, sourceHandle: null, target });

test("flowConnect accepts the typed chain Ingest -> detector -> detector -> Calculate -> Evaluation -> Classify", () => {
  for (const [s, t] of [["ingest", "det:1"], ["det:1", "det:2"], ["det:2", "calc:1"], ["calc:1", "eval:1"], ["eval:1", "classify:seal"]]) {
    expect(flowConnect(flowCanvas, link(s, t))).toEqual({ source: s, target: t });
  }
});

test("flowConnect refuses arrows whose types do not fit, and leaves ROI arrows to connectAction", () => {
  for (const [s, t] of [["eval:1", "calc:1"], ["det:1", "eval:1"], ["calc:1", "det:1"], ["ingest", "calc:1"], ["det:1", "det:1"], ["eval:1", "classify:type"]]) {
    expect(flowConnect(flowCanvas, link(s, t))).toHaveProperty("error");
  }
  expect(flowConnect(flowCanvas, link("ingest", "roi:seal"))).toBeNull();
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
  expect(flowConnect(flowCanvas, { source: "det:1", sourceHandle: targetHandle("x"), target: "roi:type" })).toHaveProperty("error"); // the product-sorting ROI
  expect(isAnchorEdge(flowCanvas, { id: "e", source: "det:1", source_handle: "t:left hole", target: "roi:seal", locked: false })).toBe(true);
  expect(isAnchorEdge(flowCanvas, { id: "e", source: "ingest", source_handle: null, target: "roi:seal", locked: false })).toBe(false);
});

test("flowConnect: Ingest or a Crop feeds a Crop or a detector; nothing feeds Ingest, a Crop is not fed by a detector", () => {
  const withCrop: ChainCanvas = { ...flowCanvas, nodes: [...flowCanvas.nodes, node({ id: "crop:1", kind: "crop", ref: null, role: null, scope: null, label: "Crop 1" }), node({ id: "crop:2", kind: "crop", ref: null, role: null, scope: null, label: "Crop 2" })] };
  for (const [s, t] of [["ingest", "crop:1"], ["crop:1", "crop:2"], ["crop:2", "det:1"], ["crop:1", "det:2"]]) {
    expect(flowConnect(withCrop, link(s, t))).toEqual({ source: s, target: t });
  }
  for (const [s, t] of [["det:1", "crop:1"], ["crop:1", "calc:1"], ["crop:1", "eval:1"], ["crop:1", "roi:seal"]]) {
    expect(flowConnect(withCrop, link(s, t))).toHaveProperty("error");
  }
  expect(describeNode(node({ kind: "crop", flow: { rect: [0, 0, 0.5, 0.25] } }))).toBe("50 × 25 % of the picture");
  expect(describeNode(node({ kind: "crop", flow: { rect: null } }))).toBe("no crop drawn yet");
});
