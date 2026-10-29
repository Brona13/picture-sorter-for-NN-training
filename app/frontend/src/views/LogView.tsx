import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { api, LogPage, LogRecord, TimingRow } from "../api";
import CopyButton from "../CopyButton";
import { pageText, recordText } from "./logText";
import TimingPanel from "./TimingPanel";

type Row = LogRecord & { children?: number };
const LEVELS = ["DEBUG", "INFO", "WARNING", "ERROR"];
const PER_PAGE = [25, 50, 100, 200];
const STORE = "picture-sorter.log-filters";
type Order = "time" | "ms" | "level" | "area" | "message";

type Settings = {
  level: string;
  source: string;
  area: string;
  thisCamera: boolean;
  sinceRestart: boolean;
  text: string;
  minMs: string;
  order: Order;
  desc: boolean;
  perPage: number;
  nested: boolean;
};
const DEFAULTS: Settings = { level: "WARNING", source: "", area: "", thisCamera: false, sinceRestart: false, text: "", minMs: "", order: "time", desc: true, perPage: 50, nested: false };

/** What the person chose last time (this browser only; the page works without storage). */
function storedSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? "{}") as Partial<Settings>;
    return {
      level: LEVELS.includes(raw.level ?? "") ? raw.level! : DEFAULTS.level,
      source: typeof raw.source === "string" ? raw.source : DEFAULTS.source,
      area: typeof raw.area === "string" ? raw.area : DEFAULTS.area,
      thisCamera: raw.thisCamera === true,
      sinceRestart: raw.sinceRestart === true,
      text: typeof raw.text === "string" ? raw.text : "",
      minMs: typeof raw.minMs === "string" ? raw.minMs : "",
      order: (["time", "ms", "level", "area", "message"] as Order[]).includes(raw.order as Order) ? (raw.order as Order) : DEFAULTS.order,
      desc: raw.desc !== false,
      perPage: PER_PAGE.includes(raw.perPage ?? 0) ? raw.perPage! : DEFAULTS.perPage,
      nested: raw.nested === true,
    };
  } catch {
    return DEFAULTS;
  }
}

const depthOf = (r: LogRecord): number => {
  try {
    return Number((JSON.parse(r.extra ?? "{}") as { depth?: number }).depth ?? 1);
  } catch {
    return 1;
  }
};

