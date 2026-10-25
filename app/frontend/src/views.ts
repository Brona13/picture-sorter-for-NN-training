import type { IconId } from "./ToolIcon";

export interface ViewDef {
  path: string;
  label: string;
  /** The tool's icon (`ToolIcon.tsx`). */
  icon: IconId;
  /** Whether the app can tell if the tool has been used (`GET /tools-used`); its icon is muted until it has. */
  tracked: boolean;
  /** Tools of one purpose sit together under a small group label in the tool bar. */
  group?: string;
  /** Opened from a Chain box instead of the tool bar: still a route, still part of its section, but not listed. */
  hidden?: boolean;
}

const view = (path: string, label: string, icon: IconId, tracked = false, group?: string, hidden = false): ViewDef => ({ path, label, icon, tracked, group, hidden });

/**
 * The top-level navigation: four sections, each holding the pages (tools) that belong to it. A section with more than
 * one page gets a second-level bar of them under the top bar. The names and grouping are working labels, not final.
 */
export const SECTIONS: { id: string; label: string; pages: ViewDef[] }[] = [
  { id: "overview", label: "Overview", pages: [view("overview", "Overview", "overview"), view("chain", "Chain", "chain", true), view("status", "Status", "status"), view("log", "Log", "log")] },
  { id: "management", label: "Management", pages: [view("ingest", "Ingest", "ingest")] },
  {
    id: "manipulation",
    label: "Manipulation",
    pages: [
      // The Classifier's pages and the Dedup box's pages are opened from their boxes on the Chain (v1.97.0).
      view("dedup/scatter", "Scatter", "scatter", true, "Duplicates", true),
      view("dedup/clusters", "Clusters", "clusters", true, "Duplicates", true),
      view("dedup/outliers", "Outliers", "outliers", true, "Duplicates", true),
      view("roi", "ROI editor", "roi", true, undefined, true),
      view("detector", "Detector", "detector", true),
      view("edge-angle", "Edge angle", "edge-angle", true),
      view("classify", "Classify", "classify", true, undefined, true),
      view("insights", "Insights", "insights", true),
      view("verdict", "Verdict", "verdict", true),
      view("augmentation", "Augmentation", "augmentation", true),
    ],
  },
  { id: "export", label: "Export", pages: [view("versions", "Versions", "versions", true)] },
];

/** Every page of the four sections (not Configuration), in navigation order. */
export const VIEWS: ViewDef[] = SECTIONS.flatMap((s) => s.pages);

/** A separate button in the top bar, apart from the four sections. */
export const CONFIG_VIEW = { path: "config", label: "Configuration", icon: "⚙️" } as const;

/** The section a route such as "/classify" belongs to, if any. */
export function sectionOf(pathname: string) {
  return SECTIONS.find((s) => (pathname === "/flow" && s.id === "overview") || s.pages.some((p) => `/${p.path}` === pathname || (pathname === "/dedup" && p.path.startsWith("dedup/"))));
}
