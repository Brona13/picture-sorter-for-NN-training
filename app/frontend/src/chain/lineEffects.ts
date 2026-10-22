import type { ChainCanvas, ChainEdge, ChainNode } from "../api";
import { ALL_HANDLE, disconnectAction, isAnchorEdge, isDedupInputEdge, isDedupSourceEdge, isFlowKind, isRoiInputEdge, productOfHandle, targetOfHandle } from "./chainModel";
import type { Connection, FlowLink } from "./chainModel";

/** What the confirmation overlay says: a title and one line per effect. */
export interface LineNote {
  title: string;
  lines: string[];
}

const node = (canvas: ChainCanvas, id: string): ChainNode | undefined => canvas.nodes.find((n) => n.id === id);
const name = (canvas: ChainCanvas, id: string): string => node(canvas, id)?.label ?? id;

/** "Ingest", "Detector 1" or "Detector 1 (target P)" for the source end of a line. */
function from(canvas: ChainCanvas, id: string, handle: string | null | undefined): string {
  const t = targetOfHandle(handle);
  return t ? `${name(canvas, id)} (target ${t})` : name(canvas, id);
}

/** What happens to a box when the line into it goes away: it reads the whole picture again, and whatever it made goes out of date. */
function loses(canvas: ChainCanvas, edge: Pick<ChainEdge, "source" | "source_handle" | "target">): string[] {
  const target = node(canvas, edge.target);
  const t = name(canvas, edge.target);
  switch (target?.kind) {
    case "crop":
      return targetOfHandle(edge.source_handle)
        ? [`${t} stops following the target and its follow rectangle is cleared; it reads the whole picture.`, `Boxes behind ${t} go out of date.`]
        : [`${t} reads the whole picture instead of the output of ${name(canvas, edge.source)}.`, `Boxes behind ${t} go out of date.`];
    case "detector":
      return [`${t} searches the whole picture instead of the output of ${name(canvas, edge.source)}.`, `Its stored boxes go out of date: run it again.`];
    case "calc":
      return [`${t} loses ${from(canvas, edge.source, edge.source_handle)} as an input. It needs two points to give a value.`];
    case "evaluation":
      return [`${t} has no value to judge. Its counts become undetermined.`];
    case "dedup":
      return [`${t} sees the whole camera instead of the output of ${name(canvas, edge.source)}.`, "What it muted stays muted; run its clustering again."];
    case "classify":
      return [`The cards of ${target.ref ?? t} lose the measured value, the verdict and the Show → Measurement filters.`];
    default:
      return [];
  }
}

/** The overlay text for deleting a line. `null` when the line cannot be deleted (the reason is `disconnectError`). */
export function deleteNote(canvas: ChainCanvas, edge: ChainEdge): LineNote | null {
  const source = from(canvas, edge.source, edge.source_handle);
  const target = name(canvas, edge.target);
  const title = `Delete the line ${source} → ${target}?`;
  const roi = node(canvas, edge.target);
  if (isRoiInputEdge(canvas, edge)) {
    return { title, lines: [`${roi?.label ?? target} reads the whole picture again instead of the output of ${name(canvas, edge.source)}. Its rectangle is reset.`, "Scores and thumbnails of this ROI are computed again."] };
  }
  if (isAnchorEdge(canvas, edge)) {
    return { title, lines: [`${roi?.label ?? target} becomes static: its rectangle stays in one place on every picture instead of following ${source}.`, "Scores and thumbnails of this ROI are computed again."] };
  }
  if (isDedupSourceEdge(canvas, edge)) {
    if (node(canvas, edge.target)?.kind !== "dedup") return { title, lines: [`Only the line goes. ${target} reads the whole camera again instead of ${source}.`, "What it found or made stays; run it again for the other pictures."] };
    return { title, lines: [`Only the line goes. ${target} reads the whole camera again instead of ${source}.`, "What it muted stays muted. Its clusters are for the pictures it read; run the clustering again."] };
  }
  if (isDedupInputEdge(canvas, edge)) {
    return { title, lines: [`Only the line goes. ${target} no longer reads through ${source}: the pictures ${source} muted come back to ${target}.`, `${source} keeps its mutes.`] };
  }
  if (isFlowKind(canvas.nodes.find((n) => n.id === edge.source)?.kind) || isFlowKind(roi?.kind)) {
    return { title, lines: ["Only the line goes. Nothing is deleted from either box.", ...loses(canvas, edge)] };
  }
  const result = disconnectAction(canvas, edge);
  if ("error" in result) return null;
  if (result.detach) return { title, lines: ["Only the line goes. Labels and goldens stay.", `${roi?.label ?? target} hangs alone and still reads the whole camera.`] };
  const left = result.products;
  const product = productOfHandle(edge.source_handle) ?? (edge.source_handle === ALL_HANDLE ? "the classified pictures" : null);
  return {
    title,
    lines: [
      "Only the line goes. Labels and goldens stay.",
      `${roi?.label ?? target} no longer applies to ${product ?? "that product"}${left.length ? `; it keeps ${left.join(", ")}.` : " and goes back to the whole camera."}`,
    ],
  };
}

