import { OutlierControls, OutlierResults, useOutliers } from "./OutlierPanel";
import { PagerSettings } from "./Pager";
import { EmbeddingSelect, useDedupState } from "./useDedupState";

/**
 * Classify's Outliers view: the pictures that look least like the others (mean cosine distance to their nearest
 * neighbours), most isolated first, as cards to label or delete on the spot. It is the Outliers tool of the Dedup
 * pages (`OutlierPanel`); its grid is Classify's own grid, so the page passes it in.
 */
export default function ClassifyOutliers({
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
  /** A label, golden or delete was made from a card: reload the page's counts and grid. */
  onChanged: () => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}) {
  const embed = useDedupState(camera, feature, onError);
  const { dst, method, blocked } = embed;
  const o = useOutliers({ camera, feature, method, onError });

  if (!dst) return <p>Loading…</p>;
  if (blocked) return <p role="status">{blocked}</p>;

  return (
    <div data-testid="classify-outliers">
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center", margin: "8px 0" }}>
        <EmbeddingSelect state={embed} />
        <OutlierControls o={o} />
      </div>
      {!o.result && !o.running && (
        <p>
          Press <strong>Score outliers</strong> to list this ROI's pictures from the most unusual one. A high score means few similar pictures: an unusual
          picture, or one that does not belong. It is a hint for review, not a verdict.
        </p>
      )}
      <OutlierResults
        o={o}
        grid={grid}
        onGrid={onGrid}
        onChanged={onChanged}
        onDeleted={(frame) => {
          onNotice(`Deleted ${frame}. It stays on disk; see Classify → Show: Deleted.`);
          onChanged();
        }}
      />
    </div>
  );
}
