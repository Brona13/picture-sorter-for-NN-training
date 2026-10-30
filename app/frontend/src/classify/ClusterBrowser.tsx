import { useState } from "react";
import { CardData, DedupResult } from "../api";
import { clusterColor } from "./colors";
import { PagerSettings } from "./Pager";
import PictureGrid, { type GridMute } from "./PictureGrid";

export type Marks = DedupResult["marks"];
const UNIQUE = "unique";

/**
 * Dedup clusters as a master/detail view: a row of equal-width tabs for the clusters ("0 (12)", ... and "Unique (n)")
 * above the selected one's pictures as a paged grid of the same cards Classify
 * uses. Each card can be labeled, made golden, made the cluster's representative, or deleted;
 * the grid size is shared by all clusters, the page is remembered per cluster.
 */
export default function ClusterBrowser({
  camera,
  feature,
  pictureFeature,
  result,
  picks,
  marks,
  grid,
  onPick,
  onMarks,
  onGrid,
  onDeleted,
  mute,
  onError,
}: {
  camera: string;
  feature: string;
  /** The feature whose cutout the cards show, when it differs from the one the picture actions go through (a Dedup box). */
  pictureFeature?: string;
  result: DedupResult;
  picks: Record<number, string>;
  marks: Marks;
  grid: PagerSettings;
  onPick: (clusterId: number, frame: string) => void;
  onMarks: (frame: string, mark: { label: string | null; golden: string | null }) => void;
  onGrid: (perPage: number, cols: number) => void;
  onDeleted: (frame: string) => void;
  /** Dedup box: M mutes a picture or takes its mute away. */
  mute?: GridMute;
  onError: (message: string) => void;
}) {
  const [selected, setSelected] = useState<string>("");
  const [pages, setPages] = useState<Record<string, number>>({});

  const entries = [
    ...result.clusters.map((c) => ({ key: String(c.id), id: c.id, title: `Cluster ${c.id}`, frames: c.members, rep: picks[c.id] && c.members.includes(picks[c.id]) ? picks[c.id] : c.representative })),
    ...(result.noise_frames.length > 0 ? [{ key: UNIQUE, id: -1, title: "Unique", frames: result.noise_frames, rep: "" }] : []),
  ];
  if (entries.length === 0) return null;
  const cur = entries.find((e) => e.key === selected) ?? entries[0];

  const page = pages[cur.key] ?? 1;

  const cardOf = (frame: string): CardData => ({
    frame,
    label: marks[frame]?.label ?? null,
    golden: marks[frame]?.golden ?? null,
    deleted: false,
    leanings: {},
    bars: null,
    cluster: null,
  });

  return (
    <div data-testid="cluster-browser">
      <nav aria-label="Clusters" style={{ display: "flex", gap: 4, margin: "0 0 10px", overflowX: "auto" }}>
        {entries.map((e) => {
          const selectedTab = e.key === cur.key;
          const tint = e.id < 0 ? "#6b7280" : clusterColor(e.id);
          const side = selectedTab ? tint : "var(--border)";
          return (
            <button
              key={e.key}
              type="button"
              aria-current={selectedTab ? "true" : undefined}
              aria-label={e.id < 0 ? `Unique, ${e.frames.length} frame(s)` : `Cluster ${e.id}, ${e.frames.length} frame(s)`}
              onClick={() => setSelected(e.key)}
              style={{
                // every tab is as wide as "Unique (n)"; with many clusters they shrink together, down to a floor
                flex: "0 1 104px",
                minWidth: 56,
                padding: "4px 8px",
                borderRadius: 4,
                // longhands only: mixing `border` with `borderBottom` lets React lose the coloured bottom line on re-render
                borderStyle: "solid",
                borderTopWidth: 1,
                borderRightWidth: 1,
                borderLeftWidth: 1,
                borderBottomWidth: 4,
                borderTopColor: side,
                borderRightColor: side,
                borderLeftColor: side,
                borderBottomColor: tint,
                background: selectedTab ? `color-mix(in srgb, ${tint} 28%, transparent)` : "transparent",
                fontWeight: selectedTab ? 700 : 400,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                cursor: "pointer",
              }}
            >
              {e.id < 0 ? "Unique" : e.id} <span style={{ opacity: selectedTab ? 0.85 : 0.65 }}>({e.frames.length})</span>
            </button>
          );
        })}
      </nav>

      <div>
        <PictureGrid
          camera={camera}
          feature={feature}
          pictureFeature={pictureFeature}
          classes={result.classes}
          labeling={false}
          frames={cur.frames}
          cardOf={cardOf}
          via="Clusters"
          grid={grid}
          onGrid={onGrid}
          page={page}
          onPage={(p) => setPages((s) => ({ ...s, [cur.key]: p }))}
          extras={(f) => ({ isRep: cur.id >= 0 && f === cur.rep, onSetRep: cur.id >= 0 ? () => onPick(cur.id, f) : undefined })}
          onChanged={(f, c) => onMarks(f, { label: c.label, golden: c.golden })}
          onDeleted={(f) => onDeleted(f)}
          mute={mute}
          onError={onError}
        />
      </div>
    </div>
  );
}
