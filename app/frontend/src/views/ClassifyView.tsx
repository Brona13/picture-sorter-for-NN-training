import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import ClassifyKpis from "../classify/ClassifyKpis";
import ClassifyOutliers from "../classify/ClassifyOutliers";
import ClassifyScatter from "../classify/ClassifyScatter";
import { RankContext } from "../RankContext";
import { usePublishFeature, useSharedFeature } from "../SharedFeature";
import { api, CardData, CardUpdate, ClassifyState, GridQuery, GridResponse } from "../api";
import AutoPanel, { AutoFilter } from "../classify/AutoPanel";
import BulkPanel from "../classify/BulkPanel";
import Card from "../classify/Card";
import FrameViewer from "../classify/FrameViewer";
import SimilarPanel from "../classify/SimilarPanel";
import { methodTag } from "../methodTags";
import ClearPanel from "../classify/ClearPanel";
import CardGrid from "../classify/CardGrid";
import DeletedByDay from "../classify/DeletedByDay";
import { ProductRow, SearchNote, ShowAgain, showsProductRow } from "../classify/SearchExtras";
import SidePanel, { PanelSection } from "../SidePanel";
import SuggestPanel from "../classify/SuggestPanel";
import { useJob } from "../useJob";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const GRID_INFO = (
  <>
    <strong>Show</strong> filters the pictures the grid lists; <strong>Rank using</strong> and <strong>Order by</strong> sort them by the machine's
    scores. The tools below label, clear or auto-assign many pictures at once and act on the <em>whole</em> Show list, not only the page you see.
  </>
);
const PHASES: Record<string, string> = {
  discovery: "Finding frames and goldens…",
  features: "Computing features…",
  comparison: "Comparing against goldens…",
  persistence: "Saving results…",
  presentation: "Preparing the grid…",
};

/**
 * `focus` locks the page to one ROI: the one chosen on the Chain canvas, where its scope was already decided. The ROI
 * dropdown is then not offered, and a button leads back to the chain.
 */
export interface ClassifyFocus {
  feature: string;
  onBack: () => void;
}

