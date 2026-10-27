import type { ChainCanvas, ChainEdge, ChainLayout, ChainNode, ExportRef, FlowSummary } from "../api";

/** The handle id a product leaves the product Classifier by (matches `chain.product_handle`). */
export const productHandle = (product: string) => `p:${product}`;
/** The dot that passes every classified picture (matches `lines.ALL_DOT`). */
export const ALL_HANDLE = "all";
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
export type ConnectResult = { feature: string; products: string[]; detach?: boolean; attach?: boolean } | { error: string };

export interface Connection {
  source: string;
  sourceHandle: string | null;
  target: string;
  /** The input an Export box is entered by: `in:ok` or `in:ng`. */
  targetHandle?: string | null;
}

function featureOf(canvas: ChainCanvas, id: string): ChainNode | undefined {
  return canvas.nodes.find((n) => n.id === id);
}

/**
 * Only two lines can be drawn between Classifiers: from a product dot (or the "all" dot) of the product Classifier to a
 * feature Classifier (scope it to that product, or to every classified picture), and from Ingest to a feature
 * Classifier (scope it back to the whole camera). Everything else is refused.
 */
export function connectAction(canvas: ChainCanvas, c: Connection): ConnectResult {
  const target = featureOf(canvas, c.target);
  const source = featureOf(canvas, c.source);
  if (!target || !source) return { error: "Unknown box." };
  if (target.kind === "roi" && target.role === "classify" && target.ref) {
    // The product Classifier takes only the line from Ingest (it sorts the whole camera).
    return source.kind === "ingest" ? { feature: target.ref, products: [], attach: true } : { error: "The product Classifier reads the whole camera: its line comes from Ingest." };
  }
  if (target.kind !== "roi" || !target.ref) {
    return { error: "A line can only end at a Classifier." };
  }
  if (target.scope === "name") {
    return { error: `${target.label} belongs to ${target.product} by its name, so its product cannot change.` };
  }
  if (source.kind === "ingest") return { feature: target.ref, products: [] };
  if (source.kind === "roi" && source.role !== "classify") {
    return { error: "A feature Classifier's class dots do not feed another box yet. Start the line at Ingest or at a dot of the product Classifier." };
  }
  if (source.kind === "roi" && c.sourceHandle === ALL_HANDLE) {
    return { feature: target.ref, products: [...source.classes] }; // every product: the classified pictures, never an unlabeled one
  }
  const product = productOfHandle(c.sourceHandle);
  if (source.kind === "roi" && product) {
    return { feature: target.ref, products: [...new Set([...target.products, product])] };
  }
  return { error: "Start the line at Ingest or at a dot of the product Classifier." };
}

