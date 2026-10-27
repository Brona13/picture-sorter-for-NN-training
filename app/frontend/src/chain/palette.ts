import type { ChainNode } from "../api";

/** One colour per box type (the hue of its border, fill and palette tile). */
export const HUE = { ingest: 160, roi: 30, classify: 145, crop: 100, detector: 265, calc: 200, evaluation: 340, dedup: 55, export: 20 } as const;

/** One fixed size per box type, in canvas pixels. A box never changes size with what it holds; only the rows that are
 *  classes (Classify box) or targets (detector) make a box taller, because each row carries its own dot. */
export const BOX_SIZE: Record<ChainNode["kind"], { w: number; h: number }> = {
  ingest: { w: 170, h: 64 },
  roi: { w: 200, h: 84 },
  classify: { w: 200, h: 84 },
  crop: { w: 200, h: 66 },
  detector: { w: 200, h: 86 },
  calc: { w: 200, h: 86 },
  evaluation: { w: 200, h: 86 },
  dedup: { w: 200, h: 86 },
  export: { w: 200, h: 110 },
};

/** What the palette can add. One Classifier tile: its mode (Product or Feature) is chosen in the panel. */
export type PaletteKind = "classifier" | "crop" | "detector" | "calc" | "evaluation" | "dedup" | "export";

export interface PaletteItem {
  kind: PaletteKind;
  label: string;
  /** The box type it makes (for colour and size). */
  box: ChainNode["kind"];
  hint: string;
}

/** Grouped by what goes in and what comes out. */
export const PALETTE: { group: string; items: PaletteItem[] }[] = [
  {
    group: "Picture in, picture out",
    items: [
      { kind: "crop", label: "Picture edits", box: "crop", hint: "Crop and filter steps on every picture." },
      { kind: "dedup", label: "Dedup", box: "dedup", hint: "Finds near-duplicates and mutes the extra ones; it passes on the rest." },
    ],
  },
  { group: "Picture in, points out", items: [{ kind: "detector", label: "Detector", box: "detector", hint: "Finds named targets on the picture." }] },
  {
    group: "Points in, number or verdict out",
    items: [
      { kind: "calc", label: "Calculate", box: "calc", hint: "Angle or distance between two points." },
      { kind: "evaluation", label: "Evaluation", box: "evaluation", hint: "Nominal ± tolerance on a number." },
    ],
  },
  {
    group: "Sorts pictures into classes",
    items: [
      { kind: "classifier", label: "Classifier", box: "roi", hint: "Labels pictures into classes. Choose Feature (OK / NG) or Product in its panel." },
    ],
  },
  {
    group: "Picture sink",
    items: [{ kind: "export", label: "Export", box: "export", hint: "The end of the Chain: OK and NG inputs; freezes and exports the originals into folders." }],
  },
];

export const paletteItem = (kind: PaletteKind): PaletteItem => PALETTE.flatMap((g) => g.items).find((i) => i.kind === kind)!;

/** The top-left corner for a box dropped with its centre at the pointer. */
export function dropPosition(pointer: { x: number; y: number }, box: ChainNode["kind"]): { x: number; y: number } {
  const { w, h } = BOX_SIZE[box];
  return { x: Math.round(pointer.x - w / 2), y: Math.round(pointer.y - h / 2) };
}

/** The first spot at or below `want` where a box of this type overlaps none of `taken` (top-left corners). */
export function freeSpot(
  taken: { x: number; y: number; kind: ChainNode["kind"] }[],
  want: { x: number; y: number },
  box: ChainNode["kind"],
): { x: number; y: number } {
  const { w, h } = BOX_SIZE[box];
  const gap = 24;
  const overlaps = (p: { x: number; y: number }) =>
    taken.some((t) => {
      const s = BOX_SIZE[t.kind];
      return p.x < t.x + s.w + gap && t.x < p.x + w + gap && p.y < t.y + s.h + gap && t.y < p.y + h + gap;
    });
  let p = { x: Math.round(want.x), y: Math.round(want.y) };
  for (let i = 0; i < 200 && overlaps(p); i += 1) p = { x: p.x, y: p.y + h + gap };
  return p;
}
