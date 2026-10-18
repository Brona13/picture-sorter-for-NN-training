import { useState } from "react";
import { api, CardData, CardUpdate } from "../api";
import Card from "./Card";
import FrameViewer from "./FrameViewer";
import Pager, { PagerSettings } from "./Pager";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Per-card extras a tool can add: a caption under the file name, or the Dedup "representative" mark. */
export interface GridExtras {
  caption?: string;
  isRep?: boolean;
  onSetRep?: () => void;
}

/**
 * A list of frames shown as a paged grid of cards with the picture viewer behind a click, where the cards label,
 * mark golden and delete. It is the one place those actions go through for the tools that show a client-side list
 * of frames (Scatter selection, Clusters, Outliers, Insights): the call is stamped with `via`, the name of the
 * tool, which is how the tool bar knows the tool has been used; and every successful change is reported once,
 * through `onChanged` (label, golden, restore) or `onDeleted`. The tool owns the frames, the marks and the page.
 * Classify (server-paged, richer cards) and Verdict (decision cards) keep their own grids.
 */
export default function PictureGrid({
  camera,
  feature,
  classes,
  methods = [],
  frames,
  cardOf,
  via,
  grid,
  onGrid,
  page,
  onPage,
  where,
  extras,
  viewer = true,
  restorable = false,
  onChanged,
  onDeleted,
  onError,
}: {
  camera: string;
  feature: string;
  classes: string[];
  methods?: string[];
  /** The frames to show, in order, already filtered. */
  frames: string[];
  cardOf: (frame: string) => CardData;
  /** The tool's name, stored with every label and delete made here. */
  via: string;
  grid: PagerSettings;
  onGrid: (perPage: number, cols: number) => void;
  page: number;
  onPage: (page: number) => void;
  /** Prefix of the pagers' accessible names ("selection" gives "Pagination selection top"). */
  where?: string;
  extras?: (frame: string) => GridExtras;
  /** Clicking a picture opens the viewer (when off, the picture is not clickable). */
  viewer?: boolean;
  /** Show Restore on deleted cards (the tool keeps deleted frames on the grid). */
  restorable?: boolean;
  onChanged: (frame: string, card: CardUpdate["card"]) => void;
  onDeleted: (frame: string, card: CardUpdate["card"]) => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);

  const perPage = grid.per_page;
  const nPages = Math.max(1, Math.ceil(frames.length / perPage));
  const cur = Math.min(Math.max(page, 1), nPages);
  const shown = frames.slice((cur - 1) * perPage, cur * perPage);

  async function act(frame: string, call: () => Promise<CardUpdate>, then: (card: CardUpdate["card"]) => void) {
    setBusy(frame);
    try {
      then((await call()).card);
    } catch (e) {
      onError(msg(e));
    } finally {
      setBusy(null);
    }
  }
  const label = (f: string, cls: string | null) => act(f, () => api.setLabel(camera, feature, f, cls, via), (c) => onChanged(f, c));
  const golden = (f: string, on: boolean) => act(f, () => api.setGolden(camera, feature, f, on), (c) => onChanged(f, c));
  const del = (f: string) => act(f, () => api.deleteFrame(camera, feature, f, via), (c) => onDeleted(f, c));
  const restore = (f: string) => (restorable ? act(f, () => api.restoreFrame(camera, feature, f), (c) => onChanged(f, c)) : undefined);

  const pagerGrid = { page: cur, per_page: perPage, n_pages: nPages, total: frames.length };
  const name = (side: string) => (where ? `${where} ${side}` : side);

  return (
    <>
      <Pager grid={pagerGrid} settings={grid} onPage={onPage} onSettings={onGrid} where={name("top")} />
      <ul style={{ display: "grid", gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))`, gap: 8, padding: 0 }}>
        {shown.map((f) => {
          const x = extras?.(f) ?? {};
          return (
            <Card
              key={f}
              camera={camera}
              feature={feature}
              classes={classes}
              methods={methods}
              card={cardOf(f)}
              busy={busy === f}
              fullSize={viewer}
              onOpen={viewer ? () => setViewing(f) : undefined}
              caption={x.caption}
              isRep={x.isRep}
              onSetRep={x.onSetRep}
              onLabel={(cls) => label(f, cls)}
              onGolden={(on) => golden(f, on)}
              onDelete={() => del(f)}
              onRestore={() => restore(f)}
            />
          );
        })}
      </ul>
      <Pager grid={pagerGrid} settings={grid} onPage={onPage} onSettings={onGrid} where={name("bottom")} />
      {viewer && viewing && (
        <FrameViewer
          camera={camera}
          feature={feature}
          frames={frames}
          start={viewing}
          classes={classes}
          marks={(f) => {
            const c = cardOf(f);
            return { label: c.label, golden: c.golden };
          }}
          busy={busy !== null}
          onLabel={label}
          onGolden={golden}
          onDelete={del}
          deleted={restorable ? (f) => cardOf(f).deleted : undefined}
          onRestore={restorable ? (f) => void restore(f) : undefined}
          onShow={(f) => {
            const at = frames.indexOf(f);
            if (at >= 0) onPage(Math.floor(at / perPage) + 1);
          }}
          onClose={() => setViewing(null)}
        />
      )}
    </>
  );
}
