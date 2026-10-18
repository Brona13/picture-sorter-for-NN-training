import { useCallback, useEffect, useRef, useState } from "react";
import { api, VerdictItem, VerdictList, VerdictSummary } from "../api";
import { classColor } from "../classify/colors";
import CardGrid from "../classify/CardGrid";
import FramePane from "../classify/FramePane";
import { createPainter } from "../classify/painter";
import { cursorFor } from "../classify/paint";
import { useGridCard } from "../classify/useGridCard";
import PictureViewer from "../classify/PictureViewer";
import { useBrowse } from "../classify/useBrowse";
import VerdictBar from "../VerdictBar";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const FILTERS = [
  ["all", "All pictures"],
  ["contradiction", "Contradictions"],
  ["stale", "Stale (labels changed after my decision)"],
  ["open", "Open"],
  ["ok", "Verdict OK"],
  ["ng", "Verdict NG"],
  ["duplicates", "Duplicates (muted by Dedup, no verdict)"],
] as const;

const STATUS_TEXT: Record<string, string> = {
  ok: "OK",
  ng: "NG",
  open: "open",
  contradiction: "contradiction",
  stale: "stale",
};

/** Painting on the Verdict grid: hold 1 (OK), 2 (NG) or 0 (clear my decision) and move over the cards. */
const verdictPainter = createPainter<string>((e) => (/^[012]$/.test(e.key) ? e.key : null));

const DEFAULT_SETTINGS = { per_page: 24, cols: 4, per_page_options: [12, 24, 48, 96], cols_options: [3, 4, 5, 6, 8] };

function Card({ camera, item, busy, onDecide, onOpen }: { camera: string; item: VerdictItem; busy: boolean; onDecide: (cls: "OK" | "NG" | null) => void; onOpen: () => void }) {
  const verdict = item.verdict;
  // The shared grid-card behaviour (`useGridCard`), as on Classify: keys act on the card under the mouse (1 = OK, 2 = NG,
  // 0 = clear my decision) and holding one while moving the mouse paints the cards. Painting never overrides a decision
  // of yours: 1 and 2 only decide cards you have not decided, 0 only clears cards you have.
  const { props } = useGridCard(verdictPainter, item.frame, {
    onKey: (e) => {
      if (!/^[012]$/.test(e.key) || busy) return false;
      if (e.key === "0") {
        if (item.decision) onDecide(null);
      } else onDecide(e.key === "1" ? "OK" : "NG");
      verdictPainter.mark(item.frame);
      return true;
    },
    paint: (mode) => {
      if (busy) return false;
      if (mode === "0") {
        if (!item.decision) return false;
        onDecide(null);
      } else {
        if (item.decision) return false;
        onDecide(mode === "1" ? "OK" : "NG");
      }
      return true;
    },
    cursorOf: (mode) => cursorFor(mode, ["OK", "NG"]),
  });
  return (
    <article
      data-testid={`verdict-card-${item.frame}`}
      {...props}
      style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", background: "var(--panel)", padding: 8, minWidth: 0, boxSizing: "border-box" }}
    >
      <button
        type="button"
        aria-label={`Open ${item.frame}`}
        title="Open the full picture"
        onClick={(e) => {
          e.currentTarget.blur(); // keep the number keys for the hover keys and the viewer
          onOpen();
        }}
        style={{ display: "block", width: "100%", padding: 0, border: 0, background: "none", lineHeight: 0, cursor: "pointer" }}
      >
        <img
          src={`/api/cameras/${encodeURIComponent(camera)}/frames/${encodeURIComponent(item.frame)}/thumb`}
          alt={item.frame}
          loading="lazy"
          style={{ width: "100%", display: "block" }}
        />
      </button>
      <div style={{ fontSize: 12, margin: "4px 0", wordBreak: "break-all" }}>{item.frame}</div>
      <div style={{ margin: "2px 0" }}>
        <span
          data-testid={`status-${item.frame}`}
          style={{ padding: "1px 8px", borderRadius: 9, color: "#fff", background: verdict ? classColor(verdict) : item.status === "contradiction" ? "#e08a00" : item.status === "stale" ? "#8a5cd6" : "#777", fontSize: 12 }}
        >
          {verdict ? `${verdict}${item.kind === "manual" ? " · my decision" : " · automatic"}` : STATUS_TEXT[item.status]}
        </span>
        {item.status === "stale" && item.decision && (
          <span style={{ fontSize: 12 }}> labels changed since you decided {item.decision}</span>
        )}
        {item.muted_in.length > 0 && <span style={{ fontSize: 12 }}> · muted by Dedup</span>}
      </div>
      <ul style={{ listStyle: "none", padding: 0, margin: "4px 0", fontSize: 12 }}>
        {item.inputs.length === 0 && <li style={{ color: "var(--muted)" }}>No ROI has labelled this picture.</li>}
        {item.inputs.map((i) => (
          <li key={i.feature}>
            <strong>{i.short_name}</strong>: <span style={{ color: classColor(i.cls), fontWeight: 600 }}>{i.cls}</span>{" "}
            <span style={{ color: "var(--muted)" }}>
              {i.source}
              {i.via ? ` · ${i.via}` : " · page unknown"}
            </span>
          </li>
        ))}
      </ul>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {(["OK", "NG"] as const).map((c) => (
          <button key={c} disabled={busy} title={`Hover the card and press ${c === "OK" ? 1 : 2}.`} aria-label={item.status === "stale" && item.decision === c ? `Keep ${c} for ${item.frame}` : `Decide ${c} for ${item.frame}`} aria-pressed={item.kind === "manual" && item.verdict === c} onClick={() => onDecide(c)}>
            {item.status === "stale" && item.decision === c ? `Keep ${c}` : c}
          </button>
        ))}
        {item.decision && (
          <button disabled={busy} title="Hover the card and press 0." aria-label={`Clear my decision for ${item.frame}`} onClick={() => onDecide(null)}>
            Clear
          </button>
        )}
      </div>
    </article>
  );
}

