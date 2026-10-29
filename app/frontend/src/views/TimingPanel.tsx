import { useMemo, useState } from "react";
import type { TimingRow } from "../api";
import CopyButton from "../CopyButton";
import { timingText } from "./logText";

const STORE = "picture-sorter.log-timing";
type Column = "name" | "count" | "total_ms" | "avg_ms" | "p95_ms" | "max_ms";
type Prefs = { open: boolean; column: Column; desc: boolean; kind: "" | "request" | "step"; text: string };
const DEFAULTS: Prefs = { open: true, column: "total_ms", desc: true, kind: "", text: "" };
const COLUMNS: { key: Column; label: string; numeric: boolean }[] = [
  { key: "name", label: "What", numeric: false },
  { key: "count", label: "Times", numeric: true },
  { key: "total_ms", label: "Total ms", numeric: true },
  { key: "avg_ms", label: "Average", numeric: true },
  { key: "p95_ms", label: "95%", numeric: true },
  { key: "max_ms", label: "Max", numeric: true },
];

function storedPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? "{}") as Partial<Prefs>;
    return {
      open: raw.open !== false,
      column: COLUMNS.some((c) => c.key === raw.column) ? raw.column! : DEFAULTS.column,
      desc: raw.desc !== false,
      kind: raw.kind === "request" || raw.kind === "step" ? raw.kind : "",
      text: typeof raw.text === "string" ? raw.text : "",
    };
  } catch {
    return DEFAULTS;
  }
}

/** "Where the time went": requests and timed steps, sortable and filterable, and it can be folded away. */
export default function TimingPanel({ rows, version, onReload }: { rows: TimingRow[] | null; version: string; onReload: () => void }) {
  const [prefs, setPrefsState] = useState(storedPrefs);
  const setPrefs = (patch: Partial<Prefs>) => {
    const next = { ...prefs, ...patch };
    setPrefsState(next);
    try {
      localStorage.setItem(STORE, JSON.stringify(next));
    } catch {
      /* storage blocked: not remembered */
    }
  };
  const shown = useMemo(() => {
    const needle = prefs.text.trim().toLowerCase();
    const list = (rows ?? []).filter((r) => (!prefs.kind || r.kind === prefs.kind) && (!needle || r.name.toLowerCase().includes(needle)));
    const sign = prefs.desc ? -1 : 1;
    return [...list].sort((a, b) => {
      const x = a[prefs.column];
      const y = b[prefs.column];
      return (typeof x === "string" ? x.localeCompare(String(y)) : Number(x) - Number(y)) * sign;
    });
  }, [rows, prefs]);

  const sortBy = (column: Column) => setPrefs(prefs.column === column ? { desc: !prefs.desc } : { column, desc: column !== "name" });

  return (
    <section aria-label="Where the time went" style={{ marginBottom: 12 }}>
      <h3 style={{ margin: "8px 0" }}>
        <button type="button" className="link" aria-expanded={prefs.open} onClick={() => setPrefs({ open: !prefs.open })} style={{ textDecoration: "none", fontWeight: "inherit", fontSize: "inherit" }}>
          {prefs.open ? "▾" : "▸"} Where the time went
        </button>
        {rows && <span className="muted" style={{ fontWeight: "normal", fontSize: 13 }}> ({rows.length} rows, since app restart)</span>}
      </h3>
      {prefs.open && (
        <>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
            <button type="button" onClick={onReload}>{rows ? "Refresh" : "Show"}</button>
            <label>
              Show{" "}
              <select value={prefs.kind} onChange={(e) => setPrefs({ kind: e.target.value as Prefs["kind"] })}>
                <option value="">requests and steps</option>
                <option value="request">requests only</option>
                <option value="step">steps only</option>
              </select>
            </label>
            <label>
              Search <input value={prefs.text} onChange={(e) => setPrefs({ text: e.target.value })} size={16} aria-label="Search timing" />
            </label>
            {rows && rows.length > 0 && <CopyButton text={timingText(shown, version)} label="Copy timing for Claude" />}
          </div>
          {rows && (
            <table className="log-table" style={{ borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {COLUMNS.map((c) => (
                    <th key={c.key} align={c.numeric ? "right" : "left"} aria-sort={prefs.column === c.key ? (prefs.desc ? "descending" : "ascending") : "none"}>
                      <button type="button" className="link" onClick={() => sortBy(c.key)}>{c.label}{prefs.column === c.key ? (prefs.desc ? " ▼" : " ▲") : ""}</button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 && <tr><td colSpan={6}>{rows.length === 0 ? "Nothing measured yet: switch Debug mode on, use the app for a while, then press Refresh." : "No row matches."}</td></tr>}
                {shown.map((t) => (
                  <tr key={`${t.kind}:${t.name}`} style={{ borderTop: "1px solid #8884" }}>
                    <td>{t.kind === "step" ? "· " : ""}{t.name}</td>
                    <td align="right">{t.count}</td>
                    <td align="right">{t.total_ms}</td>
                    <td align="right">{t.avg_ms}</td>
                    <td align="right">{t.p95_ms}</td>
                    <td align="right">{t.max_ms}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
