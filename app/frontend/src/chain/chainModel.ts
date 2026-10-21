import type { NodeChange } from "@xyflow/react";
import type { ChainCanvas, ChainEdge, ChainLayout, ChainNode, FlowSummary } from "../api";

/** The handle id a product leaves the classify ROI by (matches `chain.product_handle`). */
export const productHandle = (product: string) => `p:${product}`;
export const INGEST_ID = "ingest";

/** The product a `p:<product>` handle stands for, or null for any other handle. */
export const productOfHandle = (handle: string | null | undefined): string | null =>
  handle && handle.startsWith("p:") ? handle.slice(2) : null;

/** "feature", "feature 2", ... : the first name no ROI of the camera uses yet. */
export function freshName(base: string, taken: string[]): string {
  const used = new Set(taken.map((t) => t.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/** What an arrow drawn on the canvas means for the target ROI: the products it should apply to (empty = whole camera). */
export type ConnectResult = { feature: string; products: string[] } | { error: string };

export interface Connection {
  source: string;
  sourceHandle: string | null;
  target: string;
}

function featureOf(canvas: ChainCanvas, id: string): ChainNode | undefined {
  return canvas.nodes.find((n) => n.id === id);
}

/**
 * Only two arrows can be drawn: from a product handle of the product-sorting ROI to a feature ROI (scope it to that
 * product), and from Ingest to a feature ROI (scope it back to the whole camera). Everything else is refused.
 */
export function connectAction(canvas: ChainCanvas, c: Connection): ConnectResult {
  const target = featureOf(canvas, c.target);
  const source = featureOf(canvas, c.source);
  if (!target || !source) return { error: "Unknown box." };
  if (target.kind !== "roi" || target.role === "classify" || !target.ref) {
    return { error: "An arrow can only end at a feature ROI." };
  }
  if (target.scope === "name") {
    return { error: `${target.label} belongs to ${target.product} by its name, so its product cannot change.` };
  }
  if (source.kind === "ingest") return { feature: target.ref, products: [] };
  const product = productOfHandle(c.sourceHandle);
  if (source.kind === "classify" && product) {
    return { feature: target.ref, products: [...new Set([...target.products, product])] };
  }
  return { error: "Start the arrow at Ingest or at one of the product handles of the Classify box." };
}

/** What deleting an arrow means: the target ROI loses that product (no product left = whole camera). */
export function disconnectAction(canvas: ChainCanvas, edge: ChainEdge): ConnectResult {
  const target = featureOf(canvas, edge.target);
  if (!target?.ref) return { error: "Unknown box." };
  if (edge.locked) return { error: "This arrow is fixed by the ROI's name." };
  const product = productOfHandle(edge.source_handle);
  if (!product) return { error: "A feature always hangs from Ingest or from a product." };
  return { feature: target.ref, products: target.products.filter((p) => p !== product) };
}

/** The layout to store for the boxes as they are drawn now (positions and display names, not the ROIs). */
export function layoutOf(
  nodes: { id: string; x: number; y: number; label?: string }[],
  viewport: ChainLayout["viewport"],
): ChainLayout {
  const out: ChainLayout["nodes"] = {};
  for (const n of nodes) out[n.id] = n.label ? { x: n.x, y: n.y, label: n.label } : { x: n.x, y: n.y };
  return { nodes: out, viewport };
}

/** Short line for a Picture edits, detector, Calculate or Evaluation box, from its light summary (the Chain and the Overview use it). */
export function describeFlow(kind: string, f: FlowSummary | undefined): string {
  if (kind === "crop") {
    const steps = f?.steps ?? [];
    if (steps.length === 0) return "no steps yet";
    const follows = f?.follow?.size ? `follows ${f.follow.target} · ${f.follow.size[0]} × ${f.follow.size[1]} px` : `follows ${f?.follow?.target ?? "a target"} · draw the rectangle`;
    const crop = (s: Extract<NonNullable<FlowSummary["steps"]>[number], { op: "crop" }>, alone: boolean) =>
      s.follows ? follows : s.rect ? `${alone ? "" : "crop "}${Math.round(s.rect[2] * 100)} × ${Math.round(s.rect[3] * 100)} %${alone ? " of the picture" : ""}` : null;
    const only = steps.length === 1 && steps[0].op === "crop" ? steps[0] : null; // a single crop reads as the Crop box always did
    if (only) return crop(only, true) ?? "no crop drawn yet";
    const parts = steps.map((s) => (s.op === "filter" ? s.label : crop(s, false))).filter((t): t is string => !!t);
    return parts.length ? parts.join(" → ") : "no crop drawn yet";
  }
  if (kind === "detector") {
    const targets = f?.targets?.length ?? 0;
    const state = f?.status === "fresh" ? `${f.complete ?? 0}/${f.frames ?? 0} complete` : f?.status === "stale" ? "run again" : "not run";
    return `${targets} target${targets === 1 ? "" : "s"} · ${state}`;
  }
  if (kind === "calc") return f?.a && f?.b ? `${f.op ?? "angle"} ${f.a} → ${f.b}` : "connect a detector";
  if (f?.nominal == null) return "set the nominal";
  const c = f.counts;
  return `${f.nominal} ± ${f.tolerance}${f.unit ? ` ${f.unit}` : ""}${c ? ` · ${c.pass} pass, ${c.fail} fail` : ""}`;
}

/** Short line under a box's name: what it does to the pictures. */
export function describeNode(n: ChainNode): string {
  if (n.kind === "ingest") return `${n.frames} picture${n.frames === 1 ? "" : "s"}`;
  if (n.kind === "classify") return `${n.labeled}/${n.frames} labeled`;
  if (isFlowKind(n.kind)) return describeFlow(n.kind, n.flow);
  if (n.scope === "classify") return `${n.classes.length} products`;
  const where =
    n.scope === "name" ? n.product ?? "" : n.scope === "products" ? n.products.join(", ") : "whole camera";
  return `${where} · ${n.labeled}/${n.frames} labeled`;
}

export const FLOW_KINDS = ["crop", "detector", "calc", "evaluation"] as const;
export const isFlowKind = (kind: string | undefined): boolean => !!kind && (FLOW_KINDS as readonly string[]).includes(kind);

/**
 * An arrow that involves a Picture edits, detector, Calculate or Evaluation box. `null` when the arrow is not a flow arrow at all
 * (the ROI rules in `connectAction` decide), `{ error }` when it is one that does not fit, else the arrow to store.
 * The types mirror `flow.edge_allowed`: Ingest or a Picture edits box feeds a Picture edits box or a detector, a detector feeds a detector, a Calculate box or (one target) a Picture edits box, Calculate
 * feeds Evaluation, Evaluation feeds a Classify box.
 */
export const targetHandle = (target: string) => `t:${target}`;
export const targetOfHandle = (handle: string | null | undefined): string | null => (handle && handle.startsWith("t:") ? handle.slice(2) : null);

export type FlowLink = { source: string; target: string; point?: string } | { anchor: { feature: string; detector: string; target: string } } | { error: string } | null;

export function flowConnect(canvas: ChainCanvas, c: Connection): FlowLink {
  const source = featureOf(canvas, c.source);
  const target = featureOf(canvas, c.target);
  if (!source || !target) return { error: "Unknown box." };
  if (source.kind === "detector" && target.kind === "roi" && target.role !== "classify" && target.ref) {
    // A detector target's dot dropped on an ROI feature anchors the ROI to that target's box.
    const name = targetOfHandle(c.sourceHandle);
    if (!name) return { error: "Drag from one of the detector's target dots (on its right edge) to the ROI." };
    return { anchor: { feature: target.ref, detector: source.id, target: name } };
  }
  if (!isFlowKind(source.kind) && !isFlowKind(target.kind)) return null;
  const point = targetOfHandle(c.sourceHandle);
  if (point && !(source.kind === "detector" && (target.kind === "calc" || target.kind === "crop"))) {
    return { error: "A target dot can feed one point of a Calculate box, be followed by a Picture edits box or anchor an ROI; use the detector's main dot for anything else." };
  }
  if (source.kind === "detector" && target.kind === "crop" && !point) {
    return { error: "A Picture edits box follows one target of a detector: drag from that target's dot (on the detector's right edge) to the box." };
  }
  const ok =
    ((source.kind === "ingest" || source.kind === "crop") && (target.kind === "crop" || target.kind === "detector")) ||
    (source.kind === "detector" && (target.kind === "detector" || target.kind === "calc" || target.kind === "crop")) ||
    (source.kind === "calc" && target.kind === "evaluation") ||
    (source.kind === "evaluation" && target.kind === "classify" && target.role !== "classify");
  if (!ok) {
    return {
      error: `${source.label} cannot feed ${target.label}. Ingest or a Picture edits box feeds a Picture edits box or a detector, a detector (one target) feeds a Picture edits box, a detector feeds a detector or Calculate, Calculate feeds Evaluation, Evaluation feeds a feature's Classify box.`,
    };
  }
  if (c.source === c.target) return { error: "A box cannot feed itself." };
  return point ? { source: c.source, target: c.target, point } : { source: c.source, target: c.target };
}

/** Extra position changes so an ROI box carries its Classify box when it is dragged (the Classify box alone moves alone). */
export function classifyFollows(
  boxes: { id: string; kind: string; ref: string | null; position: { x: number; y: number } }[],
  changes: readonly NodeChange[],
): { type: "position"; id: string; position: { x: number; y: number }; dragging: true }[] {
  const moved = new Set(changes.flatMap((c) => (c.type === "position" ? [c.id] : [])));
  const extra: { type: "position"; id: string; position: { x: number; y: number }; dragging: true }[] = [];
  for (const c of changes) {
    if (c.type !== "position" || !c.position) continue;
    const roi = boxes.find((b) => b.id === c.id);
    if (roi?.kind !== "roi" || !roi.ref) continue;
    const partner = boxes.find((b) => b.kind === "classify" && b.ref === roi.ref);
    if (!partner || moved.has(partner.id)) continue; // both selected and dragged: each already moves
    extra.push({
      type: "position",
      id: partner.id,
      position: { x: partner.position.x + c.position.x - roi.position.x, y: partner.position.y + c.position.y - roi.position.y },
      dragging: true,
    });
  }
  return extra;
}

/** An arrow from a detector to an ROI box is the ROI's anchor (stored in the anchor, not in the flow graph). */
export const isAnchorEdge = (canvas: ChainCanvas, edge: ChainEdge): boolean =>
  canvas.nodes.find((n) => n.id === edge.source)?.kind === "detector" && canvas.nodes.find((n) => n.id === edge.target)?.kind === "roi";
