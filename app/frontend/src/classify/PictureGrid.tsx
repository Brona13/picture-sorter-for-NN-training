import { useEffect, useRef, useState } from "react";
import { api, CardData, CardUpdate } from "../api";
import Card from "./Card";
import FrameViewer from "./FrameViewer";
import CardGrid from "./CardGrid";
import { PagerSettings } from "./Pager";

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
 *
 * A picture deleted here fades and **stays where it is** (nothing moves, so a sweep or a run of deletes keeps its focus),
 * with Restore when the tool can take it back, until the user turns the grid (another page, size, columns or search) or
 * the tool replaces the list; then it is gone, as Classify's server-paged grid does on its next load.
 */
export default function PictureGrid({
  camera,
  feature,
  pictureFeature,
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
  onRestored,
  onError,
}: {
  camera: string;
  feature: string;
  /** Cutout the cards show, when it differs from the feature labels go to (a Dedup box fed by a detector target). */
  pictureFeature?: string;
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
  /** The tool can take a picture back into its list. When given, a card deleted here can be restored in place. */
  onRestored?: (frame: string, card: CardUpdate["card"]) => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  // Deleted here and kept in place (a snapshot of the card), and restored from there (kept in place as normal cards).
  const [ghosts, setGhosts] = useState<Map<string, CardData>>(new Map());
  const [revived, setRevived] = useState<Set<string>>(new Set());
  const shown = useRef<string[]>(frames);

  const perPage = grid.per_page;
  const sticky = ghosts.size > 0 || revived.size > 0;
  const incoming = new Set(frames);
  const known = new Set(shown.current);
  // A list that brings frames the grid did not show is a new list: nothing is kept in place for it.
  const replaced = sticky && frames.some((f) => !known.has(f));
  const display = sticky && !replaced ? shown.current.filter((f) => incoming.has(f) || ghosts.has(f) || revived.has(f)) : frames;
  shown.current = display;
  const settle = () => {
    setGhosts(new Map());
    setRevived(new Set());
  };
  useEffect(() => {
    if (replaced) settle();
  }, [replaced]);
  const cardAt = (f: string): CardData => ghosts.get(f) ?? cardOf(f);
  const canRestore = restorable || !!onRestored;

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
  const del = (f: string) =>
    act(f, () => api.deleteFrame(camera, feature, f, via), (c) => {
      const before = cardAt(f);
      setGhosts((g) => new Map(g).set(f, { ...before, ...c, label: null, golden: null, deleted: true }));
      onDeleted(f, c);
    });
  const restore = (f: string) => {
    if (!canRestore || !(ghosts.has(f) || restorable)) return undefined;
    return act(f, () => api.restoreFrame(camera, feature, f), (c) => {
      if (ghosts.has(f)) {
        setGhosts((g) => {
          const next = new Map(g);
          next.delete(f);
          return next;
        });
        setRevived((r) => new Set(r).add(f));
      }
      if (onRestored) onRestored(f, c);
      else onChanged(f, c);
    });
  };

  return (
    <>
      <CardGrid
        items={display}
        keyOf={(f) => f}
        settings={grid}
        onSettings={onGrid}
        page={page}
        onPage={onPage}
        onGridChange={settle}
        where={where}
        renderCard={(f) => {
          const x = extras?.(f) ?? {};
          return (
            <Card
              camera={camera}
              feature={feature}
              pictureFeature={pictureFeature}
              classes={classes}
              methods={methods}
              card={cardAt(f)}
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
              canRestore={canRestore}
            />
          );
        }}
      />
      {viewer && viewing && (
        <FrameViewer
          camera={camera}
          feature={feature}
          pictureFeature={pictureFeature}
          frames={display}
          start={viewing}
          classes={classes}
          marks={(f) => {
            const c = cardAt(f);
            return { label: c.label, golden: c.golden };
          }}
          busy={busy !== null}
          onLabel={label}
          onGolden={golden}
          onDelete={del}
          deleted={(f) => cardAt(f).deleted}
          onRestore={canRestore ? (f) => void restore(f) : undefined}
          onShow={(f) => {
            const at = display.indexOf(f);
            if (at >= 0) onPage(Math.floor(at / perPage) + 1);
          }}
          onClose={() => setViewing(null)}
        />
      )}
    </>
  );
}
