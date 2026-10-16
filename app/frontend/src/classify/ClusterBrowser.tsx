import { useState } from "react";
import { api, CardData, DedupResult } from "../api";
import Card from "./Card";
import FrameViewer from "./FrameViewer";
import { clusterColor } from "./colors";
import Pager, { PagerSettings } from "./Pager";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
  result,
  picks,
  marks,
  grid,
  onPick,
  onMarks,
  onGrid,
  onDeleted,
  onError,
}: {
  camera: string;
  feature: string;
  result: DedupResult;
  picks: Record<number, string>;
  marks: Marks;
  grid: PagerSettings;
  onPick: (clusterId: number, frame: string) => void;
  onMarks: (frame: string, mark: { label: string | null; golden: string | null }) => void;
  onGrid: (perPage: number, cols: number) => void;
  onDeleted: (frame: string) => void;
  onError: (message: string) => void;
}) {
  const [selected, setSelected] = useState<string>("");
  const [pages, setPages] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);

  const entries = [
    ...result.clusters.map((c) => ({ key: String(c.id), id: c.id, title: `Cluster ${c.id}`, frames: c.members, rep: picks[c.id] && c.members.includes(picks[c.id]) ? picks[c.id] : c.representative })),
    ...(result.noise_frames.length > 0 ? [{ key: UNIQUE, id: -1, title: "Unique", frames: result.noise_frames, rep: "" }] : []),
  ];
  if (entries.length === 0) return null;
  const cur = entries.find((e) => e.key === selected) ?? entries[0];

  const perPage = grid.per_page;
  const nPages = Math.max(1, Math.ceil(cur.frames.length / perPage));
  const page = Math.min(Math.max(pages[cur.key] ?? 1, 1), nPages);
  const shown = cur.frames.slice((page - 1) * perPage, page * perPage);

  async function act<T>(frame: string, call: () => Promise<T>, then: (r: T) => void) {
    setBusy(frame);
    try {
      then(await call());
    } catch (e) {
      onError(msg(e));
    } finally {
      setBusy(null);
    }
  }

  const cardOf = (frame: string): CardData => ({
    frame,
    label: marks[frame]?.label ?? null,
    golden: marks[frame]?.golden ?? null,
    deleted: false,
    leanings: {},
    bars: null,
    cluster: null,
  });
  const keep = (r: { card: { frame: string; label: string | null; golden: string | null } }) => onMarks(r.card.frame, { label: r.card.label, golden: r.card.golden });

  const showFrame = (f: string) => {
    const at = cur.frames.indexOf(f);
    if (at >= 0) setPages((s) => ({ ...s, [cur.key]: Math.floor(at / perPage) + 1 }));
  };

  return (
    <div data-testid="cluster-browser">
      <nav aria-label="Clusters" style={{ display: "flex", gap: 4, margin: "0 0 10px", overflowX: "auto" }}>
        {entries.map((e) => {
          const selectedTab = e.key === cur.key;
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
                border: `1px solid ${selectedTab ? "var(--accent)" : "var(--border)"}`,
                borderBottom: `4px solid ${e.id < 0 ? "rgba(120,120,120,.6)" : clusterColor(e.id)}`,
                background: selectedTab ? "var(--accent)" : "transparent",
                color: selectedTab ? "var(--accent-fg)" : "inherit",
                fontWeight: selectedTab ? 700 : 400,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                cursor: "pointer",
              }}
            >
              {e.id < 0 ? "Unique" : e.id} <span style={{ opacity: selectedTab ? 0.9 : 0.65 }}>({e.frames.length})</span>
            </button>
          );
        })}
      </nav>

      <div>
        <Pager
          grid={{ page, per_page: perPage, n_pages: nPages, total: cur.frames.length }}
          settings={grid}
          onPage={(p) => setPages((s) => ({ ...s, [cur.key]: p }))}
          onSettings={onGrid}
          where="top"
        />
        <ul style={{ display: "grid", gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))`, gap: 8, padding: 0 }}>
          {shown.map((f) => (
            <Card
              key={f}
              camera={camera}
              feature={feature}
              classes={result.classes}
              methods={[]}
              card={cardOf(f)}
              busy={busy === f}
              fullSize
              onOpen={() => setViewing(f)}
              isRep={cur.id >= 0 && f === cur.rep}
              onSetRep={cur.id >= 0 ? () => onPick(cur.id, f) : undefined}
              onLabel={(cls) => act(f, () => api.setLabel(camera, feature, f, cls), keep)}
              onGolden={(on) => act(f, () => api.setGolden(camera, feature, f, on), keep)}
              onDelete={() => act(f, () => api.deleteFrame(camera, feature, f), () => onDeleted(f))}
              onRestore={() => undefined}
            />
          ))}
        </ul>
        <Pager
          grid={{ page, per_page: perPage, n_pages: nPages, total: cur.frames.length }}
          settings={grid}
          onPage={(p) => setPages((s) => ({ ...s, [cur.key]: p }))}
          onSettings={onGrid}
          where="bottom"
        />
      </div>
      {viewing && (
        <FrameViewer
          camera={camera}
          frames={cur.frames}
          start={viewing}
          classes={result.classes}
          marks={(f) => ({ label: marks[f]?.label ?? null, golden: marks[f]?.golden ?? null })}
          busy={busy !== null}
          onLabel={(f, cls) => act(f, () => api.setLabel(camera, feature, f, cls), keep)}
          onGolden={(f, on) => act(f, () => api.setGolden(camera, feature, f, on), keep)}
          onDelete={(f) => act(f, () => api.deleteFrame(camera, feature, f), () => onDeleted(f))}
          onShow={showFrame}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}
