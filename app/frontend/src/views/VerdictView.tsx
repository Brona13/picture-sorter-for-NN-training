import { useCallback, useEffect, useState } from "react";
import { api, VerdictItem, VerdictList, VerdictSummary } from "../api";
import { classColor } from "../classify/colors";
import PictureSizeSlider, { usePictureSize } from "../PictureSize";
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

function Card({ camera, item, size, busy, onDecide }: { camera: string; item: VerdictItem; size: number; busy: boolean; onDecide: (cls: "OK" | "NG" | null) => void }) {
  const verdict = item.verdict;
  return (
    <article
      data-testid={`verdict-card-${item.frame}`}
      style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", background: "var(--panel)", padding: 8, width: size, boxSizing: "border-box" }}
    >
      <img
        src={`/api/cameras/${encodeURIComponent(camera)}/frames/${encodeURIComponent(item.frame)}/thumb`}
        alt={item.frame}
        loading="lazy"
        style={{ maxWidth: "100%", display: "block" }}
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
  const [size, resize] = usePictureSize("verdict.pictureSize", 240, 120, 600);

  const load = useCallback(() => {
    if (!camera) return;
    Promise.all([api.verdicts(camera, status, page, 24), api.verdictSummary(camera)])
      .then(([l, s]) => {
        setList(l);
        setSummary(s);
        setError(null);
        if (l.page !== page) setPage(l.page);
      })
      .catch((e: unknown) => setError(msg(e)));
  }, [camera, status, page]);

  useEffect(load, [load]);

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
      <PictureSizeSlider value={size} onChange={resize} min={120} max={600} />
      {list && list.items.length === 0 && <p>Nothing here.</p>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        {list?.items.map((item) => (
          <Card key={item.frame} camera={camera} item={item} size={size} busy={busy} onDecide={(c) => void decide(item.frame, c)} />
        ))}
      </div>
      {list && list.n_pages > 1 && (
        <p>
          <button disabled={page <= 1} onClick={() => setPage(page - 1)}>
            ‹ Previous
          </button>{" "}
          Page {list.page} of {list.n_pages}{" "}
          <button disabled={page >= list.n_pages} onClick={() => setPage(page + 1)}>
            Next ›
          </button>
        </p>
      )}
    </section>
  );
}