/** What deleting an arrow means: the target ROI loses that product (no product left = whole camera). */
export function disconnectAction(canvas: ChainCanvas, edge: ChainEdge): ConnectResult {
  const target = featureOf(canvas, edge.target);
  if (!target?.ref) return { error: "Unknown box." };
  if (edge.locked) return { error: "This arrow is fixed by the ROI's name." };
  if (edge.source === INGEST_ID) return { feature: target.ref, products: [], detach: true }; // the box hangs alone; it still reads the whole camera
  if (edge.source_handle === ALL_HANDLE) return { feature: target.ref, products: [] };
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
const evalName = (id: string) => `Evaluation ${id.split(":")[1] ?? id}`;

export function describeFlow(kind: string, f: FlowSummary | undefined): string {
  const base = describeFlowBox(kind, f);
  if ((kind === "crop" || kind === "detector") && f?.eval_source) {
    return `${base} · ${evalName(f.eval_source.box)} ${f.eval_source.dot}${f.in_scope != null ? ` · ${f.in_scope} pictures` : ""}`;
  }
  if ((kind === "crop" || kind === "detector") && f?.source) {
    const where = `${f.source.dot === ALL_HANDLE ? "all" : f.source.dot}${f.in_scope != null ? ` · ${f.in_scope} pictures` : ""}`;
    return `${base} · ${where}`;
  }
  return base;
}

function describeFlowBox(kind: string, f: FlowSummary | undefined): string {
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
  if (kind === "calc") {
    if (f?.a && f?.b) return `${f.op ?? "angle"} ${f.a} → ${f.b}`;
    if (f?.a || f?.b) return `1 of 2 points (${f.a ?? f.b}) · needs one more target`; // one detector target gives one point; two are needed
    return "needs two points · connect a detector with two targets";
  }
  if (kind === "export") {
    const n = (f?.lines?.ok ?? 0) + (f?.lines?.ng ?? 0);
    if (!n) return "connect lines to OK or NG";
    const frozen = f?.frozen ? ` · frozen v${f.frozen}${f.changed ? " (changed)" : ""}` : "";
    return `${f?.ok ?? 0} OK · ${f?.ng ?? 0} NG${frozen}`;
  }
  if (kind === "dedup") {
    const where = f?.source ? `${f.source.feature} · ${f.source.dot}` : f?.eval_source ? `${evalName(f.eval_source.box)} · ${f.eval_source.dot}` : "whole camera";
    return `${where} · ${f?.frames ?? 0} pictures · ${f?.muted ?? 0} muted`;
  }
  if (f?.mode === "zone") {
    const z = f.zone;
    const c = f.counts;
    if (!z?.center) return "set the nominal and zone";
    const n = (v: number) => Math.round(v * 10) / 10;
    const size = z.shape === "circle" ? `circle r ${n(z.radius)}` : `rectangle ${n(2 * z.half[0])} × ${n(2 * z.half[1])}`;
    return `${size} around nominal ${n(z.center[0])}, ${n(z.center[1])} px${c ? ` · ${c.pass} pass, ${c.fail} fail` : ""}`;
  }
  if (f?.nominal == null) return "set the nominal";
  const c = f.counts;
  return `${f.nominal} ± ${f.tolerance}${f.unit ? ` ${f.unit}` : ""}${c ? ` · ${c.pass} pass, ${c.fail} fail` : ""}`;
}

/** Short line under a box's name: what it does to the pictures. */
export function describeNode(n: ChainNode): string {
  if (n.kind === "ingest") return `${n.frames} picture${n.frames === 1 ? "" : "s"}`;
  if (isFlowKind(n.kind)) return describeFlow(n.kind, n.flow);
  if (n.scope === "classify") return `Product · ${n.labeled}/${n.frames} labeled`;
  const where =
    n.scope === "name" ? n.product ?? "" : n.scope === "products" ? n.products.join(", ") : "whole camera";
  return `Feature · ${where} · ${n.labeled}/${n.frames} labeled`;
}

export const FLOW_KINDS = ["crop", "detector", "calc", "evaluation", "dedup", "export"] as const;
export const isFlowKind = (kind: string | undefined): boolean => !!kind && (FLOW_KINDS as readonly string[]).includes(kind);

/**
 * An arrow that involves a Picture edits, detector, Calculate or Evaluation box. `null` when the arrow is not a flow arrow at all
 * (the ROI rules in `connectAction` decide), `{ error }` when it is one that does not fit, else the arrow to store.
 * The types mirror `flow.edge_allowed`: Ingest or a Picture edits box feeds a Picture edits box or a detector, a detector feeds a detector, a Calculate box or (one target) a Picture edits box, Calculate
 * feeds Evaluation. (An Evaluation is picked in a Classifier's panel.)
 */
export const targetHandle = (target: string) => `t:${target}`;
export const targetOfHandle = (handle: string | null | undefined): string | null => (handle && handle.startsWith("t:") ? handle.slice(2) : null);

export type FlowLink = { exportLine: { box: string; input: "ok" | "ng"; ref: ExportRef } } | { source: string; target: string; point?: string } | { dedupSource: { box: string; feature?: string; evaluation?: string; dot: string } } | { dedupInput: { feature: string; box: string } } | { anchor: { feature: string; detector: string; target: string } } | { roiInput: { feature: string; box: string } } | { error: string } | null;

export function flowConnect(canvas: ChainCanvas, c: Connection): FlowLink {
  const source = featureOf(canvas, c.source);
  const target = featureOf(canvas, c.target);
  if (!source || !target) return { error: "Unknown box." };
  if (source.kind === "export") return { error: "Export is the end of the Chain: nothing leaves it." };
  if (target.kind === "export") {
    // A line onto one of the two inputs: the pictures that should land in the OK or NG folders.
    const input = c.targetHandle === "in:ok" ? "ok" : c.targetHandle === "in:ng" ? "ng" : null;
    if (!input) return { error: "Drop the line on the OK or the NG input of the Export box." };
    const dot = c.sourceHandle === ALL_HANDLE ? ALL_HANDLE : productOfHandle(c.sourceHandle);
    if (source.kind === "roi") {
      if (!dot || !source.ref) return { error: "Drag from one of the Classifier's dots (a class or all) to the Export box." };
      return { exportLine: { box: target.id, input, ref: { feature: source.ref, dot } } };
    }
    if (source.kind === "evaluation") {
      if (!dot || !["pass", "fail", ALL_HANDLE].includes(dot)) return { error: "Drag from one of the Evaluation's dots (pass, fail or all)." };
      return { exportLine: { box: target.id, input, ref: { box: source.id, dot } } };
    }
    if (source.kind === "ingest" || source.kind === "crop" || source.kind === "dedup" || (source.kind === "detector" && !c.sourceHandle)) {
      if (c.sourceHandle) return { error: `Use ${source.label}'s main dot.` };
      return { exportLine: { box: target.id, input, ref: { from: source.id } } };
    }
    return { error: `${source.label} passes no pictures on: feed Export from a Classifier or Evaluation dot, Ingest, Picture edits, a detector or Dedup.` };
  }
  if (source.kind === "detector" && target.kind === "roi" && target.ref) {
    // A detector target's dot dropped on an ROI feature anchors the ROI to that target's box.
    const name = targetOfHandle(c.sourceHandle);
    if (!name) return { error: "Drag from one of the detector's target dots (on its right edge) to the ROI." };
    // A target that looks for several elements has a dot "name (all)" that makes each of its boxes a Classifier picture, and one dot per number.
    return { anchor: { feature: target.ref, detector: source.id, target: name } };
  }
  if (source.kind === "crop" && target.kind === "roi") {
    // A Picture edits box dropped on an ROI feature: the ROI is cut from the box's (filtered) picture.
    if (!target.ref) return { error: "Unknown box." };
    if (c.sourceHandle) return { error: "Use the Picture edits box's main dot." };
    return { roiInput: { feature: target.ref, box: source.id } };
  }
  if (source.kind === "roi" && (target.kind === "dedup" || target.kind === "crop" || target.kind === "detector")) {
    // A dot of a Classifier dropped on a Dedup, Picture edits or detector box: the box works only on the pictures on that dot.
    const dot = c.sourceHandle === ALL_HANDLE ? ALL_HANDLE : productOfHandle(c.sourceHandle);
    if (!dot || !source.ref) return { error: `Drag from one of the Classifier's dots (a class or all) to ${target.kind === "dedup" ? "the Dedup box" : target.label}.` };
    if (target.flow?.feeds?.includes(source.ref)) return { error: `${target.label} feeds ${source.label}, so it cannot read it too.` };
    return { dedupSource: { box: target.id, feature: source.ref, dot } };
  }
  if (source.kind === "roi" && isFlowKind(target.kind)) {
    return { error: "A Classifier's dots feed a Dedup box, Picture edits, a detector or another Classifier." };
  }
  if (source.kind === "dedup" && target.kind === "roi") {
    // A Dedup box dropped on a Classifier: the Classifier hides what the box muted.
    if (c.sourceHandle) return { error: "Use the Dedup box's main dot." };
    if (!target.ref) return { error: "Unknown box." };
    if (source.flow?.source?.feature === target.ref) return { error: `${source.label} reads ${target.label}, so it cannot feed it back.` };
    return { dedupInput: { feature: target.ref, box: source.id } };
  }
  if (source.kind === "dedup" && isFlowKind(target.kind) && target.kind !== "detector" && target.kind !== "crop") {
    return { error: "A Dedup box feeds a Classifier, a detector or a Picture edits box." };
  }
  if (source.kind === "dedup" && (target.kind === "detector" || target.kind === "crop")) {
    if (c.sourceHandle) return { error: "Use the Dedup box's main dot." };
    if (c.source === c.target) return { error: "A box cannot feed itself." };
    return { source: c.source, target: c.target };
  }
  if (source.kind === "evaluation" && (target.kind === "dedup" || target.kind === "crop" || target.kind === "detector")) {
    // A dot of an Evaluation dropped on a Dedup, Picture edits or detector box: the box reads only the pictures judged pass, fail, or both.
    const dot = c.sourceHandle === ALL_HANDLE ? ALL_HANDLE : productOfHandle(c.sourceHandle);
    if (!dot || !["pass", "fail", ALL_HANDLE].includes(dot)) return { error: "Drag from one of the Evaluation's dots (pass, fail or all)." };
    return { dedupSource: { box: target.id, evaluation: source.id, dot } };
  }
  if (source.kind === "evaluation" && target.kind === "roi") {
    return { error: "An Evaluation is not drawn to a Classifier: pick it in the Classifier's panel." };
  }
  if (!isFlowKind(source.kind) && !isFlowKind(target.kind)) return null;
  const point = targetOfHandle(c.sourceHandle);
  if (point && (source.flow?.groups ?? []).includes(point)) {
    return { error: `The “${point} (all)” dot stands for several boxes: it can only feed a Classifier. Use one numbered dot (${point} 1 ...) for anything else.` };
  }
  if (point && !(source.kind === "detector" && (target.kind === "calc" || target.kind === "crop" || target.kind === "dedup"))) {
    return { error: "A target dot can feed one point of a Calculate box, be followed by a Picture edits box, be read by a Dedup box or anchor a Classifier; use the detector's main dot for anything else." };
  }
  if (source.kind === "detector" && (target.kind === "crop" || target.kind === "dedup") && !point) {
    return { error: `${target.kind === "crop" ? "A Picture edits box follows" : "A Dedup box reads"} one target of a detector: drag from that target's dot (on the detector's right edge) to the box.` };
  }
  const ok =
    ((source.kind === "ingest" || source.kind === "crop") && (target.kind === "crop" || target.kind === "detector" || target.kind === "dedup")) ||
    (source.kind === "detector" && (target.kind === "detector" || target.kind === "calc" || target.kind === "crop" || target.kind === "dedup")) ||
    (source.kind === "calc" && target.kind === "evaluation");
  if (!ok) {
    return {
      error: `${source.label} cannot feed ${target.label}. Ingest or a Picture edits box feeds a Picture edits box, a detector or a Dedup box, a detector (one target) feeds a Picture edits box, a detector feeds a detector or Calculate, Calculate feeds Evaluation, and an Evaluation's dots (pass, fail, all) feed a Dedup box, Picture edits or a detector. An Evaluation is picked in a Classifier's panel, not drawn to it.`,
    };
  }
  if (c.source === c.target) return { error: "A box cannot feed itself." };
  return point ? { source: c.source, target: c.target, point } : { source: c.source, target: c.target };
}

/** A line onto an Export box's OK or NG input (stored in the Export box as a line of its own, not as a flow edge). */
export const isExportLineEdge = (canvas: ChainCanvas, edge: ChainEdge): boolean => canvas.nodes.find((n) => n.id === edge.target)?.kind === "export";

/** The stored line an edge into an Export input stands for, as `flowUpdate` takes it for `remove_line`. */
export function exportLineOf(canvas: ChainCanvas, edge: ChainEdge): { input: "ok" | "ng"; ref: ExportRef } | null {
  const source = canvas.nodes.find((n) => n.id === edge.source);
  if (!source || !edge.target_handle) return null;
  const input = edge.target_handle === "in:ng" ? "ng" : "ok";
  const dot = edge.source_handle === ALL_HANDLE ? ALL_HANDLE : productOfHandle(edge.source_handle) ?? "";
  if (source.kind === "roi") return source.ref ? { input, ref: { feature: source.ref, dot } } : null;
  if (source.kind === "evaluation") return { input, ref: { box: source.id, dot } };
  return { input, ref: { from: source.id } };
}

/** A line from a Classifier dot to a Dedup, Picture edits or detector box is the box's source (stored in the box, not in the flow lines). */
export const isDedupSourceEdge = (canvas: ChainCanvas, edge: ChainEdge): boolean => {
  const kind = canvas.nodes.find((n) => n.id === edge.target)?.kind;
  const from = canvas.nodes.find((n) => n.id === edge.source)?.kind;
  return (from === "roi" || from === "evaluation") && (kind === "dedup" || kind === "crop" || kind === "detector");
};

/** A line from a Dedup box to a Classifier is the Classifier's Dedup input (stored with the Classifier). */
export const isDedupInputEdge = (canvas: ChainCanvas, edge: ChainEdge): boolean =>
  canvas.nodes.find((n) => n.id === edge.source)?.kind === "dedup" && canvas.nodes.find((n) => n.id === edge.target)?.kind === "roi";

/** An arrow from a Picture edits box to an ROI box is the ROI's input (stored with the ROI, not in the flow graph). */
export const isRoiInputEdge = (canvas: ChainCanvas, edge: ChainEdge): boolean =>
  canvas.nodes.find((n) => n.id === edge.source)?.kind === "crop" && canvas.nodes.find((n) => n.id === edge.target)?.kind === "roi";

/** An arrow from a detector to an ROI box is the ROI's anchor (stored in the anchor, not in the flow graph). */
export const isAnchorEdge = (canvas: ChainCanvas, edge: ChainEdge): boolean =>
  canvas.nodes.find((n) => n.id === edge.source)?.kind === "detector" && canvas.nodes.find((n) => n.id === edge.target)?.kind === "roi";
