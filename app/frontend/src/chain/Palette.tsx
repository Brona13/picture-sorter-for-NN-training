import type { DragEvent } from "react";
import { KindIcon } from "./kindIcons";
import { BOX_SIZE, HUE, PALETTE, type PaletteItem, type PaletteKind } from "./palette";

/** The drag type a palette tile carries; the canvas accepts only this. */
export const PALETTE_DRAG = "application/x-chain-box";

/** A drag image that looks like the box that will be made: the right size, colour and name. */
function ghost(item: PaletteItem): HTMLElement {
  const { w, h } = BOX_SIZE[item.box];
  const el = document.createElement("div");
  el.className = "chain-node chain-ghost";
  el.style.setProperty("--hue", String(HUE[item.box]));
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
  // Inside the window, behind the page: Chrome on Windows draws an element parked outside the window as bare text (or
  // nothing) in the drag image; Linux did not mind.
  el.style.position = "fixed";
  el.style.top = "0";
  el.style.left = "0";
  el.style.zIndex = "-1";
  el.style.pointerEvents = "none";
  el.textContent = item.label;
  document.body.appendChild(el);
  el.getBoundingClientRect(); // laid out before the browser takes its picture
  window.setTimeout(() => el.remove(), 100);
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
                  <KindIcon kind={item.kind} size={21} />
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
