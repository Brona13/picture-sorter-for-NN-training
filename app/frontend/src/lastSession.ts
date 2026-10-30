/** What the user was working on, kept in this browser so a refresh or a server restart picks up where they left off. */
const get = (key: string): string => {
  try {
    return localStorage.getItem(`picturesorter.${key}`) ?? "";
  } catch {
    return ""; // storage unavailable: nothing is remembered
  }
};

const set = (key: string, value: string) => {
  try {
    if (value) localStorage.setItem(`picturesorter.${key}`, value);
    else localStorage.removeItem(`picturesorter.${key}`);
  } catch {
    /* storage unavailable */
  }
};

export const lastSession = {
  camera: () => get("camera"),
  setCamera: (v: string) => set("camera", v),
  /** Product and ROI are remembered per camera. */
  product: (camera: string) => get(`product.${camera}`),
  setProduct: (camera: string, v: string) => set(`product.${camera}`, v),
  /** The method the Classify grid ranks by (the top bar's "Rank using"). */
  rank: () => get("rank"),
  setRank: (v: string) => set("rank", v),
  feature: (camera: string) => get(`feature.${camera}`),
  setFeature: (camera: string, v: string) => set(`feature.${camera}`, v),
  page: () => get("page"),
  setPage: (v: string) => set("page", v),
  /** The right-hand options panel is open unless the user collapsed it (shared by every page that has one). */
  hardwareStyle: () => get("hardware.style"),
  setHardwareStyle: (v: string) => set("hardware.style", v),
  /** The Detector review's filter and order. */
  reviewFilter: () => get("review.filter"),
  setReviewFilter: (v: string) => set("review.filter", v),
  reviewSort: () => get("review.sort"),
  setReviewSort: (v: string) => set("review.sort", v),
  /** The Detector review grid's "per page x columns", e.g. "24x4". */
  reviewGrid: () => get("review.grid"),
  setReviewGrid: (v: string) => set("review.grid", v),
  /** The full-size viewer of a Dedup box: the cutout of the found box (default) or the whole picture. */
  viewerCutout: () => get("viewer.cutout") !== "0",
  setViewerCutout: (v: boolean) => set("viewer.cutout", v ? "1" : "0"),
  /** The Dedup sweep chart is open unless collapsed (shared by every box), and its range is kept per camera as JSON. */
  sweepOpen: () => get("dedup.sweepOpen") !== "0",
  setSweepOpen: (v: boolean) => set("dedup.sweepOpen", v ? "1" : "0"),
  sweepRange: (camera: string) => get(`dedup.sweepRange.${camera}`),
  setSweepRange: (camera: string, v: string) => set(`dedup.sweepRange.${camera}`, v),
  panelCollapsed: () => get("panel.collapsed") === "1",
  setPanelCollapsed: (v: boolean) => set("panel.collapsed", v ? "1" : ""),
};
