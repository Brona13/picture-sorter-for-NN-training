import { CardData, GridResponse } from "../api";
import { classColor } from "./colors";

type SearchInfo = NonNullable<GridResponse["search"]>;

/**
 * The **Product** buttons the picture viewer shows for a picture found by the Classify search, at the start of the label
 * line: the product-sorting ROI's classes with the picture's own product pressed, so you can see which product it is in
 * and correct it on the spot, followed on the same line by the open ROI's own OK / NG buttons. Shown in a feature ROI for
 * every found picture, inside the scope or not; in the product-sorting ROI itself there is none, its own buttons are the
 * products (`productRow` is false there). A deleted picture is restored first.
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
  if (card.deleted || !productRow || classes.length === 0) return null;
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

/**
 * What the viewer adds under the label line for a found picture: for one outside the open ROI's scope a red note (its
 * OK / NG buttons stay locked until its product fits) and Mute / Unmute for this ROI (a labeled picture cannot be muted);
 * inside the scope only Unmute, when the picture is muted. Its labels, golden and Restore are the viewer's own.
 */
export default function SearchExtras({
  card,
  onMute,
  busy,
}: {
  card: CardData;
  busy: boolean;
  onMute: (muted: boolean) => void;
}) {
  if (card.deleted) return null;
  const outside = !!card.outside;
  const muted = !!card.muted;
  if (!outside && !muted) return null;
  const canMute = card.label === null && card.golden === null;
  return (
    <div data-testid="search-extras" style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
      {outside && (
        <span style={{ fontSize: 12, color: "#c62828" }}>
          Outside this ROI: {card.product ? `in product ${card.product}` : "no product yet"}. Set its product first; its OK / NG buttons unlock when it fits.
        </span>
      )}
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
    </div>
  );
}
