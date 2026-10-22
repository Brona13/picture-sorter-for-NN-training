import { useState } from "react";
import { PanelPortal, PanelSection } from "../SidePanel";
import { SCATTER_INFO } from "./toolInfo";
import { PagerSettings } from "./Pager";
import { ColourBy } from "./Scatter";
import { effectiveColour, ProjectionProgress, ScatterMapView, useScatterMap } from "./ScatterWorkbench";
import { EmbeddingSelect, useDedupState } from "./useDedupState";

/**
 * Classify's Scatter view: the 2D map of this ROI's pictures, to select many at once (drag a rectangle) and label or
 * delete them in one go. It is the same map and selection as the Scatter page (`ScatterWorkbench`). A map that is
 * already computed appears at once; otherwise it is computed on request. The selection's grid is Classify's own grid
 * (its size and columns are one setting of the ROI), so the page passes it in.
 */
export default function ClassifyScatter({
  camera,
  feature,
  grid,
  onGrid,
  onChanged,
  onNotice,
  onError,
}: {
  camera: string;
  feature: string;
  grid: PagerSettings;
  onGrid: (perPage: number, cols: number) => void;
  /** A label or delete was made from the map: reload the page's counts and grid. */
  onChanged: () => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}) {
  const embed = useDedupState(camera, feature, onError);
  const { dst, method, blocked } = embed;
  const [colourBy, setColourBy] = useState<ColourBy>("label");
  const map = useScatterMap({ camera, feature, method, auto: !!dst && !blocked, onError });

  if (!dst) return <p>Loading the map…</p>;
  if (blocked) return <p role="status">{blocked}</p>;

  const { colour, note } = effectiveColour(colourBy, map.scatter, null);
  return (
    <div data-testid="classify-scatter">
      <PanelPortal>
        <PanelSection title="Scatter" info={SCATTER_INFO} testId="scatter-controls">
          <EmbeddingSelect state={embed} />
          <fieldset style={{ border: 0, padding: 0, margin: "6px 0 0" }}>
            <legend style={{ fontSize: 12, color: "var(--muted)", padding: 0 }}>Projection</legend>
            {dst.projections.map((p) => (
              <label key={p} style={{ display: "inline-block", marginRight: 12 }}>
                <input type="radio" name="classify-projection" checked={map.projection === p} onChange={() => map.setProjection(p)} /> {p}
              </label>
            ))}
          </fieldset>
          <label>
            Colour by
            <select value={colourBy} onChange={(e) => setColourBy(e.target.value as ColourBy)}>
              <option value="label">Label</option>
              <option value="cluster">Cluster</option>
              <option value="none">Nothing</option>
            </select>
          </label>
          <div style={{ marginTop: 8 }}>
            <button type="button" disabled={map.projecting} onClick={map.run}>
              {map.scatter ? "Recompute map" : "Compute map"}
            </button>
          </div>
          {map.projecting && <ProjectionProgress progress={map.progress} />}
        </PanelSection>
      </PanelPortal>
      {!map.scatter && !map.projecting && map.cached === false && (
        <p>
          This map is not computed yet. Press <strong>Compute map</strong> in the options panel; it can take a while for a big set, and it is kept afterwards.
        </p>
      )}
      {note && (
        <p role="note" style={{ fontSize: 12 }}>
          {note}
        </p>
      )}
      <ScatterMapView
        camera={camera}
        feature={feature}
        map={map}
        colourBy={colour}
        grid={grid}
        onGrid={onGrid}
        onNotice={onNotice}
        onError={onError}
        onChanged={onChanged}
      />
    </div>
  );
}