/**
 * The picture viewer for the Verdict page: the shared shell and frame pane, with this page's own actions: decide OK or NG
 * (keys 1 and 2) or clear the decision (0), and what the ROIs said about the picture.
 */
function VerdictViewer({
  camera,
  items,
  start,
  busyFrames,
  onDecide,
  onClose,
}: {
  camera: string;
  items: VerdictItem[];
  start: string;
  busyFrames: Set<string>;
  onDecide: (frame: string, cls: "OK" | "NG" | null) => void;
  onClose: () => void;
}) {
  const frames = items.map((i) => i.frame);
  const { frame, index, go } = useBrowse(frames, start, onClose);
  const item = items.find((i) => i.frame === frame);
  const busy = busyFrames.has(frame);
  const latest = useRef({ frame, item, busy, onDecide });
  latest.current = { frame, item, busy, onDecide };
  const onKey = (e: KeyboardEvent): boolean => {
    if (!/^[012]$/.test(e.key)) return false;
    const cur = latest.current;
    if (e.repeat || cur.busy || !cur.item) return true;
    if (e.key === "0") {
      if (cur.item.decision) cur.onDecide(cur.frame, null);
    } else cur.onDecide(cur.frame, e.key === "1" ? "OK" : "NG");
    return true;
  };
  if (!item) return null;
  const verdict = item.verdict;
  return (
    <PictureViewer
      label="Full-size picture"
      testId="verdict-viewer"
      name={frame}
      index={index}
      total={frames.length}
      onGo={go}
      onClose={onClose}
      onKey={onKey}
      hint="Wheel zooms · drag pans · ← → browse · 1 OK · 2 NG · 0 clears my decision · Esc closes"
      toolbar={
        <div role="group" aria-label="Decide" style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          {(["OK", "NG"] as const).map((c, i) => (
            <button
              key={c}
              type="button"
              disabled={busy}
              aria-pressed={item.kind === "manual" && verdict === c}
              title={`Press ${i + 1}.`}
              onClick={() => onDecide(frame, c)}
              style={item.kind === "manual" && verdict === c ? { background: classColor(c), color: "#fff" } : undefined}
            >
              <kbd style={{ opacity: 0.6, marginRight: 4, fontSize: 10 }}>{i + 1}</kbd>
              {item.status === "stale" && item.decision === c ? `Keep ${c}` : c}
            </button>
          ))}
          {item.decision && (
            <button type="button" disabled={busy} title="Press 0." onClick={() => onDecide(frame, null)}>
              Clear
            </button>
          )}
          <span data-testid="viewer-verdict" style={{ fontSize: 12 }}>
            {verdict ? `${verdict}${item.kind === "manual" ? " · my decision" : " · automatic"}` : STATUS_TEXT[item.status]}
            {item.inputs.length > 0 && ` — ${item.inputs.map((i) => `${i.short_name}: ${i.cls}`).join(", ")}`}
          </span>
        </div>
      }
    >
      {(width) => <FramePane camera={camera} frame={frame} width={width} />}
    </PictureViewer>
  );
}

