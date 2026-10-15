import { useCallback, useEffect, useMemo, useState } from "react";
import { api, CardData, CardUpdate, ClassifyState, GridQuery, GridResponse } from "../api";
import AutoPanel, { AutoFilter } from "../classify/AutoPanel";
import BulkPanel from "../classify/BulkPanel";
import Card, { MAX_SHORTCUT_CLASSES } from "../classify/Card";
import ClearPanel from "../classify/ClearPanel";
import DeletedByDay from "../classify/DeletedByDay";
import SuggestPanel from "../classify/SuggestPanel";
import { useJob } from "../useJob";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const PHASES: Record<string, string> = {
  discovery: "Finding frames and goldens…",
  features: "Computing features…",
  comparison: "Comparing against goldens…",
  persistence: "Saving results…",
  presentation: "Preparing the grid…",
};

export default function ClassifyView({ camera, product }: { camera: string; product?: string }) {
  const [features, setFeatures] = useState<{ feature: string; label: string }[]>([]);
  const [feature, setFeature] = useState("");
  const [st, setSt] = useState<ClassifyState | null>(null);
  const [view, setView] = useState("All");
  const [rank, setRank] = useState("");
  const [order, setOrder] = useState("Most novel first");
  const [showMuted, setShowMuted] = useState(false);
  const [auto, setAuto] = useState<AutoFilter>({ on: false, classes: [], minMargin: null });
  const [page, setPage] = useState(1);
  const [grid, setGrid] = useState<GridResponse | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const job = useJob<{ frames: number; scored: boolean }>(jobId);
  const refreshing = jobId !== null && (job === null || job.status === "queued" || job.status === "running");

  const query: GridQuery = useMemo(
    () => ({
      feature,
      view,
      rank: rank || st?.default_rank || "",
      order,
      show_muted: showMuted,
      auto_preview: auto.on,
      auto_classes: auto.on ? auto.classes : null,
      auto_min_margin: auto.on ? auto.minMargin : null,
    }),
    [feature, view, rank, order, showMuted, auto, st?.default_rank],
  );

  // --- load feature list ---
  useEffect(() => {
    if (!camera) return;
    setFeature("");
    setSt(null);
    setGrid(null);
    api
      .versionFeatures(camera, product)
      .then((f) => {
        setFeatures(f);
        setFeature(f[0]?.feature ?? "");
      })
      .catch((e: unknown) => setError(msg(e)));
  }, [camera, product]);

  const loadState = useCallback(async () => {
    if (!camera || !feature) return;
    try {
      const s = await api.classifyState(camera, feature);
      setSt(s);
      setError(null);
    } catch (e) {
      setError(msg(e));
    }
  }, [camera, feature]);

  // --- switching feature resets view controls ---
  useEffect(() => {
    setView("All");
    setRank("");
    setOrder("Most novel first");
    setShowMuted(false);
    setPage(1);
    setJobId(null);
    setNotice(null);
    setSt(null);
    setGrid(null);
    loadState();
  }, [feature, loadState]);

  useEffect(() => {
    if (st) setAuto({ on: false, classes: st.classes, minMargin: null });
  }, [st?.feature]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadGrid = useCallback(async () => {
    if (!camera || !feature || !st) return;
    try {
      const g = await api.classifyGrid(camera, query, page);
      setGrid(g);
      if (g.page !== page) setPage(g.page);
    } catch (e) {
      setError(msg(e));
    }
  }, [camera, feature, st?.feature, query, page]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    loadGrid();
  }, [loadGrid, revision]);

  // Changing any filter returns to page 1.
  useEffect(() => setPage(1), [view, rank, order, showMuted, auto.on, auto.classes, auto.minMargin]);

  useEffect(() => {
    if (job?.status === "done") {
      setNotice(`Scores refreshed — ${job.result?.frames ?? 0} frames.`);
      loadState();
      setRevision((r) => r + 1);
    } else if (job?.status === "error") setError(job.error);
  }, [job?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const bump = () => {
    setRevision((r) => r + 1);
    loadState();
  };

  async function act(frame: string, call: () => Promise<CardUpdate>, reloadGrid = false) {
    setBusy(frame);
    setError(null);
    try {
      const r = await call();
      setSt((s) => (s ? { ...s, counts: r.counts } : s));
      if (reloadGrid) bump();
      else {
        setGrid((g) =>
          g ? { ...g, items: g.items.map((c): CardData => (c.frame === frame ? { ...c, ...r.card } : c)) } : g,
        );
      }
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(null);
    }
  }

  function changeSetting(per_page: number, cols: number) {
    api
      .setGridSettings(camera, feature, per_page, cols)
      .then(() => {
        setSt((s) => (s ? { ...s, settings: { ...s.settings, per_page, cols } } : s));
        setPage(1);
        setRevision((r) => r + 1);
      })
      .catch((e: unknown) => setError(msg(e)));
  }

  if (!camera) return <p>Select a camera.</p>;
  const classes = st?.classes ?? [];
  const progress = job?.progress ?? {};
  const phase = String(progress.phase ?? "");
  const done = Number(progress.done ?? 0);
  const total = Number(progress.total ?? 0);
  const counts = st?.counts ?? {};

  return (
    <section>
      <h2>
        Classify — {camera}
        {product ? ` › ${product}` : ""}
      </h2>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}

      <label>
        Feature (ROI){" "}
        <select value={feature} onChange={(e) => setFeature(e.target.value)}>
          {features.map((f) => (
            <option key={f.feature} value={f.feature}>
              {f.label}
            </option>
          ))}
        </select>
      </label>

      {st?.shared_products && (
        <p>
          🔗 <strong>Shared ROI</strong> — one golden set and one label set covering <strong>{st.shared_products.join(", ")}</strong>. The grid shows
          every frame of those products, whichever one the sidebar is on.
          {st.frames_seen !== st.inbox_total &&
            ` It covers ${st.frames_seen} of ${st.inbox_total} frames — the other ${st.inbox_total - st.frames_seen} have no product yet, so sort them under All frames — product sort first.`}
        </p>
      )}
      {product && st && st.frames_seen === 0 && (
        <p>
          No frames are classified as <strong>{product}</strong> yet. Switch the sidebar to <strong>All frames</strong>, label some frames with this
          product, then come back.
        </p>
      )}

      {st && (
        <dl style={{ display: "flex", gap: 24 }}>
          <div>
            <dt>Frames</dt>
            <dd>{counts.total ?? 0}</dd>
          </div>
          {classes.map((c) => (
            <div key={c}>
              <dt>{c}</dt>
              <dd>
                {counts[c] ?? 0} <small>⭐ {counts[`golden_${c}`] ?? 0}</small>
              </dd>
            </div>
          ))}
        </dl>
      )}

      {st?.cold_start && (
        <p>
          <strong>Start here:</strong> mark a few reference frames ({classes.slice(0, 2).map((c) => `⭐${c}`).join(" / ")}, …). Then hit Refresh — every
          frame gets scored against your goldens and shows which class it leans toward.
        </p>
      )}

      <div>
        <button
          disabled={!st || refreshing}
          onClick={() => {
            setNotice(null);
            api
              .classifyRefresh(camera, feature)
              .then((j) => setJobId(j.id))
              .catch((e: unknown) => setError(msg(e)));
          }}
        >
          🔄 Refresh scores
        </button>{" "}
        {st && (
          <small>
            Methods: {st.methods.join(", ")} · neural device: {st.device_label} · cached — only the first pass over a new batch is slow.
          </small>
        )}
        {refreshing && (
          <p aria-live="polite">
            <progress value={done} max={total || undefined} /> {PHASES[phase] ?? "Queued…"}
            {total ? ` ${done}/${total}` : ""}
            {progress.detail ? ` · ${String(progress.detail)}` : ""}
          </p>
        )}
      </div>

      {st && !st.has_results && !refreshing && <p>Click Refresh scores to evaluate the inbox.</p>}
      {st?.stale.goldens && (
        <p role="status">
          ⭐ Goldens changed since the last refresh — mark as many as you like, then hit <strong>Refresh scores</strong> to re-evaluate everything against them.
        </p>
      )}
      {st && !st.stale.goldens && st.stale.frames && (
        <p role="status">
          🆕 The frame set changed since the last refresh (ingest or delete) — hit <strong>Refresh scores</strong> to score the new set.
        </p>
      )}

      {st && st.has_results && (
        <>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", margin: "8px 0" }}>
            <label>
              Show{" "}
              <select value={view} onChange={(e) => setView(e.target.value)}>
                {st.views.map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
            <label>
              Rank using{" "}
              <select value={query.rank} disabled={!st.scored} onChange={(e) => setRank(e.target.value)}>
                {st.methods.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </label>
            <label>
              Order by{" "}
              <select value={order} disabled={!st.scored} onChange={(e) => setOrder(e.target.value)}>
                {st.orders.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            </label>
            {st.muted_count > 0 && (
              <label>
                <input type="checkbox" checked={showMuted} onChange={(e) => setShowMuted(e.target.checked)} /> Show muted ({st.muted_count} hidden by dedup)
              </label>
            )}
          </div>
          {view === "Deleted" ? (
            <DeletedByDay camera={camera} feature={feature} revision={revision} onChanged={bump} onNotice={setNotice} onError={setError} />
          ) : (
            <>
          {!st.scored ? (
            <p>
              ℹ️ <em>Rank using</em> and <em>Order by</em> are greyed out, and no scores appear under the pictures, because <strong>nothing is scored yet</strong> —
              scoring needs reference frames. Mark at least one <strong>☆OK</strong> (and ideally one <strong>☆NG</strong>) on a picture below, then press{" "}
              <strong>🔄 Refresh scores</strong>.
            </p>
          ) : (
            <p>
              Bars under each picture show how close that frame is to each class's ⭐goldens under <strong>{query.rank}</strong> — longest bar = nearest
              class = the leaning. Near-equal bars (or <strong>⚠ close call</strong>) mean the machine can't separate them: those are the frames worth your
              eyes. They're a similarity advisory, not a probability.
            </p>
          )}

          {st.scored && (
            <>
              <BulkPanel
                camera={camera}
                query={query}
                classes={classes}
                revision={revision}
                onError={setError}
                onLabeled={(n, cls, c) => {
                  setNotice(`Labeled ${n} frames as ${cls}.`);
                  setSt((s) => (s ? { ...s, counts: c } : s));
                  bump();
                }}
              />
              <ClearPanel
                camera={camera}
                query={query}
                revision={revision}
                onError={setError}
                onCleared={(n, spared, c) => {
                  setNotice(
                    `Cleared ${n} label${n === 1 ? "" : "s"}.` +
                      (spared > 0 ? ` ${spared} golden${spared === 1 ? "" : "s"} kept.` : ""),
                  );
                  setSt((s) => (s ? { ...s, counts: c } : s));
                  bump();
                }}
              />
              <AutoPanel
                camera={camera}
                query={query}
                allClasses={classes}
                revision={revision}
                filter={auto}
                onFilter={setAuto}
                onError={setError}
                onApplied={(n, c) => {
                  setNotice(`Auto-labelled ${n} frame(s) using ${query.rank}. Review or undo any of them from the grid.`);
                  setSt((s) => (s ? { ...s, counts: c } : s));
                  setAuto((a) => ({ ...a, on: false, minMargin: null }));
                  bump();
                }}
              />
            </>
          )}
          {st.scored && (
            <SuggestPanel
              camera={camera}
              query={query}
              classes={classes}
              revision={revision}
              onError={setError}
              onPromoted={(frame, cls, c) => {
                setNotice(`Promoted ${frame} → ⭐ ${cls}`);
                setSt((s) => (s ? { ...s, counts: c } : s));
                bump();
              }}
            />
          )}
          {auto.on && grid && (
            <p>
              🔍 Grid filtered to the <strong>{grid.total}</strong> auto-assign preview frames.
            </p>
          )}

          {grid && grid.total === 0 && <p>No frames match this view.</p>}
          {grid && grid.total > 0 && (
            <>
              <p>
                <small>
                  ⌨ Hover a card and press{" "}
                  {classes.slice(0, MAX_SHORTCUT_CLASSES).map((c, i) => `${i + 1} = ${c}`).join(", ")}
                  {", 0 = clear label, the key left of 1 = golden on/off"} (no clicking needed).
                </small>
              </p>
              <Pager grid={grid} settings={st.settings} onPage={setPage} onSettings={changeSetting} where="top" />
              <ul
                style={{
                  display: "grid",
                  gridTemplateColumns: `repeat(${st.settings.cols}, minmax(0, 1fr))`, // exactly the chosen number of columns
                  gap: 8,
                  padding: 0,
                }}
              >
                {grid.items.map((card) => (
                  <Card
                    key={card.frame}
                    camera={camera}
                    feature={feature}
                    classes={classes}
                    methods={st.methods}
                    card={card}
                    busy={busy === card.frame}
                    onLabel={(cls) => act(card.frame, () => api.setLabel(camera, feature, card.frame, cls))}
                    onGolden={(on) => act(card.frame, () => api.setGolden(camera, feature, card.frame, on))}
                    onDelete={() => act(card.frame, () => api.deleteFrame(camera, feature, card.frame), true)}
                    onRestore={() => act(card.frame, () => api.restoreFrame(camera, feature, card.frame), true)}
                  />
                ))}
              </ul>
              <Pager grid={grid} settings={st.settings} onPage={setPage} onSettings={changeSetting} where="bottom" />
            </>
          )}
            </>
          )}
        </>
      )}
    </section>
  );
}

interface PagerProps {
  grid: GridResponse;
  settings: ClassifyState["settings"];
  onPage: (p: number) => void;
  onSettings: (perPage: number, cols: number) => void;
  where: string;
}

function Pager({ grid, settings, onPage, onSettings, where }: PagerProps) {
  const start = (grid.page - 1) * grid.per_page;
  const end = Math.min(start + grid.per_page, grid.total);
  const atStart = grid.page <= 1;
  const atEnd = grid.page >= grid.n_pages;
  return (
    <div role="navigation" aria-label={`Pagination ${where}`} style={{ display: "flex", gap: 8, alignItems: "center", margin: "8px 0" }}>
      <button disabled={atStart} onClick={() => onPage(1)}>
        « First
      </button>
      <button disabled={atStart} onClick={() => onPage(grid.page - 1)}>
        ‹ Prev
      </button>
      <span style={{ flex: 1, textAlign: "center" }}>
        Page <strong>{grid.page}</strong> of {grid.n_pages} · frames <strong>{start + 1}–{end}</strong> of {grid.total}
      </span>
      <button disabled={atEnd} onClick={() => onPage(grid.page + 1)}>
        Next ›
      </button>
      <button disabled={atEnd} onClick={() => onPage(grid.n_pages)}>
        Last »
      </button>
      <label>
        Per page{" "}
        <select
          aria-label={`Per page ${where}`}
          value={settings.per_page}
          onChange={(e) => onSettings(Number(e.target.value), settings.cols)}
        >
          {settings.per_page_options.map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
      </label>
      <label>
        Columns{" "}
        <select
          aria-label={`Columns ${where}`}
          value={settings.cols}
          onChange={(e) => onSettings(settings.per_page, Number(e.target.value))}
        >
          {settings.cols_options.map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
      </label>
    </div>
  );
}
