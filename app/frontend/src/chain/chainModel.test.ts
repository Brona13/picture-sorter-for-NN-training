import { expect, test } from "vitest";
import type { ChainCanvas, ChainNode } from "../api";
import { connectAction, describeNode, disconnectAction, freshName, layoutOf, productOfHandle } from "./chainModel";

const node = (over: Partial<ChainNode>): ChainNode => ({
  id: "roi:x", kind: "roi", ref: "x", label: "x", x: 0, y: 0, role: "quality", scope: "camera", product: null,
  products: [], classes: ["OK", "NG"], frames: 4, labeled: 1, ...over,
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
    { source: "roi:seal", sourceHandle: null, target: "roi:edge" },
    { source: "ingest", sourceHandle: null, target: "roi:type" },
    { source: "ingest", sourceHandle: null, target: "ingest" },
    { source: "roi:type", sourceHandle: "p:A", target: "roi:B::rod" },
  ];
  for (const c of bad) expect(connectAction(canvas, c)).toHaveProperty("error");
});

test("deleting a product arrow drops that product; the last one means the whole camera", () => {
  const edge = { id: "e", source: "roi:type", source_handle: "p:A", target: "roi:seal", locked: false };
  expect(disconnectAction(canvas, edge)).toEqual({ feature: "seal", products: [] });
  const two = { ...canvas, nodes: canvas.nodes.map((n) => (n.id === "roi:seal" ? { ...n, products: ["A", "B"] } : n)) };
  expect(disconnectAction(two, edge)).toEqual({ feature: "seal", products: ["B"] });
});

test("locked and Ingest arrows cannot be deleted", () => {
  expect(disconnectAction(canvas, { id: "l", source: "roi:type", source_handle: "p:B", target: "roi:B::rod", locked: true }))
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
  expect(describeNode(canvas.nodes[2])).toBe("A · 1/4 labeled");
  expect(describeNode(canvas.nodes[3])).toBe("whole camera · 1/4 labeled");
  expect(describeNode(canvas.nodes[4])).toBe("B · 1/4 labeled");
});
