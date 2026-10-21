import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { usePublishFeature, useSharedFeature } from "../SharedFeature";
import { api, DetectionList, DetectionRow, DetectorChoice, DetectorInfo, FilterChoice, FilterSpec, MaskChoice } from "../api";
import {
  EMPTY_DETECTOR,
  FrameStrip,
  ReviewPanel,
  RunBar,
} from "../DetectorPanel";
import { lastSession } from "../lastSession";
import { countByFilter, isReviewFilter, isReviewSort, ReviewFilter, reviewRows, ReviewSort } from "../reviewList";
import PictureViewer from "../classify/PictureViewer";
import PictureSizeSlider, { usePictureSize } from "../PictureSize";
import ReviewGrid from "../ReviewGrid";
import RoiCanvas from "../RoiCanvas";
import { Box, roundBox } from "../roiGeometry";
import ShapeCanvas from "../ShapeCanvas";
import { addVertex, defaultShape, MaskShape, ShapeKind } from "../shapeGeometry";
import { useJob } from "../useJob";
import { usePreview } from "../usePreview";
import FilterParams from "./FilterParams";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const defaultsOf = (spec: FilterSpec): Record<string, number | string> =>
  Object.fromEntries(Object.entries(spec.params).map(([k, p]) => [k, p.default]));

const SHAPE_LABELS: Record<ShapeKind, string> = { rect: "Rectangle", circle: "Circle", polygon: "Polygon" };

type Tab = "filter" | "detector" | "review" | "mask";
type View = "original" | "filtered" | "masked";

const TABS: { id: Tab; label: string; purpose: string }[] = [
  { id: "filter", label: "Filter", purpose: "Clean up every frame of this feature before anything is computed (optional)." },
  { id: "detector", label: "Detector", purpose: "Show the detector what the object looks like: draw a box on the preview, then run detection." },
  { id: "review", label: "Review", purpose: "Check the boxes the detector found." },
  { id: "mask", label: "Mask", purpose: "Blank everything around the object so features describe the object only (optional)." },
];

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const chipStyle = (kind: "idle" | "ok" | "warn") => ({
  display: "inline-block",
  marginLeft: 6,
  padding: "0 7px",
  borderRadius: 9,
  fontSize: 11,
  fontWeight: 400,
  background: kind === "ok"
      ? "color-mix(in srgb, #2e9e5b 35%, var(--panel))"
      : kind === "warn"
        ? "color-mix(in srgb, #e08a00 35%, var(--panel))"
        : "var(--hover)",
  color: "var(--fg)",
});

function Overlay({ box, label }: { box: Box; label: string }) {
  return (
    <span
      data-testid="detected-overlay"
      title={label}
      style={{
        position: "absolute",
        left: `${box.x * 100}%`,
        top: `${box.y * 100}%`,
        width: `${box.w * 100}%`,
        height: `${box.h * 100}%`,
        border: "2px solid #ff3b30",
        boxSizing: "border-box",
        pointerEvents: "none",
      }}
    />
  );
}

