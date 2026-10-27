import { api, ChainNode } from "../api";

type Props = {
  camera: string;
  roi: ChainNode;
  onChanged: () => void;
  onError: (message: string) => void;
};

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Right-panel section of a Classifier that does not follow a detector: does it use the picture as it comes in (no
 * rectangle, nothing to draw) or its own rectangle, drawn in the ROI editor on that picture (`region.py`). Ingest gives
 * whole pictures, always, so "my own rectangle" is offered only after a Picture edits box is connected (a Classifier
 * that already has one keeps it). A detector's box is chosen in the Anchor section.
 */
export default function RegionSection({ camera, roi, onChanged, onError }: Props) {
  if (roi.anchor || !roi.ref) return null;
  const region = roi.region ?? "own";
  const source = roi.region_source ?? "ingest";
  const feature = roi.ref;
  const choose = async (mode: "as_is" | "own") => {
    try {
      await api.setRoiRegion(camera, feature, mode);
      onChanged();
    } catch (e) {
      onError(msg(e));
    }
  };
  const asIsLabel = source === "edits" ? "the picture as it comes in (the output of the Picture edits box)" : "the whole picture (as Ingest gives it)";
  const ownAllowed = source !== "ingest" || region !== "as_is";
  return (
    <div className="chain-region">
      <h3>Region</h3>
      <fieldset>
        <legend>The Classifier looks at</legend>
        <label>
          <input type="radio" name={`region-${roi.id}`} checked={region === "as_is"} onChange={() => void choose("as_is")} /> {asIsLabel}
        </label>
        <label title={ownAllowed ? undefined : "Ingest gives whole pictures. To use a part of them, connect a Picture edits box or a detector."}>
          <input type="radio" name={`region-${roi.id}`} checked={region !== "as_is"} disabled={!ownAllowed} onChange={() => void choose("own")} /> my own rectangle (drawn in the ROI editor)
        </label>
      </fieldset>
      {source === "ingest" && region === "as_is" && <p className="muted">To use a part of the picture, connect a Picture edits box or a detector to this Classifier.</p>}
      {region === "own_pending" && <p role="status">No rectangle drawn yet: this Classifier sees no pictures until you draw one and press Save position.</p>}
      {region === "own" && source === "ingest" && <p className="muted">This rectangle was drawn before Ingest-only Classifiers used whole pictures. Choosing the whole picture drops it.</p>}
    </div>
  );
}
