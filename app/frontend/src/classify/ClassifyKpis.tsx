import { ClassifyState } from "../api";
import { classColor } from "./colors";

const UNLABELED = "#8a8a8a"; // the grey the map and the cards use for a picture without a label

/**
 * The numbers above the grid, as boxes: all pictures, one box per class of the ROI (the products for the product-sorting
 * ROI, OK / NG for a feature) with its golden count, and the pictures still unlabeled. Only the pictures the user works
 * with are counted (not deleted, not muted for this ROI). A box is also the shortcut to those pictures: it turns the
 * grid to the matching View. Classes use the colours they have on the buttons and the map.
 */
export default function ClassifyKpis({
  state,
  view,
  onPick,
}: {
  state: ClassifyState;
  /** The View the grid shows now, or null when the grid is not showing a plain View (a search, Scatter, Outliers). */
  view: string | null;
  onPick: (view: string) => void;
}) {
  const { counts, classes, scope } = state;
  const total = counts.total ?? 0;
  const box = (key: string, label: string, value: React.ReactNode, color: string, target: string, hint: string) => {
    const available = state.views.includes(target);
    return (
      <button
        key={key}
        type="button"
        data-testid={`kpi-${key}`}
        aria-pressed={view === target}
        disabled={!available}
        title={hint}
        onClick={() => onPick(target)}
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          minWidth: 72,
          padding: "4px 10px",
          borderLeft: `4px solid ${color}`,
          background: view === target ? `color-mix(in srgb, ${color} 18%, var(--panel))` : "transparent",
          textAlign: "left",
        }}
      >
        <span style={{ fontSize: 12, color: "var(--muted)" }}>{label}</span>
        <span style={{ fontSize: 18, fontWeight: 600 }}>{value}</span>
      </button>
    );
  };
  return (
    <div role="group" aria-label="Counts" style={{ display: "flex", gap: 12, flexWrap: "wrap", margin: "8px 0" }}>
      {box(
        "frames",
        "Frames",
        <>
          {total}
          {scope?.restricted && <small style={{ fontWeight: 400 }}> of {scope.camera_frames}</small>}
        </>,
        "var(--border)",
        "All",
        scope?.restricted
          ? `The pictures this ROI covers, of the ${scope.camera_frames} in the camera; the others belong to other products or have none yet. Click to show all of them.`
          : "All pictures of this ROI. Click to show them all.",
      )}
      {classes.map((c) =>
        box(
          `class-${c}`,
          c,
          <>
            {counts[c] ?? 0} <small style={{ fontWeight: 400 }}>⭐ {counts[`golden_${c}`] ?? 0}</small>
          </>,
          classColor(c, classes),
          `Labeled ${c}`,
          `Pictures labeled ${c}, and how many of them are golden references. Click to show them.`,
        ),
      )}
      {box("unlabeled", "Unlabeled", counts.unlabeled ?? 0, UNLABELED, "Unlabeled", "Pictures without a label yet. Click to show them.")}
    </div>
  );
}