/** The log database as a table: filter, order, page, and (grouped) one row per request with its steps below it. */
export default function LogView({ camera }: { camera: string }) {
  const [initial] = useState(storedSettings);
  const [s, setS] = useState<Settings>(initial);
  const [textInput, setTextInput] = useState(initial.text);
  const [msInput, setMsInput] = useState(initial.minMs);
  const [requestId, setRequestId] = useState("");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<LogPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Record<string, Row[] | "loading">>({});
  const [facets, setFacets] = useState<{ areas: string[]; sources: string[] }>({ areas: [], sources: [] });
  const [version, setVersion] = useState("");
  const [debug, setDebug] = useState(false);
  const [timing, setTiming] = useState<TimingRow[] | null>(null);
  const change = (patch: Partial<Settings>) => {
    setS((old) => ({ ...old, ...patch }));
    setOffset(0);
  };

  useEffect(() => {
    try {
      localStorage.setItem(STORE, JSON.stringify(s));
    } catch {
      /* storage blocked: the settings are simply not remembered */
    }
  }, [s]);

  // The search and minimum-time boxes apply a moment after the last key.
  useEffect(() => {
    const t = setTimeout(() => {
      if (textInput !== s.text || msInput !== s.minMs) change({ text: textInput, minMs: msInput });
    }, 350);
    return () => clearTimeout(t);
  }, [textInput, msInput]); // eslint-disable-line react-hooks/exhaustive-deps

  const seq = useRef(0);
  const load = useCallback(() => {
    const mine = ++seq.current;
    const minMs = Number(s.minMs);
    api
      .logPage({
        level: s.level,
        source: s.source,
        area: s.area,
        camera: s.thisCamera ? camera : "",
        request_id: requestId.trim(),
        since_restart: s.sinceRestart || undefined,
        text: s.text.trim(),
        min_ms: s.minMs.trim() !== "" && Number.isFinite(minMs) ? minMs : undefined,
        order: s.order,
        desc: s.desc,
        offset,
        limit: s.perPage,
        nested: s.nested || undefined,
      })
      .then((r) => {
        if (mine !== seq.current) return;
        setPage(r);
        setExpanded({});
        setError(null);
      })
      .catch((e: unknown) => mine === seq.current && setError(e instanceof Error ? e.message : String(e)));
  }, [s, camera, requestId, offset]);
  useEffect(load, [load]);

  useEffect(() => {
    api.logFacets().then((f) => setFacets({ areas: f.areas ?? [], sources: f.sources ?? [] })).catch(() => {});
    api.logDebug().then((d) => setDebug(d.on === true)).catch(() => {});
    fetch("/api/version").then((r) => r.json()).then((v) => setVersion(`Picture Sorter ${v.version}`)).catch(() => {});
  }, []);

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const switchDebug = (on: boolean) => {
    api.setLogDebug(on).then((d) => {
      setDebug(d.on);
      if (d.on) change({ level: "DEBUG" });
    }).catch(fail);
  };
  const loadTiming = () => api.logTiming(true).then(setTiming).catch(fail);

  const toggleRequest = (r: Row) => {
    const id = r.request_id;
    if (!id) return;
    if (expanded[id]) {
      setExpanded(({ [id]: _drop, ...rest }) => rest);
      return;
    }
    setExpanded((e) => ({ ...e, [id]: "loading" }));
    api.logPage({ children_of: id }).then((p) => setExpanded((e) => ({ ...e, [id]: p.rows }))).catch((err) => {
      setExpanded(({ [id]: _drop, ...rest }) => rest);
      fail(err);
    });
  };

  const sortBy = (order: Order) => change(s.order === order ? { desc: !s.desc } : { order, desc: order === "time" || order === "ms" });
  const head = (order: Order, label: string, right = false) => (
    <th align={right ? "right" : "left"} aria-sort={s.order === order ? (s.desc ? "descending" : "ascending") : "none"}>
      <button type="button" className="link" onClick={() => sortBy(order)}>{label}{s.order === order ? (s.desc ? " ▼" : " ▲") : ""}</button>
    </th>
  );

  const total = page?.total ?? 0;
  const first = total === 0 ? 0 : offset + 1;
  const last = Math.min(total, offset + s.perPage);
  const rows = page?.rows ?? [];
  const reset = () => {
    setTextInput("");
    setMsInput("");
    setRequestId("");
    setS({ ...DEFAULTS, perPage: s.perPage });
    setOffset(0);
  };

  return (
    <section>
      <h2>Log</h2>
      <p>Errors and events the app recorded, from the backend and from this browser. Click a column to sort; with "Group by request" each request is one row and its steps open below it.</p>
      <p>
        <label title="Records every request and every timed step with its duration, also the fast ones. Costs a little speed and disk; switch it off when done. It stays on after a restart.">
          <input type="checkbox" checked={debug} onChange={(e) => switchDebug(e.target.checked)} /> Debug mode (log how long actions take)
        </label>
      </p>
      <TimingPanel rows={timing} version={version} onReload={() => void loadTiming()} />
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <label>
          Level{" "}
          <select value={s.level} onChange={(e) => change({ level: e.target.value })}>
            {LEVELS.map((l) => (
              <option key={l} value={l}>{l === "DEBUG" ? "all (DEBUG+)" : `${l}+`}</option>
            ))}
          </select>
        </label>
        <label>
          Source{" "}
          <select value={s.source} onChange={(e) => change({ source: e.target.value })}>
            <option value="">both</option>
            {[...new Set(["backend", "frontend", ...facets.sources])].map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
        <label>
          Area{" "}
          <select value={s.area} onChange={(e) => change({ area: e.target.value })}>
            <option value="">all</option>
            {facets.areas.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
        <label>
          <input type="checkbox" checked={s.thisCamera} onChange={(e) => change({ thisCamera: e.target.checked })} disabled={!camera} /> only {camera || "this camera"}
        </label>
        <label title="Only what was recorded after the backend was last started">
          <input type="checkbox" checked={s.sinceRestart} onChange={(e) => change({ sinceRestart: e.target.checked })} /> since app restart
        </label>
        <label>
          Find text <input value={textInput} onChange={(e) => setTextInput(e.target.value)} size={14} aria-label="Find text" />
        </label>
        <label title="Only records that took at least this many milliseconds">
          Slower than <input value={msInput} onChange={(e) => setMsInput(e.target.value)} size={5} inputMode="decimal" aria-label="Slower than (ms)" /> ms
        </label>
        <label>
          Request id <input value={requestId} onChange={(e) => { setRequestId(e.target.value); setOffset(0); }} size={14} />
        </label>
        <label title="One row per request; its timed steps open below it">
          <input type="checkbox" checked={s.nested} onChange={(e) => change({ nested: e.target.checked })} /> Group by request
        </label>
        <label>
          Per page{" "}
          <select value={s.perPage} onChange={(e) => change({ perPage: Number(e.target.value) })}>
            {PER_PAGE.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <button type="button" onClick={load}>Refresh</button>
        <button type="button" onClick={reset}>Reset filters</button>
        {rows.length > 0 && <CopyButton text={pageText(rows, expanded, version)} label={`Copy ${rows.length} for Claude`} />}
      </div>
      {error && <p role="alert">{error}</p>}
      {!page ? (
        <p>Loading…</p>
      ) : rows.length === 0 ? (
        <p>No records for this filter.</p>
      ) : (
        <>
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 6 }} aria-label="Pages">
            <button type="button" onClick={() => setOffset(Math.max(0, offset - s.perPage))} disabled={offset === 0}>‹ Previous</button>
            <span>{first}–{last} of {total}</span>
            <button type="button" onClick={() => setOffset(offset + s.perPage)} disabled={last >= total}>Next ›</button>
          </div>
          <table className="log-table" style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {s.nested && <th aria-label="Steps" />}
                {head("time", "Time")}
                {head("ms", "ms", true)}
                {head("level", "Level")}
                {head("area", "Source")}
                {head("message", "Message")}
                <th align="left">Request</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Fragment key={r.id}>
                  <LogRow r={r} nested={s.nested} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} onRequest={(id) => { setRequestId(id); setOffset(0); }}
                    stepsOpen={!!r.request_id && !!expanded[r.request_id]} onSteps={() => toggleRequest(r)} />
                  {r.request_id && Array.isArray(expanded[r.request_id]) && (expanded[r.request_id] as Row[]).map((c) => (
                    <LogRow key={c.id} r={c} child depth={depthOf(c)} nested={s.nested} open={open === c.id} onToggle={() => setOpen(open === c.id ? null : c.id)} onRequest={(id) => { setRequestId(id); setOffset(0); }} />
                  ))}
                  {r.request_id && expanded[r.request_id] === "loading" && <tr><td colSpan={7}>Loading steps…</td></tr>}
                </Fragment>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

function LogRow({ r, nested, open, onToggle, onRequest, child = false, depth = 0, stepsOpen = false, onSteps }: {
  r: Row; nested: boolean; open: boolean; onToggle: () => void; onRequest: (id: string) => void; child?: boolean; depth?: number; stepsOpen?: boolean; onSteps?: () => void;
}) {
  const d = new Date(r.ts * 1000);
  const when = `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
  return (
    <>
      <tr data-testid={`log-row-${r.id}`} style={{ borderTop: "1px solid #8884", color: r.level === "ERROR" || r.level === "CRITICAL" ? "#c0392b" : undefined, opacity: child ? 0.9 : 1 }}>
        {nested && (
          <td style={{ width: 24 }}>
            {!child && (r.children ?? 0) > 0 && (
              <button type="button" className="link" onClick={onSteps} aria-expanded={stepsOpen} aria-label={`${stepsOpen ? "Hide" : "Show"} ${r.children} steps`} title={`${r.children} steps`}>{stepsOpen ? "▾" : "▸"}</button>
            )}
          </td>
        )}
        <td style={{ whiteSpace: "nowrap" }}>{when}</td>
        <td align="right">{r.duration_ms ?? ""}</td>
        <td>{r.level}</td>
        <td>{r.source}/{r.logger}</td>
        <td style={child ? { paddingLeft: 12 + depth * 16 } : undefined}>
          <button type="button" className="link" onClick={onToggle} aria-expanded={open} style={{ textAlign: "left" }}>{child ? "↳ " : ""}{r.message}</button>
        </td>
        <td>{!child && r.request_id && <button type="button" className="link" title="Show this request only" onClick={() => onRequest(r.request_id!)}>{r.request_id}</button>}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={nested ? 7 : 6}>
            <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{recordText(r)}</pre>
            <CopyButton text={recordText(r)} label="Copy this record" />
          </td>
        </tr>
      )}
    </>
  );
}
