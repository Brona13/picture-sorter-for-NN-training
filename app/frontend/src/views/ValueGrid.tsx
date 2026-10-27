import { ReactNode, useEffect, useState } from "react";
import { frameThumbUrl } from "../api";
import CardGrid from "../classify/CardGrid";
import FramePane from "../classify/FramePane";
import PictureViewer from "../classify/PictureViewer";
import { PagerSettings } from "../classify/Pager";
import { isPageSize } from "../classify/gridSizes";
import { useBrowse } from "../classify/useBrowse";

export interface ValueRow {
  frame: string;
  value: number | null;
  /** An Offset: (dx, dy) of B from A, which "Use as nominal" takes as B's nominal. */
  point?: [number, number] | null;
  /** (dx, dy) of B from its nominal (the zone centre), once the nominal is set. */
  deviation?: [number, number] | null;
  verdict?: "pass" | "fail" | "undetermined";
  /** Pages whose pictures carry more than a value (Ingest: the name it came in under and when) put it here for `info`. */
  name?: string;
  created?: number;
}

const OPTIONS = { per_page_options: [12, 24, 48, 96], cols_options: [3, 4, 5, 6, 8] };
const STORE = "flow.grid"; // the size of this grid is remembered for every page that uses it
const FIX_STORE = "flow.fixReference"; // the viewer's "Fix reference point" toggle

function stored(): { per_page: number; cols: number } {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? "{}");
    if (isPageSize(raw.per_page) && OPTIONS.cols_options.includes(raw.cols)) return raw;
  } catch { /* the grid still works without the remembered size */ }
  return { per_page: 24, cols: 4 };
}

const show = (r: ValueRow, unit: string) => (r.value === null ? "not measured" : `${r.value.toFixed(2)}${unit ? ` ${unit}` : ""}`);

/** What a card (and the viewer) says under the file name instead of the value: a page whose pictures have no value (Ingest) gives its own line. */
type Info = (row: ValueRow) => ReactNode;

function Card({ camera, row, unit, onOpen, onNominal, onCentre, info }: { camera: string; row: ValueRow; unit: string; onOpen: () => void; onNominal?: () => void; onCentre?: () => void; info?: Info }) {
  return (
    <article data-testid={`value-card-${row.frame}`} style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", background: "var(--panel)", padding: 8, minWidth: 0, boxSizing: "border-box" }}>
      <button
        type="button"
        aria-label={`Open ${row.frame}`}
        title="Open the full picture"
        onClick={(e) => { e.currentTarget.blur(); onOpen(); }}
        style={{ display: "block", width: "100%", padding: 0, border: 0, background: "none", lineHeight: 0, cursor: "pointer" }}
      >
        <img src={frameThumbUrl(camera, row.frame, 160)} alt={row.frame} loading="lazy" style={{ width: "100%", display: "block" }} />
      </button>
      <div style={{ fontSize: 12, margin: "4px 0", wordBreak: "break-all" }}>{row.frame}</div>
      <div style={{ margin: "2px 0", fontSize: 13 }}>
        {info ? info(row) : <><strong>{show(row, unit)}</strong> {row.verdict && <span className={`flow-verdict ${row.verdict}`}>{row.verdict}</span>}</>}
      </div>
      {onNominal && (
        <button type="button" disabled={row.value === null} title="Take this picture's value as the nominal" onClick={onNominal}>
          Use as nominal
        </button>
      )}
      {onCentre && (
        <button type="button" disabled={!row.point} title="Take this picture's offset as the nominal of B" onClick={onCentre}>
          Use as nominal
        </button>
      )}
    </article>
  );
}

/** What a page can add to the viewer: the picture it works on instead of the frame, and drawing over it. */
export interface ViewerExtras {
  imageUrl?: (frame: string) => string;
  overlay?: (row: ValueRow, size: { w: number; h: number }) => ReactNode;
  /** A line in the viewer's toolbar (what the overlay shows, or why it shows nothing). */
  note?: (row: ValueRow) => ReactNode;
  /** The reference point of a picture (picture pixels, point A of the Calculate box); offers the viewer's "Fix reference point" toggle. */
  fixPoint?: (row: ValueRow) => { x: number; y: number } | null;
}

