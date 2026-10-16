export const VIEWS = [
  { path: "overview", label: "Overview", icon: "🏠" },
  { path: "status", label: "Status", icon: "📊" },
  { path: "ingest", label: "Ingest", icon: "📥" },
  { path: "roi", label: "ROI editor", icon: "✏️" },
  { path: "detector", label: "Detector", icon: "🎯" },
  { path: "edge-angle", label: "Edge angle", icon: "📐" },
  { path: "dedup", label: "Dedup", icon: "🧹" },
  { path: "classify", label: "Classify", icon: "🏷️" },
  { path: "insights", label: "Insights", icon: "💡" },
  { path: "verdict", label: "Verdict", icon: "⚖️" },
  { path: "augmentation", label: "Augmentation", icon: "🔀" },
  { path: "versions", label: "Versions", icon: "📦" },
] as const;

/** Pinned to the bottom of the sidebar, apart from the pipeline pages. */
export const CONFIG_VIEW = { path: "config", label: "Configuration", icon: "⚙️" } as const;