/**
 * The project verdict of every picture: OK or NG, combined from all quality ROIs. Pictures whose ROIs agree get an
 * automatic verdict; this page is where contradictions and stale decisions are looked at and decided.
 */
export default function VerdictView({ camera }: { camera: string }) {
  const [status, setStatus] = useState<string>("contradiction");
  const [page, setPage] = useState(1);
  const [list, setList] = useState<VerdictList | null>(null);
  const [summary, setSummary] = useState<VerdictSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set()); // the frames whose decision is being saved (per frame, so a sweep is not held up)
  const [viewing, setViewing] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!camera) return;
    Promise.all([api.verdicts(camera, status, page), api.verdictSummary(camera)])
      .then(([l, s]) => {
        setList(l);
        setSummary(s);
        setError(null);
        if (l.page !== page) setPage(l.page);
      })
      .catch((e: unknown) => setError(msg(e)));
  }, [camera, status, page]);

  useEffect(load, [load]);

  const settings = list?.settings ?? DEFAULT_SETTINGS;
  function changeSettings(per_page: number, cols: number) {
    api
      .verdictGridSettings(camera, per_page, cols)
      .then(() => {
        setPage(1);
        load();
      })
      .catch((e: unknown) => setError(msg(e)));
  }

  async function decide(frame: string, cls: "OK" | "NG" | null) {
    const mark = (on: boolean) =>
      setBusy((b) => {
        const n = new Set(b);
        if (on) n.add(frame);
        else n.delete(frame);
        return n;
      });
    mark(true);
    try {
      await api.verdictDecide(camera, frame, cls);
      load();
    } catch (e) {
      setError(msg(e));
    } finally {
      mark(false);
    }
  }

  if (!camera) return <p>Select a camera.</p>;
  return (
    <section>
      <h2>⚖️ Verdict — {camera}</h2>
      <p style={{ fontSize: 13 }}>
        One OK / NG verdict per picture, built from the OK and NG labels of all ROIs of this camera. If every ROI that labelled a picture says the same, the
        verdict is automatic and final. Any mix is a contradiction; decide it here. A decision of yours is marked stale when a label changes later. Deleted pictures
        are left out.
      </p>
      {error && <p role="alert">{error}</p>}
      {summary && <VerdictBar summary={summary} />}
      <p>
        <label>
          Show{" "}
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            {FILTERS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>{" "}
        {list && <span>{list.total} picture(s)</span>}
      </p>
      {list && list.items.length === 0 && <p>Nothing here.</p>}
      {list && list.items.length > 0 && (
        <>
          <CardGrid
            items={list.items}
            keyOf={(item) => item.frame}
            serverPage={list}
            settings={settings}
            onSettings={changeSettings}
            page={page}
            onPage={setPage}
            container="div"
            renderCard={(item) => <Card camera={camera} item={item} busy={busy.has(item.frame)} onDecide={(c) => void decide(item.frame, c)} onOpen={() => setViewing(item.frame)} />}
          />
          {viewing && (
            <VerdictViewer camera={camera} items={list.items} start={viewing} busyFrames={busy} onDecide={(f, c) => void decide(f, c)} onClose={() => setViewing(null)} />
          )}
        </>
      )}
    </section>
  );
}
