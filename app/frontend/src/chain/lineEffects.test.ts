import { expect, test } from "vitest";
import type { ChainCanvas, ChainEdge, ChainNode } from "../api";
import { deleteNote, disconnectError, replaceNote, scopeNote } from "./lineEffects";

const n = (over: Partial<ChainNode> & { id: string; kind: ChainNode["kind"] }): ChainNode => ({
  ref: null, label: over.id, x: 0, y: 0, role: null, scope: null, product: null, products: [], classes: [], frames: 4, labeled: 0,
  product_counts: {}, unlabeled: 0, ...over,
});
const e = (id: string, source: string, target: string, source_handle: string | null = null, locked = false): ChainEdge => ({ id, source, source_handle, target, locked });

const canvas = (nodes: ChainNode[], edges: ChainEdge[]): ChainCanvas => ({ camera: "c", products: [], classify: null, viewport: null, nodes, edges }) as unknown as ChainCanvas;

const base = [
  n({ id: "ingest", kind: "ingest", label: "Ingest" }),
  n({ id: "crop:1", kind: "crop", label: "Picture edits 1" }),
  n({ id: "det:1", kind: "detector", label: "Detector 1" }),
  n({ id: "det:2", kind: "detector", label: "Detector 2" }),
  n({ id: "calc:1", kind: "calc", label: "Calculate 1" }),
  n({ id: "eval:1", kind: "evaluation", label: "Evaluation 1" }),
  n({ id: "roi:f", kind: "roi", ref: "f", label: "seal", scope: "camera" }),
];

test("deleting a picture line says the box reads the whole picture and goes out of date", () => {
  const c = canvas(base, [e("a", "crop:1", "det:1")]);
  const note = deleteNote(c, c.edges[0])!;
  expect(note.title).toContain("Picture edits 1 → Detector 1");
  expect(note.lines.join(" ")).toContain("whole picture");
  expect(note.lines.join(" ")).toContain("run it again");
});

test("deleting a Calculate line names the point it loses", () => {
  const c = canvas(base, [e("a", "det:1", "calc:1", "t:P")]);
  expect(deleteNote(c, c.edges[0])!.lines.join(" ")).toContain("Detector 1 (target P)");
});

test("deleting an ROI's picture input or anchor says it is reset or static", () => {
  const roi = { ...base[6], input: "crop:1" };
  const c = canvas([...base.slice(0, 6), roi], [e("a", "crop:1", "roi:f")]);
  expect(deleteNote(c, c.edges[0])!.lines[0]).toContain("reads the whole picture again");
  const anchored = { ...base[6], anchor: { detector: "det:1", target: "P", mode: "box" as const, margin: 0.1, follow_rotation: false } };
  const c2 = canvas([...base.slice(0, 6), anchored], [e("a", "det:1", "roi:f", "t:P")]);
  expect(deleteNote(c2, c2.edges[0])!.lines[0]).toContain("static");
});

test("the line from Ingest can be deleted: the Classifier then hangs alone and reads the whole camera", () => {
  const nodes = [n({ id: "ingest", kind: "ingest" }), n({ id: "roi:f", kind: "roi", ref: "f", label: "seal", scope: "camera" })];
  const c = canvas(nodes, [e("a", "ingest", "roi:f")]);
  expect(disconnectError(c, c.edges[0])).toBeNull();
  expect(deleteNote(c, c.edges[0])?.lines.join(" ")).toContain("hangs alone and still reads the whole camera");
});

test("a second line from the same output never asks: outputs feed any number of boxes", () => {
  const c = canvas(base, [e("a", "crop:1", "det:1")]);
  const asked = replaceNote(c, { source: "crop:1", sourceHandle: null, target: "det:2" }, { source: "crop:1", target: "det:2" });
  expect(asked).toBeNull();
});

test("a line onto a taken single-source input asks, and names old and new source", () => {
  const c = canvas(base, [e("a", "crop:1", "det:1")]);
  const note = replaceNote(c, { source: "ingest", sourceHandle: null, target: "det:1" }, { source: "ingest", target: "det:1" })!;
  expect(note.lines[0]).toContain("fed by Picture edits 1");
  expect(note.lines[1]).toContain("reads Ingest instead");
});

test("the same line drawn again, or onto a free input, does not ask", () => {
  const c = canvas(base, [e("a", "crop:1", "det:1")]);
  expect(replaceNote(c, { source: "crop:1", sourceHandle: null, target: "det:1" }, { source: "crop:1", target: "det:1" })).toBeNull();
  expect(replaceNote(c, { source: "crop:1", sourceHandle: null, target: "det:2" }, { source: "crop:1", target: "det:2" })).toBeNull();
});

test("Calculate takes several lines, so a new one never replaces", () => {
  const c = canvas(base, [e("a", "det:1", "calc:1", "t:P")]);
  expect(replaceNote(c, { source: "det:2", sourceHandle: "t:Q", target: "calc:1" }, { source: "det:2", target: "calc:1", point: "Q" })).toBeNull();
});

test("a second dot onto an anchored ROI replaces the first; a box onto an anchored ROI replaces the anchor", () => {
  const anchored = { ...base[6], anchor: { detector: "det:1", target: "P", mode: "box" as const, margin: 0.1, follow_rotation: false } };
  const c = canvas([...base.slice(0, 6), anchored], [e("a", "det:1", "roi:f", "t:P")]);
  const dot = replaceNote(c, { source: "det:2", sourceHandle: "t:Q", target: "roi:f" }, { anchor: { feature: "f", detector: "det:2", target: "Q" } })!;
  expect(dot.lines[1]).toContain("follows Detector 2 (target Q) instead of Detector 1 (target P)");
  const box = replaceNote(c, { source: "crop:1", sourceHandle: null, target: "roi:f" }, { roiInput: { feature: "f", box: "crop:1" } })!;
  expect(box.lines[1]).toContain("stops following");
  expect(replaceNote(c, { source: "det:1", sourceHandle: "t:P", target: "roi:f" }, { anchor: { feature: "f", detector: "det:1", target: "P" } })).toBeNull();
});

test("a line from Ingest onto a product-scoped ROI says it replaces the product lines", () => {
  const nodes = [n({ id: "ingest", kind: "ingest" }), n({ id: "roi:f", kind: "roi", ref: "f", label: "seal", scope: "products", products: ["A", "B"] })];
  const c = canvas(nodes, []);
  expect(scopeNote(c, { source: "ingest", sourceHandle: null, target: "roi:f" })!.lines[0]).toContain("only to A, B");
  expect(scopeNote(canvas([nodes[0], { ...nodes[1], products: [] }], []), { source: "ingest", sourceHandle: null, target: "roi:f" })).toBeNull();
});


test("an Evaluation line onto a Classifier asks first: the verdicts replace hand labels", () => {
  const c = canvas(base, []);
  const link = { evaluationOf: { feature: "f", box: "eval:1" } };
  const note = replaceNote(c, { source: "eval:1", sourceHandle: "all", target: "roi:f" }, link)!;
  expect(note.title).toContain("Label seal from Evaluation 1");
  expect(note.lines.join(" ")).toMatch(/pass is OK, fail is NG/);
  const again = canvas(base.map((x) => (x.id === "roi:f" ? { ...x, evaluation: "eval:1" } : x)), []);
  expect(replaceNote(again, { source: "eval:1", sourceHandle: "all", target: "roi:f" }, link)).toBeNull();
});
