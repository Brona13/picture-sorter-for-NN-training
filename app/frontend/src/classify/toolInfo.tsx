/** The explanation behind the "i" of the Scatter and Outliers controls, the same on the Dedup pages and in Classify. */
export const SCATTER_INFO = (
  <>
    A 2D map of the frames' embeddings (UMAP or t-SNE): pictures that look alike sit close together. Drag a rectangle to zoom in and select the frames inside it,
    right-click to reset the view. The map distorts distances, so use it as a sanity check; clustering is done on the full embeddings.
  </>
);
export const OUTLIERS_INFO = (
  <>
    Scores each frame by its mean cosine distance to its <em>k</em> nearest other frames, using the chosen embedding (filter and mask apply). A high score means few
    similar frames: an unusual picture, or one that does not belong. It is a hint for review, not a verdict.
  </>
);
