import type { DragEvent, ReactElement } from "react";
import { BOX_SIZE, HUE, PALETTE, type PaletteItem, type PaletteKind } from "./palette";

/** The drag type a palette tile carries; the canvas accepts only this. */
export const PALETTE_DRAG = "application/x-chain-box";

const ICONS: Record<PaletteKind, ReactElement> = {
  product: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <rect x="6.5" y="7" width="4" height="4" rx="1" />
      <rect x="13.5" y="7" width="4" height="4" rx="1" />
      <rect x="6.5" y="14" width="11" height="3" rx="1" />
    </>
  ),
  feature: (
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
  evaluation: (
    <>
      <path d="M3 17h18" />
      <path d="M8 17V8M16 17V8" strokeDasharray="2 2" />
      <path d="M5 13l3-3 4 5 4-7 3 3" />
    </>
  ),
};

/** A drag image that looks like the box that will be made: the right size, colour and name. */
function ghost(item: PaletteItem): HTMLElement {
  const { w, h } = BOX_SIZE[item.box];
  const el = document.createElement("div");
  el.className = "chain-node chain-ghost";
  el.style.setProperty("--hue", String(HUE[item.box]));
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
  el.style.position = "fixed";
  el.style.top = "-1000px";
  el.textContent = item.label;
  document.body.appendChild(el);
  window.setTimeout(() => el.remove(), 0);
  return el;
}

/**
 * The module palette: square tiles grouped by what goes in and what comes out. A tile is dragged onto the canvas (a
 * box the size of the real one follows the pointer and the box is made where it is dropped) or clicked (the box is
 * made at a free spot). A box is never connected by itself.
 */
export default function Palette({
  disabled,
  taken,
  onAdd,
}: {
  disabled: boolean;
  /** Kinds that cannot be added now, with the reason (for example the camera's one product-sorting ROI). */
  taken: Partial<Record<PaletteKind, string>>;
  onAdd: (kind: PaletteKind) => void;
}) {
  const start = (item: PaletteItem) => (e: DragEvent) => {
    e.dataTransfer.setData(PALETTE_DRAG, item.kind);
    e.dataTransfer.effectAllowed = "copy";
    const { w, h } = BOX_SIZE[item.box];
    e.dataTransfer.setDragImage?.(ghost(item), w / 2, h / 2);
  };
  return (
    <div className="chain-palette-groups">
      {PALETTE.map((g) => (
        <section key={g.group} aria-label={g.group}>
          <h4>{g.group}</h4>
          <div className="chain-palette-tiles">
            {g.items.map((item) => {
              const off = disabled || !!taken[item.kind];
              return (
                <button
                  key={item.kind}
                  type="button"
                  className="chain-tile"
                  style={{ ["--hue" as string]: HUE[item.box] }}
                  aria-label={`Add ${item.label}`}
                  title={taken[item.kind] ?? `${item.hint} Drag it onto the canvas or click to add.`}
                  disabled={off}
                  draggable={!off}
                  onDragStart={start(item)}
                  onClick={() => onAdd(item.kind)}
                >
                  <svg viewBox="0 0 24 24" width="21" height="21" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    {ICONS[item.kind]}
                  </svg>
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
