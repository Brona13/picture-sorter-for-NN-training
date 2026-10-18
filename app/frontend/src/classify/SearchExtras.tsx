import { CardData, GridResponse } from "../api";
import { classColor } from "./colors";

/**
 * What the picture viewer adds for a picture found by the Classify search: the fixes that may sit outside the open
 * ROI. A picture outside the ROI's scope gets the product buttons (the product-sorting ROI's classes) and a note, since
 * its OK / NG buttons stay locked until its product fits; any found picture can be muted or unmuted for this ROI
 * (a labeled one cannot be muted). A found picture inside the scope needs only Unmute when it is muted: its labels,
 * golden and Restore are the viewer's own.
 */
export default function SearchExtras({
  card,
  search,
  busy,
  onProduct,
  onMute,
}: {
  card: CardData;
  search: NonNullable<GridResponse["search"]>;
  busy: boolean;
  onProduct: (cls: string | null) => void;
  onMute: (muted: boolean) => void;
}) {
  if (card.deleted) return null; // a deleted picture is restored first (the viewer's own button)
  const outside = !!card.outside;
  const muted = !!card.muted;
  if (!outside && !muted) return null;
  const classes = search.product_classes;
  const canMute = card.label === null && card.golden === null;
  return (
    <div data-testid="search-extras" style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
      {outside && (
        <>
          <span style={{ fontSize: 12, color: "#c62828" }}>
            Outside this ROI: {card.product ? `in product ${card.product}` : "no product yet"}. Set its product first; its OK / NG buttons unlock when it fits.
          </span>
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
          </div>
        </>
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
