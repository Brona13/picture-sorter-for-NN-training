import { useCallback, useEffect, useState } from "react";
import { api, LogRecord, TimingRow } from "../api";
import CopyButton from "../CopyButton";
import { logsText, recordText } from "./logText";

const LEVELS = ["DEBUG", "INFO", "WARNING", "ERROR"];

/** The log database: filter by level, source, camera or request id; copy records as text for Claude. */
export default function LogView({ camera }: { camera: string }) {
  const [records, setRecords] = useState<LogRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState("WARNING");
  const [source, setSource] = useState("");
  const [thisCamera, setThisCamera] = useState(false);
  const [requestId, setRequestId] = useState("");
  const [sinceRestart, setSinceRestart] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [version, setVersion] = useState("");
  const [debug, setDebug] = useState(false);
  const [timing, setTiming] = useState<TimingRow[] | null>(null);

  const load = useCallback(() => {
    api
      .logs({ level, source, camera: thisCamera ? camera : "", request_id: requestId.trim(), since_restart: sinceRestart || undefined, limit: 300 })
      .then((r) => {
        setRecords(r);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [level, source, thisCamera, camera, requestId, sinceRestart]);

  useEffect(load, [load]);
  useEffect(() => {
    api.logDebug().then((d) => setDebug(d.on === true)).catch(() => {});
  }, []);
  const switchDebug = (on: boolean) => {
    api.setLogDebug(on).then((d) => {
      setDebug(d.on);
      if (d.on) setLevel("DEBUG");
    }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  const loadTiming = () => {
    api.logTiming(true).then(setTiming).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(() => {
    fetch("/api/version").then((r) => r.json()).then((v) => setVersion(`Picture Sorter ${v.version}`)).catch(() => {});
  }, []);

  return (
    <section>
      <h2>Log</h2>
      <p>Errors and events the app recorded, from the backend and from this browser. Click a request id to see everything that belongs to one action.</p>
      <p>
        <label title="Records every request and every timed step with its duration, also the fast ones. Costs a little speed and disk; switch it off when done. It stays on after a restart.">
          <input type="checkbox" checked={debug} onChange={(e) => switchDebug(e.target.checked)} /> Debug mode (log how long actions take)
        </label>{" "}
        {debug && <button type="button" onClick={loadTiming}>Where the time went</button>}
      </p>
      {timing && (
        <table className="log-table" aria-label="Where the time went" style={{ borderCollapse: "collapse", marginBottom: 12 }}>
          <thead>
            <tr><th align="left">What</th><th align="right">Times</th><th align="right">Total ms</th><th align="right">Average</th><th align="right">95%</th><th align="right">Max</th></tr>
          </thead>
          <tbody>
            {timing.length === 0 && <tr><td colSpan={6}>Nothing measured yet: use the app for a while with debug mode on, then press the button again.</td></tr>}
            {timing.map((t) => (
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
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <label>
          Level{" "}
          <select value={level} onChange={(e) => setLevel(e.target.value)}>
            {LEVELS.map((l) => (
              <option key={l} value={l}>{l === "DEBUG" ? "all (DEBUG+)" : `${l}+`}</option>
            ))}
          </select>
        </label>
        <label>
          Source{" "}
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">both</option>
            <option value="backend">backend</option>
            <option value="frontend">frontend</option>
          </select>
        </label>
        <label>
          <input type="checkbox" checked={thisCamera} onChange={(e) => setThisCamera(e.target.checked)} disabled={!camera} /> only {camera || "this camera"}
        </label>
        <label title="Only what was recorded after the backend was last started">
          <input type="checkbox" checked={sinceRestart} onChange={(e) => setSinceRestart(e.target.checked)} /> since app restart
        </label>
        <label>
          Request id <input value={requestId} onChange={(e) => setRequestId(e.target.value)} size={14} />
        </label>
        <button type="button" onClick={load}>Refresh</button>
        {records && records.length > 0 && <CopyButton text={logsText(records, version)} label={`Copy ${records.length} for Claude`} />}
      </div>
      {error && <p role="alert">{error}</p>}
      {!records ? (
        <p>Loading…</p>
      ) : records.length === 0 ? (
        <p>No records for this filter.</p>
      ) : (
        <table className="log-table" style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr><th align="left">Time</th><th align="right">ms</th><th align="left">Level</th><th align="left">Source</th><th align="left">Message</th><th align="left">Request</th></tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <FragmentRow key={r.id} r={r} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} onRequest={setRequestId} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function FragmentRow({ r, open, onToggle, onRequest }: { r: LogRecord; open: boolean; onToggle: () => void; onRequest: (id: string) => void }) {
  const d = new Date(r.ts * 1000);
  const when = `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
  return (
    <>
      <tr data-testid={`log-row-${r.id}`} style={{ borderTop: "1px solid #8884", color: r.level === "ERROR" || r.level === "CRITICAL" ? "#c0392b" : undefined }}>
        <td style={{ whiteSpace: "nowrap" }}>{when}</td>
        <td align="right">{r.duration_ms ?? ""}</td>
        <td>{r.level}</td>
        <td>{r.source}/{r.logger}</td>
        <td>
          <button type="button" className="link" onClick={onToggle} aria-expanded={open} style={{ textAlign: "left" }}>{r.message}</button>
        </td>
        <td>{r.request_id && <button type="button" className="link" title="Show this request only" onClick={() => onRequest(r.request_id!)}>{r.request_id}</button>}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={6}>
            <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{recordText(r)}</pre>
            <CopyButton text={recordText(r)} label="Copy this record" />
          </td>
        </tr>
      )}
    </>
  );
}
