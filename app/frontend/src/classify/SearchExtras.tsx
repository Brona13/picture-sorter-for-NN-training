import { CardData, GridResponse } from "../api";
import { classColor } from "./colors";

/**
 * What the picture viewer adds for a picture found by the Classify search. In a feature ROI every found picture shows
 * the **Product** row (the product-sorting ROI's classes, the picture's own product pressed), so you can see which product
 * it is in and correct it on the spot; a picture outside the ROI's scope also gets a red note, since its OK / NG buttons
 * stay locked until its product fits. Any found picture outside the scope can be muted or unmuted for this ROI (a labeled
 * one cannot be muted); inside the scope only Unmute shows, when the picture is muted. Its labels, golden and Restore are
 * the viewer's own. In the product-sorting ROI itself there is no Product row: its own buttons are the products.
 */
export default function SearchExtras({
  card,
  search,
  productRow,
  busy,
  onProduct,
  onMute,
}: {
  card: CardData;
  search: NonNullable<GridResponse["search"]>;
  /** Show the Product row: the open ROI is a feature (not the product-sorting ROI) and the camera has a product-sorting ROI. */
  productRow: boolean;
  busy: boolean;
  onProduct: (cls: string | null) => void;
  onMute: (muted: boolean) => void;
}) {
  if (card.deleted) return null; // a deleted picture is restored first (the viewer's own button)
  const outside = !!card.outside;
  const muted = !!card.muted;
  const showProduct = productRow && search.product_classes.length > 0;
  if (!showProduct && !outside && !muted) return null;
  const classes = search.product_classes;
  const canMute = card.label === null && card.golden === null;
  return (
    <div data-testid="search-extras" style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
      {outside && (
        <span style={{ fontSize: 12, color: "#c62828" }}>
          Outside this ROI: {card.product ? `in product ${card.product}` : "no product yet"}. Set its product first; its OK / NG buttons unlock when it fits.
        </span>
      )}
      {showProduct && (
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
          {card.product === null && !outside && <span style={{ fontSize: 12, color: "var(--muted)" }}>no product yet</span>}
        </div>
      )}
      {(outside || muted) && (
        <div role="group" aria-label="Visibility" style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {muted ? (
            <button type="button" disabled={busy} title="Show the picture in this ROI's grid again." onClick={() => onMute(false)}>
              Unmute
            </button>
          ) : (
            <button
              type="button"
              disabled={busy || !canMute}
              title={canMute ? "Hide the picture from this ROI's grid." : "A labeled picture stays visible: clear its label first."}
              onClick={() => onMute(true)}
            >
              Mute
            </button>
          )}
          {muted && <span style={{ fontSize: 12 }}>Muted for this ROI.</span>}
        </div>
      )}
    </div>
  );
}
