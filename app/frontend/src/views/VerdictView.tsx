import { useCallback, useEffect, useRef, useState } from "react";
import { api, VerdictItem, VerdictList, VerdictSummary } from "../api";
import { classColor } from "../classify/colors";
import Pager from "../classify/Pager";
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

const DEFAULT_SETTINGS = { per_page: 24, cols: 4, per_page_options: [12, 24, 48, 96], cols_options: [3, 4, 5, 6, 8] };

const isTypingTarget = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName));
};

function Card({ camera, item, busy, onDecide }: { camera: string; item: VerdictItem; busy: boolean; onDecide: (cls: "OK" | "NG" | null) => void }) {
  const verdict = item.verdict;
  // As in Classify, keys act on the card under the mouse: 1 = OK, 2 = NG, 0 = clear my decision.
  const [hovered, setHovered] = useState(false);
  const latest = useRef({ busy, item, onDecide });
  latest.current = { busy, item, onDecide };
  useEffect(() => {
    if (!hovered) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || isTypingTarget(e.target) || !/^[012]$/.test(e.key)) return;
      const cur = latest.current;
      if (cur.busy) return;
      if (e.key === "0") {
        if (cur.item.decision) cur.onDecide(null);
      } else cur.onDecide(e.key === "1" ? "OK" : "NG");
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hovered]);
  return (
    <article
      data-testid={`verdict-card-${item.frame}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", background: "var(--panel)", padding: 8, minWidth: 0, boxSizing: "border-box" }}
    >
      <img
        src={`/api/cameras/${encodeURIComponent(camera)}/frames/${encodeURIComponent(item.frame)}/thumb`}
        alt={item.frame}
        loading="lazy"
        style={{ width: "100%", display: "block" }}
      />
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
          <button key={c} disabled={busy} aria-label={item.status === "stale" && item.decision === c ? `Keep ${c} for ${item.frame}` : `Decide ${c} for ${item.frame}`} aria-pressed={item.kind === "manual" && item.verdict === c} onClick={() => onDecide(c)}>
            {item.status === "stale" && item.decision === c ? `Keep ${c}` : c}
          </button>
        ))}
        {item.decision && (
          <button disabled={busy} aria-label={`Clear my decision for ${item.frame}`} onClick={() => onDecide(null)}>
            Clear
          </button>
        )}
      </div>
    </article>
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
  const [busy, setBusy] = useState(false);

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
    setBusy(true);
    try {
      await api.verdictDecide(camera, frame, cls);
      load();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
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
          <p style={{ fontSize: 12, margin: "0 0 4px" }}>⌨ Hover a card and press 1 = OK, 2 = NG, 0 = clear my decision.</p>
          <Pager grid={list} settings={settings} onPage={setPage} onSettings={changeSettings} where="top" />
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${settings.cols}, minmax(0, 1fr))`, gap: 8 }}>
            {list.items.map((item) => (
              <Card key={item.frame} camera={camera} item={item} busy={busy} onDecide={(c) => void decide(item.frame, c)} />
            ))}
          </div>
          <Pager grid={list} settings={settings} onPage={setPage} onSettings={changeSettings} where="bottom" />
        </>
      )}
    </section>
  );
}