/** Why a line cannot be deleted at all, or null. */
export function disconnectError(canvas: ChainCanvas, edge: ChainEdge): string | null {
  if (isRoiInputEdge(canvas, edge) || isAnchorEdge(canvas, edge) || isDedupSourceEdge(canvas, edge) || isDedupInputEdge(canvas, edge)) return null;
  if (isFlowKind(node(canvas, edge.source)?.kind) || isFlowKind(node(canvas, edge.target)?.kind)) return null;
  const result = disconnectAction(canvas, edge);
  return "error" in result ? result.error : null;
}

/**
 * The overlay text for drawing a line onto an input that is already taken, or `null` when nothing is replaced.
 * An output may feed any number of boxes, so a second line from the same output never asks. Only an input that
 * accepts one source does: a Picture edits box, a detector, an Evaluation box, an ROI's picture input or anchor,
 * and an ROI that is scoped to products when it is drawn back to Ingest.
 */
export function replaceNote(canvas: ChainCanvas, c: Connection, link: Exclude<FlowLink, { error: string } | null>): LineNote | null {
  const target = node(canvas, c.target);
  if (!target) return null;
  const t = target.label;
  const newSource = from(canvas, c.source, c.sourceHandle);

  if ("roiInput" in link) {
    if (target.input === link.roiInput.box) return null; // the same line again
    const old = target.input ? name(canvas, target.input) : target.anchor ? from(canvas, target.anchor.detector, `t:${target.anchor.target}`) : null;
    if (!old) return null;
    return {
      title: `Replace the input of ${t}?`,
      lines: [
        `${t} is fed by ${old} now. The new line replaces it.`,
        target.anchor && !target.input ? `${t} stops following ${old} and reads the output of ${newSource}.` : `${t} reads the output of ${newSource} instead of the output of ${old}.`,
        "The rectangle of this ROI is reset to the whole picture. Scores and thumbnails are computed again.",
      ],
    };
  }
  if ("anchor" in link) {
    if (target.anchor && target.anchor.detector === link.anchor.detector && target.anchor.target === link.anchor.target) return null;
    const old = target.anchor ? from(canvas, target.anchor.detector, `t:${target.anchor.target}`) : target.input ? name(canvas, target.input) : null;
    if (!old) return null;
    return {
      title: `Replace the input of ${t}?`,
      lines: [`${t} is fed by ${old} now. The new line replaces it.`, `${t} follows ${newSource} instead of ${old}.`, "Scores and thumbnails of this ROI are computed again."],
    };
  }
  if ("dedupSource" in link) {
    const taken = canvas.edges.find((e) => e.target === c.target && !(e.source === c.source && (e.source_handle ?? null) === (c.sourceHandle ?? null)));
    if (!taken) return null;
    return {
      title: `Replace the input of ${t}?`,
      lines: [`${t} is fed by ${from(canvas, taken.source, taken.source_handle)} now. The new line replaces it.`, `${t} reads ${newSource} instead.`, ...loses(canvas, taken).slice(1)],
    };
  }
  if ("dedupInput" in link) {
    const taken = canvas.edges.find((e) => e.target === c.target && node(canvas, e.source)?.kind === "dedup" && e.source !== c.source);
    if (!taken) return null;
    return {
      title: `Replace the Dedup box of ${t}?`,
      lines: [`${t} reads through ${name(canvas, taken.source)} now. The new line replaces it.`, `${t} then hides what ${name(canvas, c.source)} muted instead, and shows what ${name(canvas, taken.source)} muted.`],
    };
  }
  if ("source" in link) {
    if (!["crop", "detector", "evaluation", "dedup"].includes(target.kind)) return null; // Calculate and Classify take several lines
    const existing = canvas.edges.filter((e) => e.target === c.target && e.source !== c.target);
    const taken = existing.find((e) => !(e.source === c.source && (e.source_handle ?? null) === (c.sourceHandle ?? null)));
    const same = existing.some((e) => e.source === c.source && (e.source_handle ?? null) === (c.sourceHandle ?? null));
    if (!taken || same) return null;
    return {
      title: `Replace the input of ${t}?`,
      lines: [`${t} is fed by ${from(canvas, taken.source, taken.source_handle)} now. The new line replaces it.`, `${t} reads ${newSource} instead.`, ...loses(canvas, taken).slice(1)],
    };
  }
  return null;
}

/** Drawing a line from Ingest onto an ROI that applies to some products: the product lines go and it covers the whole camera. */
export function scopeNote(canvas: ChainCanvas, c: Connection): LineNote | null {
  const target = node(canvas, c.target);
  const source = node(canvas, c.source);
  if (source?.kind !== "ingest" || target?.kind !== "roi" || !target.products.length) return null;
  return {
    title: `Cover the whole camera with ${target.label}?`,
    lines: [`${target.label} applies only to ${target.products.join(", ")} now. The new line replaces those product lines.`, `It then covers every picture of the camera. Labels and goldens stay.`],
  };
}