export default function DetectorView({ camera, product }: { camera: string; product?: string }) {
  const [catalogue, setCatalogue] = useState<Record<string, FilterSpec>>({});
  const [features, setFeatures] = useState<{ feature: string; label: string }[]>([]);
  const [feature, setFeature] = useState("");
  const shared = useSharedFeature();
  usePublishFeature(feature, shared.publish);
  const [frames, setFrames] = useState<string[]>([]);
  const [frame, setFrame] = useState("");
  const [filter, setFilter] = useState<FilterChoice | null>(null);
  const [saved, setSaved] = useState<FilterChoice | null>(null);
  const [mask, setMask] = useState<MaskChoice | null>(null);
  const [savedMask, setSavedMask] = useState<MaskChoice | null>(null);
  const [detector, setDetector] = useState<DetectorChoice | null>(null);
  const [savedDetector, setSavedDetector] = useState<DetectorChoice | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [size, setSize] = usePictureSize("detector.pictureSize", 560, 200, 1600);
  const [tab, setTab] = useState<Tab>("filter");
  const [viewChoice, setView] = useState<View>("filtered");
  const [info, setInfo] = useState<DetectorInfo | null>(null);
  const [draft, setDraft] = useState<Box | null>(null);
  const [list, setList] = useState<DetectionList | null>(null);
  const [tick, setTick] = useState(0);
  const [reviewFilter, setReviewFilterState] = useState<ReviewFilter>(() => (isReviewFilter(lastSession.reviewFilter()) ? (lastSession.reviewFilter() as ReviewFilter) : "needs"));
  const [reviewSort, setReviewSortState] = useState<ReviewSort>(() => (isReviewSort(lastSession.reviewSort()) ? (lastSession.reviewSort() as ReviewSort) : "least"));
  const setReviewFilter = (f: ReviewFilter) => {
    lastSession.setReviewFilter(f);
    setReviewFilterState(f);
  };
  const setReviewSort = (v: ReviewSort) => {
    lastSession.setReviewSort(v);
    setReviewSortState(v);
  };
  const [reviewBox, setReviewBox] = useState<Box | null>(null);
  const [editing, setEditing] = useState(false); // the box editor opened over the review grid
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob<{ detected: number; needs_review: number; skipped_human: number }>(jobId);

  useEffect(() => {
    api
      .visionFilters()
      .then((r) => setCatalogue(r.filters))
      .catch((e: unknown) => setError(msg(e)));
    api
      .detectorInfo()
      .then(setInfo)
      .catch((e: unknown) => setError(msg(e)));
  }, []);

  useEffect(() => {
    if (!camera) return;
    setFeature("");
    api
      .versionFeatures(camera, product)
      .then((f) => {
        setFeatures(f);
        setFeature(shared.pick(f));
      })
      .catch((e: unknown) => setError(msg(e)));
    api
      .frames(camera, product)
      .then((r) => {
        setFrames(r.frames);
        setFrame(r.reference_frame ?? r.frames[0] ?? "");
      })
      .catch((e: unknown) => setError(msg(e)));
  }, [camera, product]);

  useEffect(() => {
    if (!camera || !feature) return;
    setList(null);
    setJobId(null);
    api
      .visionSettings(camera, feature)
      .then((s) => {
        setFilter(s.filter);
        setSaved(s.filter);
        setMask(s.mask);
        setSavedMask(s.mask);
        setDetector(s.detector);
        setSavedDetector(s.detector);
        setError(null);
      })
      .catch((e: unknown) => setError(msg(e)));
  }, [camera, feature]);

  const det = detector ?? EMPTY_DETECTOR;
  const hasExemplars = det.exemplars.length > 0;
  const jobDone = job?.status === "done";
  useEffect(() => {
    // The model is on disk after a successful run: stop asking for confirmation.
    if (jobDone) api.detectorInfo().then(setInfo).catch(() => undefined);
  }, [jobDone]);
  useEffect(() => {
    if (!camera || !feature || !hasExemplars) {
      setList(null);
      return;
    }
    api
      .detections(camera, feature, false)
      .then(setList)
      .catch((e: unknown) => setError(msg(e)));
  }, [camera, feature, hasExemplars, jobDone, tick]);

  const rows = useMemo(() => new Map((list?.frames ?? []).map((r) => [r.frame, r])), [list]);
  // The first exemplar's centre: the position sorts compare each detected box with where the object was marked.
  const exemplarBox = detector?.exemplars[0]?.box;
  const exemplarCentre = useMemo(() => (exemplarBox ? { x: exemplarBox.x + exemplarBox.w / 2, y: exemplarBox.y + exemplarBox.h / 2 } : null), [exemplarBox]);
  const queue = useMemo(() => reviewRows(list?.frames ?? [], reviewFilter, reviewSort, exemplarCentre), [list, reviewFilter, reviewSort, exemplarCentre]);
  const filterCounts = useMemo(() => countByFilter(list?.frames ?? []), [list]);

  // --- the review grid: a decision shows at once and the card stays where it is ---
  // `order` is the frames in the grid, kept stable while you decide (decided cards stay until "Remove decided", leaving the
  // step, or another filter); `overrides` are decisions shown before the server has confirmed them.
  const [order, setOrder] = useState<string[]>([]);
  const [overrides, setOverrides] = useState<Record<string, DetectionRow>>({});
  const [undoRows, setUndoRows] = useState<Record<string, DetectionRow>>({});
  const [ghosts, setGhosts] = useState<Record<string, DetectionRow>>({}); // pictures deleted from the review: kept in place, dimmed, until the list is refreshed
  const [reseed, setReseed] = useState(0);
  const seeded = useRef("");
  const pending = useRef(new Set<string>());
  const listSeq = useRef(0);
  const seedKey = `${tab}|${reviewFilter}|${reviewSort}|${feature}|${jobDone}|${reseed}`;
  useEffect(() => {
    if (tab !== "review") {
      seeded.current = ""; // coming back to the step starts from a fresh queue
      return;
    }
    if (!list || seeded.current === seedKey) return;
    seeded.current = seedKey;
    setOrder(queue.map((r) => r.frame));
    setOverrides({});
    setUndoRows({});
    setGhosts({});
  }, [tab, list, queue, seedKey]);
  const rowOf = (f: string): DetectionRow | undefined => ghosts[f] ?? overrides[f] ?? rows.get(f);
  const shownRows = useMemo(() => order.map((f) => ghosts[f] ?? overrides[f] ?? rows.get(f)).filter((r): r is DetectionRow => !!r), [order, ghosts, overrides, rows]);
  const navFrames = useMemo(() => (tab === "review" ? order : frames), [tab, order, frames]);
  const editorOpen = tab === "review" && editing && order.length > 0;
  useEffect(() => {
    if (editing && (tab !== "review" || order.length === 0)) setEditing(false); // nothing left to adjust
  }, [editing, tab, order.length]);

  // The editor and the review keys always show a frame of the grid.
  useEffect(() => {
    if (tab === "review" && order.length > 0 && !order.includes(frame)) setFrame(order[0]);
  }, [tab, order, frame]);

  const firstExemplar = detector?.exemplars[0]?.frame;
  // The mask follows the detected object, so it is drawn on the first exemplar's frame.
  useEffect(() => {
    if (tab === "mask" && firstExemplar) setFrame(firstExemplar);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  useEffect(() => setDraft(null), [frame, feature]);
  const topBox = (overrides[frame] ?? rows.get(frame))?.boxes[0];
  useEffect(() => {
    setReviewBox(topBox ? { x: topBox.x, y: topBox.y, w: topBox.w, h: topBox.h } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topBox?.x, topBox?.y, topBox?.w, topBox?.h, frame]);

  // The Masked view only exists while the mask is applied; otherwise fall back to Filtered.
  const view: View = viewChoice === "masked" && !mask?.enabled ? "filtered" : viewChoice;
  const maskOn = view === "masked" ? mask : null;
  const imageUrl = usePreview(
    camera,
    feature,
    tab === "review" && !editorOpen ? "" : frame, // the grid shows thumbnails; no preview is rendered for it
    view === "original" ? null : filter,
    maskOn,
    setError,
    view === "masked" ? detector : null,
  );

  const choose = (name: string) => setFilter(name ? { name, params: defaultsOf(catalogue[name]) } : null);
  const setShape = (shape: MaskShape | null) => setMask(shape ? { enabled: mask?.enabled ?? false, shape } : null);

  const save = (): Promise<boolean> =>
    api
      .saveVisionSettings(camera, feature, { filter, mask, detector })
      .then((s) => {
        setSaved(s.filter);
        setFilter(s.filter);
        setSavedMask(s.mask);
        setMask(s.mask);
        setSavedDetector(s.detector);
        setDetector(s.detector);
        setError(null);
        return true;
      })
      .catch((e: unknown) => {
        setError(msg(e));
        return false;
      });

  const dirtyFilter = !same(filter, saved);
  const dirtyMask = !same(mask, savedMask);
  const dirtyDetector = !same(detector, savedDetector);
  const dirty = dirtyFilter || dirtyMask || dirtyDetector;
  const revert = () => {
    setFilter(saved);
    setMask(savedMask);
    setDetector(savedDetector);
  };

  const running = job?.status === "queued" || job?.status === "running";
  const run = async (acceptDownload = false) => {
    if (dirty && !(await save())) return;
    try {
      setJobId((await api.detect(camera, feature, acceptDownload)).id);
    } catch (e) {
      setError(msg(e));
    }
  };

  const addExemplar = () => {
    if (!draft || draft.w <= 0 || draft.h <= 0) return;
    setDetector({ ...det, exemplars: [...det.exemplars, { frame, box: roundBox(draft) }] });
    setDraft(null);
  };

  const step = (d: number) => {
    const i = navFrames.indexOf(frame);
    const n = navFrames[Math.min(navFrames.length - 1, Math.max(0, (i < 0 ? 0 : i) + d))];
    if (n) setFrame(n);
  };

  // A decision shows at once; the save runs in the background and is undone on screen if it fails.
  const refreshList = () => {
    const seq = ++listSeq.current;
    api
      .detections(camera, feature, false)
      .then((l) => {
        if (seq !== listSeq.current) return; // a newer answer is on its way
        setList(l);
        setOverrides((o) => Object.fromEntries(Object.entries(o).filter(([f]) => pending.current.has(f))));
      })
      .catch((e: unknown) => setError(msg(e)));
  };
  const decision = (f: string, next: DetectionRow, call: () => Promise<unknown>, keepUndo = true) => {
    const before = rowOf(f);
    if (before && keepUndo) setUndoRows((u) => ({ ...u, [f]: before }));
    setOverrides((o) => ({ ...o, [f]: next }));
    pending.current.add(f);
    call()
      .then(() => {
        pending.current.delete(f);
        refreshList();
      })
      .catch((e: unknown) => {
        pending.current.delete(f);
        setOverrides((o) => {
          const n = { ...o };
          if (before) n[f] = before;
          else delete n[f];
          return n;
        });
        setError(msg(e));
      });
  };
  const acceptRow = (f: string) => {
    const row = rowOf(f);
    const b = row?.boxes[0];
    if (!row || !b || row.state === "human") return;
    decision(f, { ...row, state: "human", status: "reviewed", boxes: [b] }, () =>
      api.putDetection(camera, feature, f, roundBox({ x: b.x, y: b.y, w: b.w, h: b.h }), "reviewed"),
    );
  };
  const clearRow = (f: string) => {
    const row = rowOf(f);
    if (!row?.boxes[0]) return;
    decision(f, { ...row, state: "none", status: null, boxes: [] }, () => api.deleteDetection(camera, feature, f));
  };
  // Deleting a picture is the same soft delete as on every page; the card stays, dimmed, and undo brings the picture back.
  const deleteRow = (f: string) => {
    const row = rowOf(f);
    if (!row || row.deleted) return;
    setGhosts((g) => ({ ...g, [f]: { ...row, deleted: true } }));
    api
      .deleteFrame(camera, feature, f, "Detector")
      .then(() => refreshList())
      .catch((e: unknown) => {
        setGhosts((g) => {
          const n = { ...g };
          delete n[f];
          return n;
        });
        setError(msg(e));
      });
  };
  const undoRow = (f: string) => {
    const gone = ghosts[f];
    if (gone) {
      setGhosts((g) => {
        const n = { ...g };
        delete n[f];
        return n;
      });
      api
        .restoreFrame(camera, feature, f)
        .then(() => refreshList())
        .catch((e: unknown) => {
          setGhosts((g) => ({ ...g, [f]: gone }));
          setError(msg(e));
        });
      return;
    }
    const prev = undoRows[f];
    if (!prev) return;
    setUndoRows((u) => {
      const n = { ...u };
      delete n[f];
      return n;
    });
    decision(
      f,
      prev,
      () => api.restoreDetection(camera, feature, f, prev.boxes.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, conf: b.conf, status: prev.status ?? "auto" }))),
      false,
    );
  };
  const adjust = (f: string) => {
    setFrame(f);
    setEditing(true);
  };
  // In the editor: the box on screen (possibly adjusted) is what is accepted; then on to the next card.
  const advance = () => {
    const next = order[order.indexOf(frame) + 1];
    if (next) setFrame(next);
  };
  const acceptEditor = () => {
    const row = rowOf(frame);
    if (!row || !reviewBox) return;
    const box = roundBox(reviewBox);
    decision(frame, { ...row, state: "human", status: "reviewed", boxes: [{ ...box, conf: row.boxes[0]?.conf ?? 1 }] }, () => api.putDetection(camera, feature, frame, box, "reviewed"));
    advance();
  };
  const clearEditor = () => {
    clearRow(frame);
    advance();
  };
  const deleteEditor = () => {
    deleteRow(frame);
    advance();
  };
  const editorKey = (e: KeyboardEvent): boolean => {
    const key = e.key.toLowerCase();
    if (e.repeat) return key === "enter" || key === "a" || key === "delete" || key === "x" || key === "z";
    if (key === "enter" || key === "a") acceptEditor();
    else if (key === "x") clearEditor();
    else if (key === "delete") deleteEditor();
    else if (key === "z") undoRow(frame);
    else return false;
    return true;
  };

  const spec = filter ? catalogue[filter.name] : undefined;
  const counts = list?.counts ?? {};
  const toCheck = (counts.review ?? 0) + (counts.none ?? 0);
  const detected = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0) > 0;
  const chips: Record<Tab, [string, "idle" | "ok" | "warn"]> = {
    filter: !filter ? ["not set", "idle"] : dirtyFilter ? ["unsaved", "warn"] : ["saved", "ok"],
    detector: !hasExemplars
      ? ["not set", "idle"]
      : dirtyDetector
        ? ["unsaved", "warn"]
        : [`${det.exemplars.length} exemplar${det.exemplars.length === 1 ? "" : "s"}`, "ok"],
    review: !hasExemplars || !detected ? ["not run", "idle"] : toCheck > 0 ? [`${toCheck} to review`, "warn"] : ["all clear", "ok"],
    mask: !mask ? ["not set", "idle"] : dirtyMask ? ["unsaved", "warn"] : [mask.enabled ? "on" : "off", mask.enabled ? "ok" : "idle"],
  };

  if (!camera) return <p>Select a camera.</p>;

  const detectedBox = rows.get(frame)?.boxes[0];
  const exemplarOutlines = det.exemplars.filter((e) => e.frame === frame).map((e) => ({ name: "exemplar", box: e.box }));
  const pickerFrames = tab === "review" ? queue.map((r) => r.frame) : frames;
  const position = pickerFrames.indexOf(frame);
  const caption = { fontSize: 11, color: "var(--muted)" } as const;
  const framePicker = (
    <label style={{ display: "flex", flexDirection: "column", flex: "1 1 0", minWidth: 0 }}>
      <span style={caption}>
        {tab === "review" ? "Frame" : "Preview frame"}
        {position >= 0 ? ` · ${position + 1} / ${pickerFrames.length}` : ""}
      </span>
      <select
        value={frame}
        title={frame}
        onChange={(e) => setFrame(e.target.value)}
        style={{ width: "100%", minWidth: 0, textOverflow: "ellipsis" }}
      >
        {tab === "review"
          ? queue.map((f) => (
              <option key={f.frame} value={f.frame}>
                {f.frame} — {f.state === "none" ? "no detection" : `${Math.round((f.boxes[0]?.conf ?? 0) * 100)}%`}
                {f.state === "human" ? " (decided)" : ""}
              </option>
            ))
          : frames.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
      </select>
    </label>
  );
  const maskAvailable = !!mask?.enabled;
  const viewSwitch = (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <span style={caption}>Show</span>
      <span
        role="group"
        aria-label="View"
        style={{ display: "inline-flex", border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden" }}
      >
        {(["original", "filtered", "masked"] as View[]).map((v) => {
          const disabled = v === "masked" && !maskAvailable;
          const on = view === v;
          return (
            <button
              key={v}
              aria-pressed={on}
              disabled={disabled}
              title={disabled ? "Turn on “Apply mask” in the Mask tab first" : undefined}
              onClick={() => setView(v)}
              style={{
                border: 0,
                borderRadius: 0,
                padding: "4px 10px",
                background: on ? "var(--accent)" : "var(--panel)",
                color: on ? "var(--accent-fg)" : "var(--fg)",
                opacity: disabled ? 0.45 : 1,
                fontWeight: on ? 600 : 400,
              }}
            >
              {v[0].toUpperCase() + v.slice(1)}
            </button>
          );
        })}
      </span>
    </div>
  );

  const reviewTool = (width: number): ReactNode =>
    !imageUrl ? (
      <p>Loading preview…</p>
    ) : (
      <RoiCanvas imageUrl={imageUrl} mode={reviewBox ? "edit" : "draw"} box={reviewBox} onChange={setReviewBox} width={width} />
    );

  let tool: ReactNode;
  if (!imageUrl) tool = <p>Loading preview…</p>;
  else if (view === "masked")
    tool = <img src={imageUrl} alt="Masked preview" style={{ width: size, maxWidth: "100%" }} />;
  else if (tab === "filter")
    tool = (
      <div style={{ position: "relative", width: size, lineHeight: 0, maxWidth: "100%" }}>
        <img
          src={imageUrl}
          alt={view === "original" ? "Original preview" : "Filtered preview"}
          style={{ width: "100%", display: "block" }}
        />
        {detectedBox && <Overlay box={detectedBox} label="Detected object" />}
      </div>
    );
  else if (tab === "detector")
    tool = (
      <RoiCanvas
        imageUrl={imageUrl}
        mode={draft ? "edit" : "draw"}
        box={draft}
        onChange={setDraft}
        others={[...exemplarOutlines, ...(detectedBox ? [{ name: "detected", box: detectedBox }] : [])]}
        width={size}
      />
    );
  else tool = <ShapeCanvas imageUrl={imageUrl} shape={mask?.shape ?? null} onChange={setShape} width={size} />;

  const runBar = (
    <RunBar
      det={det}
      onDetector={setDetector}
      info={info}
      dirty={dirty}
      onRun={run}
      run={{
        running,
        progress: job?.progress as { done?: number; total?: number; phase?: string } | undefined,
        result: job?.status === "done" ? job.result : null,
        error: job?.status === "error" ? job.error : null,
      }}
      onGoReview={() => setTab("review")}
    />
  );
  const tabInfo = TABS.find((t) => t.id === tab)!;

  return (
    <section>
      <h2>
        Detector — {camera}
        {product ? ` › ${product}` : ""}
      </h2>
      {error && <p role="alert">{error}</p>}

      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 5,
          background: "var(--bg)",
          padding: "6px 0",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
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
        <span style={{ flex: 1 }} />
        {dirty && <em>Unsaved changes — saving makes cached scores for this feature recompute.</em>}
        <button onClick={save} disabled={!dirty || !feature}>
          Save settings
        </button>
        <button onClick={revert} disabled={!dirty}>
          Revert
        </button>
      </div>

      <div role="tablist" aria-label="Detector steps" style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 10 }}>
        {TABS.map((t, i) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={(e) => {
              e.currentTarget.blur(); // keep Enter/arrow shortcuts working right after switching
              setTab(t.id);
            }}
            style={{
              padding: "6px 12px",
              border: "1px solid var(--border)",
              borderBottom: tab === t.id ? "3px solid var(--accent)" : "1px solid var(--border)",
              color: "var(--fg)",
              background: tab === t.id ? "var(--info-bg)" : "var(--panel)",
              fontWeight: tab === t.id ? 600 : 400,
              cursor: "pointer",
            }}
          >
            {i + 1}. {t.label}
            <span style={chipStyle(chips[t.id][1])}>{chips[t.id][0]}</span>
          </button>
        ))}
      </div>
      <p style={{ margin: "6px 0" }}>{tabInfo.purpose}</p>

      {tab !== "review" && (
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end", margin: "6px 0 10px" }}>
        <div
          role="group"
          aria-label="Frame navigation"
          style={{ display: "flex", gap: 6, alignItems: "flex-end", flex: "1 1 360px", minWidth: 0, maxWidth: 640 }}
        >
          <button onClick={() => step(-1)} aria-label="Previous frame">
            ←
          </button>
          {framePicker}
          <button onClick={() => step(1)} aria-label="Next frame">
            →
          </button>
        </div>
        {viewSwitch}
        <PictureSizeSlider value={size} onChange={setSize} min={200} max={1600} />
      </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
        {tab !== "review" && (
        <div role="group" aria-label="Preview" style={{ position: "sticky", top: 52, width: size, maxWidth: "100%", minWidth: 0 }}>
          {view === "masked" && tab !== "filter" && (
            <p style={{ margin: "4px 0" }}>
              <em>Result preview — switch to Original or Filtered to edit on the image.</em>
            </p>
          )}
          {tool}
          <FrameStrip
            camera={camera}
            feature={feature}
            frames={navFrames}
            current={frame}
            rows={rows}
            onPick={setFrame}
          />
        </div>
        )}

        <div role="tabpanel" aria-label={`${tabInfo.label} step`} style={{ flex: "1 1 320px", minWidth: 0, overflowWrap: "anywhere" }}>
          {tab === "filter" && (
            <>
              <p>Applied identically to every frame of this feature. Saved per feature.</p>
              <label>
                Filter{" "}
                <select value={filter?.name ?? ""} onChange={(e) => choose(e.target.value)}>
                  <option value="">None</option>
                  {Object.entries(catalogue).map(([name, s]) => (
                    <option key={name} value={name}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
              {filter && spec && <FilterParams spec={spec} params={filter.params} onChange={(key, value) => setFilter({ ...filter, params: { ...filter.params, [key]: value } })} />}
            </>
          )}

          {tab === "detector" && (
            <>
              <p>
                Mark the object on up to {info?.max_exemplars ?? 3} frames (vary lighting and screw lean). The
                detector looks for similar objects in every frame. Detection is a suggestion: boxes below the
                confidence threshold wait for your review.
              </p>
              {info && !info.available && det.method === "model" && (
                <p role="alert">
                  Detector dependencies are missing. Install them with{" "}
                  <code>pip install -r requirements-detector.txt</code> ({info.model}, downloaded once).
                </p>
              )}
              <ul aria-label="Exemplars">
                {det.exemplars.map((ex, i) => (
                  <li key={i}>
                    {ex.frame}{" "}
                    <button
                      onClick={() => setDetector({ ...det, exemplars: det.exemplars.filter((_, j) => j !== i) })}
                      aria-label={`Remove exemplar ${i + 1}`}
                    >
                      Remove
                    </button>
                  </li>
                ))}
                {!hasExemplars && <li>No exemplars yet.</li>}
              </ul>
              {det.exemplars.length < (info?.max_exemplars ?? 3) ? (
                <p>
                  Draw a box around the object on {frame || "the preview"}, then{" "}
                  <button onClick={addExemplar} disabled={!draft}>
                    Add exemplar
                  </button>
                </p>
              ) : (
                <p>Exemplar limit reached — remove one to add another.</p>
              )}
              {runBar}
            </>
          )}

          {tab === "review" && (
            <>
              <ReviewPanel list={list} counts={filterCounts} filter={reviewFilter} onFilter={setReviewFilter} sort={reviewSort} onSort={setReviewSort} shown={shownRows.length}>
                {runBar}
              </ReviewPanel>
              {order.length > 0 && (
                <ReviewGrid
                  camera={camera}
                  feature={feature}
                  rows={shownRows}
                  canUndo={(f) => !!undoRows[f] || !!ghosts[f]}
                  onAccept={acceptRow}
                  onClear={clearRow}
                  onDelete={deleteRow}
                  onUndo={undoRow}
                  onAdjust={adjust}
                  onRemoveDecided={() => setReseed((n) => n + 1)}
                  onGridChange={() => {
                    // Turning the grid drops the pictures deleted in place; decided cards stay until "Remove decided".
                    setOrder((o) => o.filter((f) => !ghosts[f]));
                    setGhosts({});
                  }}
                />
              )}
            </>
          )}

          {tab === "mask" && (
            <>
              <p>
                Everything outside the shape is blanked to dark grey before features and embeddings are
                computed. Shape coordinates are relative to the ROI crop.
              </p>
              <label>
                Shape{" "}
                <select
                  value={mask?.shape.shape ?? ""}
                  onChange={(e) => setShape(e.target.value ? defaultShape(e.target.value as ShapeKind) : null)}
                >
                  <option value="">None</option>
                  {(Object.keys(SHAPE_LABELS) as ShapeKind[]).map((k) => (
                    <option key={k} value={k}>
                      {SHAPE_LABELS[k]}
                    </option>
                  ))}
                </select>
              </label>{" "}
              {mask?.shape.shape === "polygon" && (
                <button onClick={() => setShape(addVertex(mask.shape))}>Add point</button>
              )}
              {mask && (
                <p>
                  <label>
                    <input
                      type="checkbox"
                      checked={mask.enabled}
                      onChange={(e) => setMask({ ...mask, enabled: e.target.checked })}
                    />{" "}
                    Apply mask to Classify, Dedup and suggestions
                  </label>
                </p>
              )}
              {firstExemplar ? (
                <p>
                  The mask follows the detected object: draw it on the first exemplar's frame ({firstExemplar});
                  it is shifted to each frame's detected position.{" "}
                  {frame !== firstExemplar && <button onClick={() => setFrame(firstExemplar)}>Show that frame</button>}
                </p>
              ) : (
                <p>Without exemplars the mask stays at the same place in every frame.</p>
              )}
            </>
          )}
        </div>
      </div>
      {editorOpen && (
        <PictureViewer
          label="Adjust detection"
          testId="box-editor"
          name={frame}
          index={Math.max(0, order.indexOf(frame))}
          total={order.length}
          onGo={(i) => order[i] && setFrame(order[i])}
          onClose={() => setEditing(false)}
          onKey={editorKey}
          hint="Drag the box to move it, drag a corner to resize it, or draw a new one · Enter or A accepts and moves on · X clears the box · Delete deletes the picture · Z undoes · ← → browse · Esc closes"
          toolbar={
            <div role="group" aria-label="Decide" style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <button aria-label="Accept box" disabled={!reviewBox} onClick={acceptEditor} title="Accept the box (Enter or A)">
                ✓
              </button>
              <button aria-label="Clear box" disabled={!rowOf(frame)?.boxes[0]} onClick={clearEditor} title="Clear the box (X)">
                ✕
              </button>
              <button aria-label="Delete picture" onClick={deleteEditor} title="Delete the picture (Delete)">
                🗑
              </button>
              {(undoRows[frame] || ghosts[frame]) && (
                <button aria-label="Undo" onClick={() => undoRow(frame)} title="Undo the last decision on this frame (Z)">
                  ↶
                </button>
              )}
            </div>
          }
        >
          {reviewTool}
        </PictureViewer>
      )}
    </section>
  );
}