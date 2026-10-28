import type { ReactElement } from "react";
import type { ChainNode } from "../api";
import type { PaletteKind } from "./palette";

/** The one drawing per kind of box, shared by the palette tiles, the corner of every box on the canvas and the right panel. */
const PALETTE_ICONS: Record<PaletteKind, ReactElement> = {
  classifier: (
    <>
      <path d="M3 8V4h4M17 4h4v4M21 16v4h-4M7 20H3v-4" />
      <path d="M8 12.5l3 3 5-6" />
    </>
  ),
  crop: (
    <>
      <path d="M6 2v14a2 2 0 0 0 2 2h14" />
      <path d="M2 6h14a2 2 0 0 1 2 2v14" />
    </>
  ),
  detector: (
    <>
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="1.5" />
      <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
    </>
  ),
  calc: (
    <>
      <circle cx="6" cy="17" r="2" />
      <circle cx="18" cy="7" r="2" />
      <path d="M7.5 15.5l9-7M6 17h12" strokeDasharray="2 3" />
      <path d="M11 17a5 5 0 0 0-1.4-3.4" />
    </>
  ),
  dedup: (
    <>
      <rect x="3" y="6" width="12" height="12" rx="2" />
      <path d="M9 3h10a2 2 0 0 1 2 2v10" strokeDasharray="2 2" />
      <path d="M6.5 12.5l2 2 3.5-4" />
    </>
  ),
  export: (
    <>
      <path d="M4 7h6l2 2h8v10H4z" />
      <path d="M12 12v5M9.5 14.5L12 17l2.5-2.5" />
    </>
  ),
  merge: (
    <>
      <path d="M3 6h5l4 6-4 6H3" />
      <path d="M12 12h9M18 9l3 3-3 3" />
    </>
  ),
  evaluation: (
    <>
      <path d="M3 17h18" />
      <path d="M8 17V8M16 17V8" strokeDasharray="2 2" />
      <path d="M5 13l3-3 4 5 4-7 3 3" />
    </>
  ),
};

/** Ingest has no palette tile (a camera always has one): a tray the pictures arrive in. */
const INGEST_ICON = (
  <>
    <path d="M4 14v5h16v-5" />
    <path d="M12 4v10M8.5 10.5L12 14l3.5-3.5" />
  </>
);

/** The palette kind whose drawing a canvas box uses (a Classify box is the old name of a Classifier). */
export const ICON_OF: Record<ChainNode["kind"], PaletteKind | "ingest"> = {
  ingest: "ingest",
  roi: "classifier",
  classify: "classifier",
  crop: "crop",
  detector: "detector",
  calc: "calc",
  evaluation: "evaluation",
  dedup: "dedup",
  export: "export",
  merge: "merge",
};

export function KindIcon({ kind, size = 16, className }: { kind: PaletteKind | ChainNode["kind"] | "ingest"; size?: number; className?: string }) {
  const key = (kind in ICON_OF ? ICON_OF[kind as ChainNode["kind"]] : kind) as PaletteKind | "ingest";
  return (
    <svg className={className} viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" data-testid={`kind-icon-${key}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {key === "ingest" ? INGEST_ICON : PALETTE_ICONS[key]}
    </svg>
  );
}

export const PALETTE_KINDS = Object.keys(PALETTE_ICONS) as PaletteKind[];
