import type { ChainCanvas, ChainEdge, ChainLayout, ChainNode } from "../api";

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

/** Short line under a box's name: what it does to the pictures. */
export function describeNode(n: ChainNode): string {
  if (n.kind === "ingest") return `${n.frames} picture${n.frames === 1 ? "" : "s"}`;
  if (n.kind === "classify") return `${n.labeled}/${n.frames} labeled`;
  if (n.scope === "classify") return `${n.classes.length} products`;
  const where =
    n.scope === "name" ? n.product ?? "" : n.scope === "products" ? n.products.join(", ") : "whole camera";
  return `${where} · ${n.labeled}/${n.frames} labeled`;
}