export default function ClassifyView({ camera, product, focus }: { camera: string; product?: string; focus?: ClassifyFocus }) {
  const [features, setFeatures] = useState<{ feature: string; label: string }[]>([]);
  const [feature, setFeature] = useState("");
  const shared = useSharedFeature();
  usePublishFeature(feature, shared.publish);
  const [st, setSt] = useState<ClassifyState | null>(null);
  const [view, setView] = useState("All");
  // The method to rank by is chosen in the top bar ("Rank using"); until it is, or when it is not in use, the server's default.
  const chosen = useContext(RankContext).rank;
  const rank = st && chosen && st.methods.includes(chosen) ? chosen : "";
  const [order, setOrder] = useState("Most novel first");
  const [showMuted, setShowMuted] = useState(false);
  const [auto, setAuto] = useState<AutoFilter>({ on: false, classes: [], minMargin: null });
  const [page, setPage] = useState(1);
  const [grid, setGrid] = useState<GridResponse | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null); // the picture viewer, on a frame of this page
  const [revision, setRevision] = useState(0);
  const [search, setSearch] = useState(""); // a part of a file name: the grid then lists matching pictures of the whole camera
  const [mode, setMode] = useState<"grid" | "scatter" | "outliers">("grid");
  const [similarSeed, setSimilarSeed] = useState<{ frame: string; label: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // What the last refresh did; it is shown on the Refresh line, not as a notice under it.
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
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

  useEffect(() => setSimilarSeed(null), [feature]);
  // With a single method switched on there is nothing to disagree about: leave that filter.
  useEffect(() => {
    if (st && st.methods.length < 2 && view === "Methods disagree") setView("All");
  }, [st, view]);

  // --- load feature list ---
  useEffect(() => {
    if (!camera) return;
    setFeature("");
    setSt(null);
    setGrid(null);
    setSimilarSeed(null);
    if (focus) {
      setFeatures([]);
      setFeature(focus.feature);
      return;
    }
    api
      .versionFeatures(camera, product)
      .then((f) => {
        setFeatures(f);
        setFeature(shared.pick(f));
      })
      .catch((e: unknown) => setError(msg(e)));
  }, [camera, product, focus?.feature]); // eslint-disable-line react-hooks/exhaustive-deps

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
    setOrder("Most novel first");
    setShowMuted(false);
    setPage(1);
    setJobId(null);
    setNotice(null);
    setRefreshNote(null);
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
      const g = await api.classifyGrid(camera, search ? { ...query, search } : query, page);
      setGrid(g);
      if (g.page !== page) setPage(g.page);
    } catch (e) {
      setError(msg(e));
    }
  }, [camera, feature, st?.feature, query, page, search]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    loadGrid();
  }, [loadGrid, revision]);

  // Changing any filter returns to page 1.
  useEffect(() => setPage(1), [view, rank, order, showMuted, auto.on, auto.classes, auto.minMargin, search]);
  // A search belongs to one ROI.
  useEffect(() => setSearch(""), [camera, feature]);

  useEffect(() => {
    if (job?.status === "done") {
      setRefreshNote(`Scores refreshed — ${job.result?.frames ?? 0} frames.`);
      loadState();
      setRevision((r) => r + 1);
    } else if (job?.status === "error") setError(job.error);
  }, [job?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const bump = () => {
    setRevision((r) => r + 1);
    loadState();
  };

  // An action on the picture that is not about the open ROI's counts (the product label, a mute): reload everything after it.
  async function actElsewhere(frame: string, call: () => Promise<unknown>) {
    setBusy(frame);
    setError(null);
    try {
      await call();
      bump();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(null);
    }
  }

  // A delete or a restore changes the card in place (it fades, or comes back) and nothing else moves: the grid is only reloaded
  // when the user turns it. The numbers above are read again once the actions have settled, since quick ones answer out of order.
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshSoon = () => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => void loadState(), 400);
  };
  useEffect(() => () => void (settleTimer.current && clearTimeout(settleTimer.current)), []);
  const deleteInPlace = (frame: string) => act(frame, () => api.deleteFrame(camera, feature, frame)).then(refreshSoon);
  const restoreInPlace = (frame: string) => act(frame, () => api.restoreFrame(camera, feature, frame)).then(refreshSoon);

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
  const viewSwitch = (
    <div role="group" aria-label="View" style={{ display: "flex", gap: 6 }}>
      <button type="button" aria-pressed={mode === "grid"} onClick={() => setMode("grid")}>
        ▦ Grid
      </button>
      <button type="button" aria-pressed={mode === "scatter"} onClick={() => setMode("scatter")}>
        ✦ Scatter
      </button>
      <button type="button" aria-pressed={mode === "outliers"} onClick={() => setMode("outliers")}>
        ◎ Outliers
      </button>
    </div>
  );
  const progress = job?.progress ?? {};
  const phase = String(progress.phase ?? "");
  const done = Number(progress.done ?? 0);
  const total = Number(progress.total ?? 0);
  // Refreshing the scores belongs to the grid, so it sits on the navigation line while the grid is shown, with what the
  // page has to say about the scores (stale, missing, running) to its right.
  const refreshRow =
    mode === "grid" && st ? (
      <>
        <span aria-hidden="true" style={{ width: 14 }} />
        <button
          disabled={refreshing}
          onClick={() => {
            setNotice(null);
            setRefreshNote(null);
            api
              .classifyRefresh(camera, feature)
              .then((j) => setJobId(j.id))
              .catch((e: unknown) => setError(msg(e)));
          }}
        >
          🔄 Refresh scores
        </button>
        {refreshing && (
          <span aria-live="polite">
            <progress value={done} max={total || undefined} /> {PHASES[phase] ?? "Queued…"}
            {total ? ` ${done}/${total}` : ""}
            {progress.detail ? ` · ${String(progress.detail)}` : ""}
          </span>
        )}
        {refreshNote && <span role="status">{refreshNote}</span>}
        {!st.has_results && !refreshing && <span>Click Refresh scores to evaluate the inbox.</span>}
        {st.stale.goldens && (
          <span role="status">
            ⭐ Goldens changed since the last refresh — hit <strong>Refresh scores</strong> to re-evaluate everything against them.
          </span>
        )}
        {st.missing_methods && st.missing_methods.length > 0 && (
          <span role="status">
            ⚙️ {st.missing_methods.map(methodTag).join(", ")} switched on since the last refresh — hit <strong>Refresh scores</strong> so{" "}
            {st.missing_methods.length > 1 ? "they get" : "it gets"} scores.
          </span>
        )}
        {!st.stale.goldens && st.stale.frames && (
          <span role="status">
            🆕 The frame set changed since the last refresh (ingest or delete) — hit <strong>Refresh scores</strong> to score the new set.
          </span>
        )}
      </>
    ) : null;
  const navRow = { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", margin: "8px 0" } as const;
  const classes = st?.classes ?? [];

  // The Grid view's properties live in the options panel, like the Dedup pages' tools: which pictures it lists and in what
  // order, and the tools that label, clear or auto-assign many pictures at once. (Scatter and Outliers put theirs there
  // themselves, through `PanelPortal`.) The suggested goldens stay in the page: they are a list of pictures.
  const gridPanel =
    mode === "grid" && st && st.has_results ? (
      <PanelSection title="Grid" info={GRID_INFO} testId="grid-controls">
              <label>
                Show{" "}
                <select value={view} onChange={(e) => setView(e.target.value)}>
                  {st.views
                    .filter((v) => v !== "Methods disagree" || st.methods.length > 1) // one method cannot disagree with itself
                    .map((v) => (
                      <option key={v}>{v}</option>
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
        <div style={{ marginTop: 6 }}>
            {search && st.scored && <p role="status">The bulk, clear and auto-label tools are off while a search is active.</p>}
            {st.scored && (
              <fieldset disabled={!!search} style={{ border: 0, padding: 0, margin: 0, opacity: search ? 0.5 : 1 }}>
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
              </fieldset>
            )}

        </div>
      </PanelSection>
    ) : null;

  return (
    <section>
      <h2>
        Classify — {camera}
        {focus ? ` › ${focus.feature.split("::").pop()}` : product ? ` › ${product}` : ""}
      </h2>
      <SidePanel panel={gridPanel} wide>
      {focus && (
        // Locked to one ROI: the way back and the three views are all navigation, so they share one line.
        <div style={navRow}>
          <button type="button" onClick={focus.onBack}>
            ← Back to chain
          </button>
          {st && <span aria-hidden="true" style={{ width: 14 }} />}
          {st && viewSwitch}
          {refreshRow}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}

      {!focus && (
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
      )}

      {product && st && st.frames_seen === 0 && (
        <p>
          No frames are classified as <strong>{product}</strong> yet. Switch the sidebar to <strong>All frames</strong>, label some frames with this
          product, then come back.
        </p>
      )}

      {st && (
        <ClassifyKpis
          state={st}
          view={mode === "grid" && !search ? view : null}
          onPick={(v) => {
            // A box leads to the grid's View of those pictures, from wherever the page is.
            setSearch("");
            setMode("grid");
            setView(v);
          }}
        />
      )}

      {st && !focus && (
        <div style={navRow}>
          {viewSwitch}
          {refreshRow}
        </div>
      )}

      {mode === "scatter" && st && (
        <ClassifyScatter camera={camera} feature={feature} grid={st.settings} onGrid={changeSetting} onChanged={bump} onNotice={setNotice} onError={setError} />
      )}

      {mode === "outliers" && st && (
        <ClassifyOutliers camera={camera} feature={feature} grid={st.settings} onGrid={changeSetting} onChanged={bump} onNotice={setNotice} onError={setError} />
      )}

      {mode === "grid" && (
        <>
      {st && st.has_results && (
        <>
          {view === "Deleted" ? (
            <DeletedByDay camera={camera} feature={feature} revision={revision} settings={st.settings} onSettings={changeSetting} onChanged={bump} onNotice={setNotice} onError={setError} />
          ) : (
            <>
          {similarSeed && (
            <SimilarPanel
              camera={camera}
              feature={feature}
              seed={similarSeed}
              methods={st.methods.filter((m) => m.startsWith("resnet"))}
              classes={classes}
              onClose={() => setSimilarSeed(null)}
              onError={setError}
              onLabeled={(n, skipped, cls, counts) => {
                setNotice(`Labeled ${n} frame${n === 1 ? "" : "s"} as ${cls}.` + (skipped > 0 ? ` ${skipped} skipped (already labeled or deleted).` : ""));
                setSt((s) => (s ? { ...s, counts } : s));
                bump();
              }}
            />
          )}

          {st.scored && (
            <p>
              Bars under each picture show how close that frame is to each class's ⭐goldens under <strong>{query.rank}</strong> — longest bar = nearest
              class = the leaning. Near-equal bars (or <strong>⚠ close call</strong>) mean the machine can't separate them: those are the frames worth your
              eyes. They're a similarity advisory, not a probability.
            </p>
          )}

          {st.scored && !search && (
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

          {grid && grid.total === 0 && !search && <p>No frames match this view.</p>}
          {grid && (grid.total > 0 || search) && (
            <>
              <CardGrid
                items={grid.items}
                keyOf={(card) => card.frame}
                serverPage={grid}
                search={{ value: search, onChange: setSearch }}
                settings={st.settings}
                onSettings={changeSetting}
                page={page}
                onPage={setPage}
                renderCard={(card) => (
                  <Card
                    camera={camera}
                    feature={feature}
                    classes={classes}
                    methods={st.methods}
                    card={card}
                    busy={busy === card.frame}
                    fullSize
                    onOpen={() => setViewing(card.frame)}
                    onLabel={(cls) => act(card.frame, () => api.setLabel(camera, feature, card.frame, cls))}
                    onGolden={(on) => act(card.frame, () => api.setGolden(camera, feature, card.frame, on))}
                    onDelete={() => deleteInPlace(card.frame)}
                    onRestore={() => restoreInPlace(card.frame)}
                    onSimilar={
                      st.methods.some((m) => m.startsWith("resnet"))
                        ? () => card.label && setSimilarSeed({ frame: card.frame, label: card.label })
                        : undefined
                    }
                  />
                )}
              />
              {viewing && (
                <FrameViewer
                  camera={camera}
                  feature={feature}
                  frames={grid.items.map((c) => c.frame)}
                  start={viewing}
                  classes={classes}
                  marks={(f) => {
                    const c = grid.items.find((x) => x.frame === f);
                    return { label: c?.label ?? null, golden: c?.golden ?? null };
                  }}
                  busy={busy !== null}
                  onLabel={(f, cls) => act(f, () => api.setLabel(camera, feature, f, cls))}
                  onGolden={(f, on) => act(f, () => api.setGolden(camera, feature, f, on))}
                  onDelete={(f) => deleteInPlace(f)}
                  deleted={(f) => !!grid.items.find((x) => x.frame === f)?.deleted}
                  onRestore={(f) => restoreInPlace(f)}
                  labelsLocked={(f) => !!grid.items.find((x) => x.frame === f)?.outside}
                  lead={(f) => {
                    const c = grid.items.find((x) => x.frame === f);
                    const info = grid.search;
                    if (!c || !info) return null;
                    return (
                      <ProductRow
                        card={c}
                        search={info}
                        productRow={!!info.classify_feature && info.classify_feature !== feature}
                        busy={busy !== null}
                        onProduct={(cls) => info.classify_feature && actElsewhere(f, () => api.setLabel(camera, info.classify_feature!, f, cls))}
                      />
                    );
                  }}
                  leadCaption={(f) => {
                    const c = grid.items.find((x) => x.frame === f);
                    const info = grid.search;
                    return c && info && showsProductRow(c, info, !!info.classify_feature && info.classify_feature !== feature) ? "Feature" : null;
                  }}
                  trail={(f) => {
                    const c = grid.items.find((x) => x.frame === f);
                    if (!c || !grid.search) return null;
                    return <ShowAgain card={c} busy={busy !== null} onUnmute={() => actElsewhere(f, () => api.unmuteFrame(camera, feature, f))} />;
                  }}
                  note={(f) => {
                    const c = grid.items.find((x) => x.frame === f);
                    return c && grid.search ? <SearchNote card={c} /> : null;
                  }}
                  onClose={() => setViewing(null)}
                />
              )}
            </>
          )}
            </>
          )}
        </>
      )}
        </>
      )}
      </SidePanel>
    </section>
  );
}
