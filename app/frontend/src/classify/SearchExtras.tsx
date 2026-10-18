import { CardData, GridResponse } from "../api";
import { classColor } from "./colors";

type SearchInfo = NonNullable<GridResponse["search"]>;

/**
 * The **Product** buttons the picture viewer shows for a picture found by the Classify search, at the start of the label
 * line: the product-sorting ROI's classes with the picture's own product pressed, so you can see which product it is in
 * and correct it on the spot, followed on the same line by the open ROI's own buttons (captioned "Feature"). Shown in a
 * feature ROI for every found picture, inside the scope or not; in the product-sorting ROI itself there is none, its own
 * buttons are the products (`productRow` is false there). A deleted picture is restored first.
 */
export function ProductRow({
  card,
  search,
  productRow,
  busy,
  onProduct,
}: {
  card: CardData;
  search: SearchInfo;
  /** The open ROI is a feature (not the product-sorting ROI) and the camera has a product-sorting ROI. */
  productRow: boolean;
  busy: boolean;
  onProduct: (cls: string | null) => void;
}) {
  const classes = search.product_classes;
  if (!showsProductRow(card, search, productRow)) return null;
  return (
    <div role="group" aria-label="Product" style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <span style={{ fontSize: 12 }}>Product</span>
      {classes.map((c) => (
        <button
          key={c}
          type="button"
          disabled={busy}
          aria-pressed={card.product === c}
          title={card.product === c ? "Click to remove the product." : `Make it ${c}.`}
          onClick={() => onProduct(card.product === c ? null : c)}
          style={card.product === c ? { background: classColor(c, classes), color: "#fff" } : undefined}
        >
          {c}
        </button>
      ))}
      {card.product === null && !card.outside && <span style={{ fontSize: 12, color: "var(--muted)" }}>no product yet</span>}
    </div>
  );
}

/** Whether the Product row is shown for this card (the viewer then also captions the feature's own buttons). */
export const showsProductRow = (card: CardData, search: SearchInfo, productRow: boolean) =>
  productRow && !card.deleted && search.product_classes.length > 0;

/**
 * The button on the label line for a found picture that the duplicate step has hidden from this ROI's grid (it is
 * "muted"): it shows the picture in the grid again. There is no button to hide a picture by hand; Delete does that job.
 */
export function ShowAgain({ card, busy, onUnmute }: { card: CardData; busy: boolean; onUnmute: () => void }) {
  if (card.deleted || !card.muted) return null;
  return (
    <button type="button" disabled={busy} title="This picture is muted: the duplicate step hid it from this ROI's grid. Show it there again." onClick={onUnmute}>
      Show again
    </button>
  );
}

/**
 * What the zoom line says about a found picture, on one line so nothing below it moves: that it is outside the open ROI's
 * scope (its OK / NG buttons are locked until its product fits) and/or hidden by the duplicate step.
 */
export function SearchNote({ card }: { card: CardData }) {
  if (card.deleted) return null;
  const parts: string[] = [];
  if (card.outside) parts.push(`Outside this ROI: ${card.product ? `in product ${card.product}` : "no product yet"}. Set its product first.`);
  if (card.muted) parts.push("Hidden by duplicate removal.");
  if (parts.length === 0) return null;
  const text = parts.join(" ");
  return (
    <span data-testid="search-note" title={card.outside ? `${text} Its OK / NG buttons unlock when it fits.` : text} style={{ color: card.outside ? "#c62828" : undefined }}>
      {text}
    </span>
  );
}