function Viewer({ camera, rows, start, unit, onClose, onNominal, onCentre, info, extras }: { camera: string; rows: ValueRow[]; start: string; unit: string; onClose: () => void; onNominal?: (value: number) => void; onCentre?: (row: ValueRow) => void; info?: Info; extras?: ViewerExtras }) {
  const frames = rows.map((r) => r.frame);
  const { frame, index, go } = useBrowse(frames, start, onClose);
  const row = rows.find((r) => r.frame === frame);
  const [fixed, setFixed] = useState(() => {
    try { return localStorage.getItem(FIX_STORE) === "on"; } catch { return false; }
  });
  const chooseFixed = (on: boolean) => {
    setFixed(on);
    try { localStorage.setItem(FIX_STORE, on ? "on" : "off"); } catch { /* not remembered */ }
  };
  if (!row) return null;
  return (
    <PictureViewer
      label="Full-size picture"
      testId="value-viewer"
      name={frame}
      index={index}
      total={frames.length}
      onGo={go}
      onClose={onClose}
      hint="Wheel zooms · drag pans · ← → browse · Esc closes"
      toolbar={
        <span data-testid="viewer-value" style={{ fontSize: 13 }}>
          {info ? info(row) : <><strong>{show(row, unit)}</strong> {row.verdict && <span className={`flow-verdict ${row.verdict}`}>{row.verdict}</span>}</>}{" "}
          {onNominal && row.value !== null && <button type="button" onClick={() => onNominal(row.value!)}>Use as nominal</button>}
          {onCentre && row.point && <button type="button" onClick={() => onCentre(row)}>Use as nominal</button>}
          {extras?.note && <span className="muted"> · {extras.note(row)}</span>}
          {extras?.fixPoint && (
            <label style={{ marginLeft: 8, whiteSpace: "nowrap" }} title="Keep point A at the same place on screen while browsing; the picture moves under it">
              <input type="checkbox" checked={fixed} onChange={(e) => chooseFixed(e.target.checked)} /> Fix reference point
            </label>
          )}
        </span>
      }
    >
      {(width) => <FramePane camera={camera} frame={frame} width={width} imageUrl={extras?.imageUrl?.(frame)} overlay={extras?.overlay ? (size) => extras.overlay!(row, size) : undefined} fixPoint={extras?.fixPoint ? { on: fixed, point: extras.fixPoint(row) } : undefined} />}
    </PictureViewer>
  );
}

/**
 * The pictures of a Calculate or Evaluation box as the usual card grid (pager, columns, search by file name, the shared
 * picture viewer behind a click), each card with its measured value and, for an Evaluation, the verdict and
 * "Use as nominal". Nothing is labeled here: the page judges a measurement. Ingest uses the same grid with its own line
 * under each picture (`info`).
 */
export default function ValueGrid({ camera, rows, unit = "", onNominal, onCentre, info, viewer }: { camera: string; rows: ValueRow[]; unit?: string; onNominal?: (value: number) => void; onCentre?: (row: ValueRow) => void; info?: Info; viewer?: ViewerExtras }) {
  const [grid, setGrid] = useState(stored);
  const [page, setPage] = useState(1);
  const [viewing, setViewing] = useState<string | null>(null);
  const settings: PagerSettings = { ...grid, ...OPTIONS };
  useEffect(() => setPage(1), [rows.length]);
  const change = (per_page: number, cols: number) => {
    setGrid({ per_page, cols });
    setPage(1);
    try { localStorage.setItem(STORE, JSON.stringify({ per_page, cols })); } catch { /* not remembered */ }
  };
  if (rows.length === 0) return <p className="muted">No pictures to show.</p>;
  return (
    <>
      <CardGrid
        items={rows}
        keyOf={(r) => r.frame}
        settings={settings}
        onSettings={change}
        page={page}
        onPage={setPage}
        where="values"
        container="div"
        onGridChange={() => setViewing(null)}
        renderCard={(r) => (
          <Card camera={camera} row={r} unit={unit} info={info} onOpen={() => setViewing(r.frame)} onNominal={onNominal && r.value !== null ? () => onNominal(r.value!) : undefined} onCentre={onCentre ? () => onCentre(r) : undefined} />
        )}
      />
      {viewing && <Viewer camera={camera} rows={rows} start={viewing} unit={unit} info={info} extras={viewer} onClose={() => setViewing(null)} onNominal={onNominal} onCentre={onCentre} />}
    </>
  );
}
