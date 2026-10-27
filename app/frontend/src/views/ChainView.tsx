import "@xyflow/react/dist/style.css";
import {
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ChainCanvas, ChainDeletePreview, ChainEdge, ChainNode, ChainViewport, FlowDeletePreview } from "../api";
import { ALL_HANDLE, INGEST_ID, targetHandle, targetOfHandle, connectAction, describeNode, disconnectAction, exportLineOf, flowConnect, freshName, isAnchorEdge, isDedupInputEdge, isDedupSourceEdge, isExportLineEdge, isRoiInputEdge, isFlowKind, layoutOf, productHandle } from "../chain/chainModel";
import ClassifierMode from "../chain/ClassifierMode";
import LineConfirm from "../chain/LineConfirm";
import Palette, { PALETTE_DRAG } from "../chain/Palette";
import { BOX_SIZE, HUE, dropPosition, freeSpot, paletteItem, type PaletteKind } from "../chain/palette";
import StepIcons from "../chain/StepIcons";
import { deleteNote, disconnectError, replaceNote, scopeNote, type LineNote } from "../chain/lineEffects";
import { useSharedFeature } from "../SharedFeature";
import SidePanel from "../SidePanel";

type BoxData = {
  node: ChainNode;
  onRename: (id: string, label: string) => void;
};
type BoxNode = Node<BoxData, "box">;

const hueOf = (n: ChainNode) => HUE[n.kind];

/** A box of the chain: a rounded two-tone rectangle. Double-click opens its page; it is renamed in the right panel. */
function Box({ data, selected }: NodeProps<BoxNode>) {
  const { node } = data;
  const isClassifier = node.kind === "roi";
  const productMode = node.role === "classify";
  const isEdits = node.kind === "crop"; // a Picture edits box has one fixed size and shows icons, not its step list
  return (
    <div
      className={`chain-node chain-node-${node.kind}${isEdits ? " chain-node-fixed" : ""}${selected ? " selected" : ""}`}
      title={isEdits ? describeNode(node) : undefined}
      style={{ ["--hue" as string]: hueOf(node) }}
      data-testid={`chain-node-${node.id}`}
    >
      {node.kind !== "ingest" && node.kind !== "export" && <Handle type="target" position={Position.Left} />}
      <div className="chain-node-title">{node.label}</div>
      {node.kind === "export" ? (
        <>
          {/* Two inputs, like a Classifier has one dot per class: the OK and the NG folder. */}
          {(["ok", "ng"] as const).map((where) => (
            <div className="chain-node-product chain-node-in" key={where} title={`${where.toUpperCase()} input: ${node.flow?.lines?.[where] ?? 0} line(s). Drop a Classifier or Evaluation dot, or a box, here.`}>
              <Handle type="target" position={Position.Left} id={`in:${where}`} isConnectable />
              <span className="chain-node-class">{where.toUpperCase()}</span>
              <span className="chain-node-count">{node.flow?.[where] ?? 0}</span>
            </div>
          ))}
          <div className="chain-node-counters" aria-label="Counters" title={describeNode(node)}>
            <span title="Pictures that would be exported">▦ {node.flow?.total ?? 0}</span>
            <span title="Left out: reach both OK and NG">⇄ {node.flow?.both ?? 0}</span>
            <span title="Last freeze">{node.flow?.frozen ? `❄ v${node.flow.frozen}${node.flow.changed ? " ≠" : ""}` : "❄ –"}</span>
          </div>
        </>
      ) : node.kind === "dedup" ? (
        <div className="chain-node-counters" aria-label="Counters" title={describeNode(node)}>
          <span title="Pictures it sees">▦ {node.flow?.frames ?? 0}</span>
          <span title="Muted by this box">🔇 {node.flow?.muted ?? 0}</span>
          <span title="In the bin (deleted)">🗑 {node.flow?.deleted ?? 0}</span>
        </div>
      ) : node.kind === "detector" ? (
        <>
        <div className="chain-node-sub chain-node-line" title={describeNode(node)}>{describeNode(node)}</div>
        <div className="chain-node-counters" aria-label="Counters" title={describeNode(node)}>
          <span title={node.flow?.area === "edited" ? "Searches the picture a Picture edits box cut" : "Searches the whole picture"}>{node.flow?.area === "edited" ? "▭" : "🖼"}</span>
          <span title="Pictures it works on">▦ {node.flow?.in_scope ?? 0}</span>
          <span title="Pictures where every target was found">✓ {node.flow?.complete ?? 0}</span>
          <span title="Pictures to look at: a target has no box">⚠ {node.flow?.review ?? 0}</span>
        </div>
        </>
      ) : node.kind === "evaluation" ? (
        <div className="chain-node-counters" aria-label="Counters" title={describeNode(node)}>
          <span title="Pass">✔ {node.flow?.counts?.pass ?? 0}</span>
          <span title="Fail">✖ {node.flow?.counts?.fail ?? 0}</span>
          <span title="No value to judge">? {node.flow?.counts?.undetermined ?? 0}</span>
        </div>
      ) : isEdits ? <StepIcons steps={node.flow?.steps} /> : <div className="chain-node-sub chain-node-line" title={describeNode(node)}>{describeNode(node)}</div>}
      {isClassifier && (
        <>
          {/* One row and one dot per class; the "all" dot passes every classified picture and never an unlabeled one. */}
          {node.classes.map((cls) => (
            <div className="chain-node-product" key={cls} title={`${cls}: ${node.product_counts[cls] ?? 0} pictures`}>
              <span className="chain-node-class">{cls}</span>
              <span className="chain-node-count">{node.product_counts[cls] ?? 0}</span>
              <Handle type="source" position={Position.Right} id={productHandle(cls)} isConnectable />
            </div>
          ))}
          <div className="chain-node-product chain-node-all" title="All classified pictures (no unlabeled one)">
            <span className="chain-node-class">all</span>
            <span className="chain-node-count">{node.labeled}</span>
            <Handle type="source" position={Position.Right} id={ALL_HANDLE} isConnectable />
          </div>
          <div className="chain-node-counters" aria-label="Counters">
            <span title="Labeled pictures">● {node.labeled}</span>
            <span title="Not labeled yet">○ {node.unlabeled}</span>
            <span title="In the bin (deleted)">🗑 {node.deleted ?? 0}</span>
          </div>
        </>
      )}
      {node.kind === "evaluation" && (
        <>
          {/* One dot per verdict, as a Classifier has one per class; "all" passes every judged picture and never one it could not judge. */}
          {(["pass", "fail"] as const).map((verdict) => (
            <div className="chain-node-product" key={verdict} title={`${verdict}: ${node.flow?.counts?.[verdict] ?? 0} pictures. Drag this dot onto a Dedup box, Picture edits or a detector.`}>
              <span className="chain-node-class">{verdict}</span>
              <span className="chain-node-count">{node.flow?.counts?.[verdict] ?? 0}</span>
              <Handle type="source" position={Position.Right} id={productHandle(verdict)} isConnectable />
            </div>
          ))}
          <div className="chain-node-product chain-node-all" title="Every judged picture (pass and fail, never one that could not be judged)">
            <span className="chain-node-class">all</span>
            <span className="chain-node-count">{(node.flow?.counts?.pass ?? 0) + (node.flow?.counts?.fail ?? 0)}</span>
            <Handle type="source" position={Position.Right} id={ALL_HANDLE} isConnectable />
          </div>
        </>
      )}
      {node.kind === "detector" &&
        (node.flow?.groups ?? []).map((group) => (
          <div className="chain-node-product chain-node-target" key={`group:${group}`} title={`Drag this dot onto a Classifier: every box found for ${group} becomes its own picture there (name · box 1, 2, …)`}>
            {group} (all)
            <Handle type="source" position={Position.Right} id={targetHandle(group)} />
          </div>
        ))}
      {node.kind === "detector" &&
        (node.flow?.targets ?? []).map((target) => (
          <div className="chain-node-product chain-node-target" key={target} title={`Drag this dot onto a Classifier (it reads the box found for ${target}), a Dedup box, a Picture edits box or Calculate (a point)`}>
            {target}
            <Handle type="source" position={Position.Right} id={targetHandle(target)} />
          </div>
        ))}
      {!isClassifier && node.kind !== "evaluation" && <Handle type="source" position={Position.Right} style={node.kind === "detector" ? { top: 16 } : undefined} />}
    </div>
  );
}

const nodeTypes = { box: Box };
/** How far (px) from an anchor point a dragged arrow still snaps to it. */
const CONNECT_RADIUS = 40;
const FLOW_PAGE = { crop: "Picture edits", detector: "Detector", calc: "Calculate", evaluation: "Evaluation", dedup: "Dedup", export: "Export" } as const;

function toFlowNode(n: ChainNode, onRename: BoxData["onRename"], selected: boolean): BoxNode {
  return { id: n.id, type: "box", position: { x: n.x, y: n.y }, data: { node: n, onRename }, selected, deletable: n.kind === "roi" || isFlowKind(n.kind) };
}

export function toFlowEdge(e: ChainCanvas["edges"][number]): Edge {
  return {
    id: e.id,
    source: e.source,
    sourceHandle: e.source_handle,
    target: e.target,
    targetHandle: e.target_handle ?? undefined,
    type: "smoothstep",
    deletable: !e.locked,
    className: e.locked ? "chain-edge-locked" : undefined,
  };
}

/** The Dedup box that has a line into this Classifier, if any. */
const dedupInputOf = (canvas: ChainCanvas | null, id: string): string | null =>
  canvas?.edges.find((e) => e.target === id && canvas.nodes.find((n) => n.id === e.source)?.kind === "dedup")?.source ?? null;

type OpenRoi = (feature: string, view: "roi" | "classify") => void;

function Canvas({ camera, onOpenRoi, onOpenFlow }: { camera: string; onOpenRoi?: OpenRoi; onOpenFlow?: (id: string) => void }) {
  const navigate = useNavigate();
  const shared = useSharedFeature();
  const [canvas, setCanvas] = useState<ChainCanvas | null>(null);
  const [nodes, setNodes] = useState<BoxNode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [preview, setPreview] = useState<ChainDeletePreview | null>(null);
  const [flowPreview, setFlowPreview] = useState<FlowDeletePreview | null>(null);
  // A line change waiting for Enter (do it) or Esc (leave everything as it is).
  const [lineDialog, setLineDialog] = useState<{ notes: LineNote[]; confirmLabel: string; run: () => void } | null>(null);
  const flowView = useReactFlow();
  const pane = useRef<HTMLDivElement | null>(null);
  // Where the product-sorting ROI goes once its names are typed (the tile was dropped or clicked before the form).
  const viewport = useRef<ChainViewport | null>(null);
  const nodesRef = useRef<BoxNode[]>([]);
  nodesRef.current = nodes;

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const saveLayout = useCallback(
    (list: BoxNode[]) => {
      const layout = layoutOf(
        list.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y, label: n.data.node.label })),
        viewport.current,
      );
      api.saveChainLayout(camera, layout).catch(fail);
    },
    [camera],
  );

  const rename = useCallback(
    (id: string, label: string) => {
      const next = nodesRef.current.map((n) => (n.id === id ? { ...n, data: { ...n.data, node: { ...n.data.node, label } } } : n));
      setNodes(next);
      saveLayout(next);
    },
    [saveLayout],
  );

  const show = useCallback(
    (c: ChainCanvas) => {
      setCanvas(c);
      viewport.current = c.viewport;
      setNodes(c.nodes.map((n) => toFlowNode(n, rename, false)));
    },
    [rename],
  );

  const reload = useCallback(() => api.chain(camera).then(show).catch(fail), [camera, show]);

  useEffect(() => {
    setCanvas(null);
    setSelectedId(null);
    setPreview(null);
    setFlowPreview(null);
    setError(null);
    api.chain(camera).then(show).catch(fail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera]);

  const edges = useMemo(() => canvas?.edges.map((e) => ({ ...toFlowEdge(e), selected: e.id === selectedEdgeId })) ?? [], [canvas, selectedEdgeId]);
  const shownNodes = useMemo(() => nodes.map((n) => ({ ...n, selected: n.id === selectedId })), [nodes, selectedId]);
  const selected = canvas?.nodes.find((n) => n.id === selectedId) ?? null;
  const selectedLive = selected ? (nodes.find((n) => n.id === selected.id)?.data.node ?? selected) : null;

  const apply = async (result: ReturnType<typeof connectAction>) => {
    if ("error" in result) {
      setError(result.error);
    } else {
      setError(null);
      try {
        if (result.detach) await api.setChainDetached(camera, result.feature, true);
        else if (result.attach) await api.setChainDetached(camera, result.feature, false);
        else await api.setRoiProducts(camera, result.feature, result.products);
      } catch (e) {
        fail(e);
      }
    }
    await reload();
  };

  const applyFlow = async (action: () => Promise<unknown>) => {
    try {
      await action();
      setError(null);
    } catch (e) {
      fail(e);
    }
    await reload();
  };

  const onConnect = (c: Connection) => {
    if (!canvas) return;
    const link = { source: c.source, sourceHandle: c.sourceHandle, target: c.target, targetHandle: c.targetHandle };
    const flowArrow = flowConnect(canvas, link);
    const target = canvas.nodes.find((n) => n.id === c.target);
    let run: () => void;
    let note: LineNote | null = null;
    if (flowArrow === null) {
      run = () => void apply(connectAction(canvas, link));
      note = scopeNote(canvas, link);
    } else if ("error" in flowArrow) {
      setError(flowArrow.error);
      return;
    } else if ("exportLine" in flowArrow) {
      const a = flowArrow.exportLine; // a dot or box dropped on the OK or NG input of an Export box: one more line into it
      run = () => void applyFlow(() => api.flowUpdate(camera, a.box, { add_line: { input: a.input, ref: a.ref } }));
    } else if ("dedupSource" in flowArrow) {
      const a = flowArrow.dedupSource; // a Classifier or Evaluation dot dropped on a Dedup, Picture edits or detector box: the box reads only the pictures on that dot
      run = () => void applyFlow(() => api.flowUpdate(camera, a.box, { source: a.evaluation ? { box: a.evaluation, dot: a.dot } : { feature: a.feature, dot: a.dot } }));
      note = replaceNote(canvas, link, flowArrow);
    } else if ("dedupInput" in flowArrow) {
      const a = flowArrow.dedupInput; // a Dedup box dropped on a Classifier: the Classifier hides what the box muted
      run = () => void applyFlow(() => api.setChainDedup(camera, a.feature, a.box));
      note = replaceNote(canvas, link, flowArrow);
    } else if ("roiInput" in flowArrow) {
      const a = flowArrow.roiInput; // a Picture edits box dropped on an ROI: the ROI is cut from that box's picture
      // An ROI is anchored or reads a box, never both: a taken input is cleared first, after the confirmation.
      run = () => void applyFlow(async () => {
        if (target?.anchor) await api.clearRoiAnchor(camera, a.feature);
        await api.setRoiInput(camera, a.feature, a.box);
      });
      note = replaceNote(canvas, link, flowArrow);
    } else if ("anchor" in flowArrow) {
      const a = flowArrow.anchor; // the dot of a detector target dropped on an ROI: the ROI becomes that box
      run = () => void applyFlow(async () => {
        if (target?.input) await api.clearRoiInput(camera, a.feature);
        await api.setRoiAnchor(camera, a.feature, { detector: a.detector, target: a.target, mode: "box" });
      });
      note = replaceNote(canvas, link, flowArrow);
    } else {
      run = () => void applyFlow(() => api.flowConnect(camera, flowArrow.source, flowArrow.target, flowArrow.point));
      note = replaceNote(canvas, link, flowArrow);
    }
    // An output feeds any number of boxes. Only a taken single-source input asks first; Cancel leaves the old line alone.
    if (note) setLineDialog({ notes: [note], confirmLabel: "Replace", run });
    else run();
  };

  /** Removes one line, whatever it stands for (an ROI's input or anchor, a product line, a flow line). */
  const removeEdge = (edge: ChainEdge) => {
    if (!canvas) return;
    const targetNode = canvas.nodes.find((n) => n.id === edge.target);
    const ends = [edge.source, edge.target].map((id) => canvas.nodes.find((n) => n.id === id)?.kind);
    if (isExportLineEdge(canvas, edge)) {
      const line = exportLineOf(canvas, edge);
      if (line) void applyFlow(() => api.flowUpdate(camera, edge.target, { remove_line: line }));
    } else if (isDedupSourceEdge(canvas, edge)) void applyFlow(() => api.flowUpdate(camera, edge.target, { source: null }));
    else if (isDedupInputEdge(canvas, edge)) void applyFlow(() => api.setChainDedup(camera, targetNode!.ref!, null));
    else if (isRoiInputEdge(canvas, edge)) void api.clearRoiInput(camera, targetNode!.ref!).then(() => reload()).catch(fail);
    else if (isAnchorEdge(canvas, edge)) void api.clearRoiAnchor(camera, targetNode!.ref!).then(() => reload()).catch(fail);
    else if (ends.some((k) => isFlowKind(k))) void applyFlow(() => api.flowDisconnect(camera, edge.source, edge.target, targetOfHandle(edge.source_handle) ?? undefined));
    else void apply(disconnectAction(canvas, edge));
  };

  /** Delete pressed on selected lines: say what changes first. Nothing is removed until Enter. */
  const requestLineDelete = (gone: Edge[]) => {
    if (!canvas) return;
    const edges = gone.map((e) => canvas.edges.find((x) => x.id === e.id)).filter((e): e is ChainEdge => !!e && !e.locked);
    const blocked = edges.map((e) => disconnectError(canvas, e)).find((r) => r);
    if (blocked) {
      setError(blocked);
      return;
    }
    const notes = edges.map((e) => deleteNote(canvas, e)).filter((n): n is LineNote => !!n);
    if (!notes.length) return;
    setError(null);
    setLineDialog({
      notes,
      confirmLabel: notes.length > 1 ? `Delete ${notes.length} lines` : "Delete line",
      run: () => {
        setSelectedEdgeId(null);
        for (const e of edges) removeEdge(e);
      },
    });
  };

  const isValidConnection = (c: Connection | Edge) => {
    if (!canvas) return false;
    const link = { source: c.source, sourceHandle: c.sourceHandle ?? null, target: c.target, targetHandle: c.targetHandle ?? null };
    const flowArrow = flowConnect(canvas, link);
    return flowArrow === null ? !("error" in connectAction(canvas, link)) : !("error" in flowArrow);
  };

  const requestDelete = (id: string) => {
    const node = canvas?.nodes.find((n) => n.id === id);
    if (node && isFlowKind(node.kind)) {
      setSelectedId(id);
      setPreview(null);
      api.flowDeletePreview(camera, id).then(setFlowPreview).catch(fail);
      return;
    }
    if (node?.kind !== "roi" || !node.ref) return;
    setSelectedId(id);
    api.chainDeletePreview(camera, node.ref).then(setPreview).catch(fail);
  };

  const confirmDelete = async () => {
    if (!preview) return;
    try {
      await api.deleteRoi(camera, preview.feature);
    } catch (e) {
      fail(e);
    }
    setPreview(null);
    setSelectedId(null);
    await reload();
  };

  const confirmFlowDelete = async () => {
    if (!flowPreview) return;
    const id = flowPreview.node;
    setFlowPreview(null);
    setSelectedId(null);
    await applyFlow(() => api.flowDelete(camera, id));
  };

  /** Stores where boxes are (top-left corners) and draws them there. A box is never connected by this. */
  const placeBoxes = async (where: Record<string, { x: number; y: number }>) => {
    const c = await api.chain(camera);
    const moved = c.nodes.map((n) => (where[n.id] ? { ...n, ...where[n.id] } : n));
    show({ ...c, nodes: moved });
    await api.saveChainLayout(camera, layoutOf(moved.map((n) => ({ id: n.id, x: n.x, y: n.y, label: n.label })), c.viewport));
  };

  /** Where a clicked tile puts its box: the middle of what is on screen, or the first free spot below it. */
  const clickSpot = (box: ChainNode["kind"]) => {
    const r = pane.current?.getBoundingClientRect();
    const middle = r ? flowView.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 }) : { x: 0, y: 0 };
    const taken = nodesRef.current.map((n) => ({ x: n.position.x, y: n.position.y, kind: n.data.node.kind }));
    return freeSpot(taken, dropPosition(middle, box), box);
  };

  const addFlowBox = async (kind: "crop" | "detector" | "calc" | "evaluation" | "dedup" | "export", at?: { x: number; y: number }) => {
    await applyFlow(async () => {
      const made = await api.flowCreate(camera, kind);
      setSelectedId(made.id);
      await placeBoxes({ [made.id]: at ?? clickSpot(kind) });
    });
  };

  const addFeature = async (at?: { x: number; y: number }) => {
    const taken = canvas?.nodes.filter((n) => n.ref).map((n) => n.ref!.split("::").pop()!) ?? [];
    const spot = at ?? clickSpot("roi");
    try {
      const made = await api.saveRoi(camera, { name: freshName("classifier", taken), x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
      await api.setChainDetached(camera, made.feature, true); // a new Classifier hangs alone until a line is drawn to it
      setError(null);
      await placeBoxes({ [`roi:${made.feature}`]: spot });
      return;
    } catch (e) {
      fail(e);
    }
    await reload();
  };

  /** A palette tile was clicked (no position) or dropped on the canvas (the box is centred on the pointer). */
  const addFromPalette = (kind: PaletteKind, pointer?: { x: number; y: number }) => {
    const box = paletteItem(kind).box;
    const at = pointer ? dropPosition(pointer, box) : undefined;
    if (kind === "classifier") void addFeature(at);
    else void addFlowBox(kind, at);
  };

  const onPaletteDrop = (e: React.DragEvent) => {
    const kind = e.dataTransfer.getData(PALETTE_DRAG) as PaletteKind;
    if (!kind || !canvas) return;
    e.preventDefault();
    const at = flowView.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    addFromPalette(kind, Number.isFinite(at.x) && Number.isFinite(at.y) ? at : undefined); // no usable pointer position: a free spot
  };

  // Opens the page for a box: Ingest, or the ROI editor / Classify on the box's ROI.
  const openPage = (n: ChainNode, view: "roi" | "classify") => {
    if (n.kind === "ingest" || !n.ref) {
      navigate("/ingest?focus=chain"); // opened from the Chain: the page offers the way back
      return;
    }
    if (onOpenRoi) {
      onOpenRoi(n.ref, view);
    } else {
      shared.publish(n.ref);
      navigate(`/${view}`);
    }
  };

  /** Opens the page of a box: Ingest, the Classifier (the product one for its names, a feature one on Classify), a Dedup box, or the flow page. */
  const openNode = (n: ChainNode) => {
    if (n.kind === "dedup") navigate(`/dedup/grid?box=${encodeURIComponent(n.id)}`); // the Dedup pages work on one box
    else if (isFlowKind(n.kind)) onOpenFlow ? onOpenFlow(n.id) : navigate(`/flow?focus=${encodeURIComponent(n.id)}`);
    else openPage(n, n.role === "classify" ? "roi" : "classify");
  };

  const panel = (
    <div className="chain-panel">
      <h3>Add</h3>
      <Palette
        disabled={!canvas}
        taken={{}}
        onAdd={(kind) => addFromPalette(kind)}
      />
      <h3>Selected box</h3>
      {!selectedLive && <p className="muted">Click a box, double-click it to open its page. Drag from a handle to draw an arrow; click an arrow and press Delete to remove it (Enter confirms, Esc cancels).</p>}
      {selectedLive && (
        <div className="chain-selected">
          <label>
            Name
            <input
              key={`${selectedLive.id}:${selectedLive.label}`}
              aria-label="Box name"
              maxLength={60}
              defaultValue={selectedLive.label}
              onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== selectedLive.label) rename(selectedLive.id, v); }}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            />
          </label>
          <p className="muted">{describeNode(selectedLive)}</p>
          {selectedLive.ref && <p className="muted">ROI: {selectedLive.ref}</p>}
          {selectedLive.kind === "roi" && selectedLive.ref && (
            <ClassifierMode
              camera={camera}
              node={selectedLive}
              productTaken={!!canvas?.nodes.some((n) => n.kind === "roi" && n.role === "classify" && n.id !== selectedLive.id)}
              onChanged={() => { setError(null); void reload(); }}
              onError={setError}
            />
          )}
          {isFlowKind(selectedLive.kind) && (
            <>
              <button
                type="button"
                onClick={() =>
                  selectedLive.kind === "dedup"
                    ? navigate(`/dedup/grid?box=${encodeURIComponent(selectedLive.id)}`) // the Dedup pages work on one box
                    : onOpenFlow ? onOpenFlow(selectedLive.id) : navigate(`/flow?focus=${encodeURIComponent(selectedLive.id)}`)
                }
              >
                {FLOW_PAGE[selectedLive.kind as keyof typeof FLOW_PAGE]}
              </button>
              <button type="button" className="danger" onClick={() => requestDelete(selectedLive.id)}>
                Delete…
              </button>
            </>
          )}
          {selectedLive.kind === "ingest" && (
            <button type="button" onClick={() => openPage(selectedLive, "roi")}>
              Ingest
            </button>
          )}
          {selectedLive.kind === "roi" && (
            <button type="button" onClick={() => openPage(selectedLive, "roi")}>
              ROI editor
            </button>
          )}
          {selectedLive.kind === "roi" && (
            <button type="button" onClick={() => openPage(selectedLive, "classify")}>
              Classify
            </button>
          )}
          {selectedLive.kind === "roi" && selectedLive.ref && (
            <label className="chain-evaluation">
              Reads through Dedup box
              <select
                aria-label="Dedup box"
                value={dedupInputOf(canvas, selectedLive.id) ?? ""}
                onChange={(e) => void applyFlow(() => api.setChainDedup(camera, selectedLive.ref!, e.target.value || null))}
              >
                <option value="">None</option>
                {(canvas?.nodes ?? []).filter((n) => n.kind === "dedup").map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
              </select>
            </label>
          )}
          {selectedLive.kind === "roi" && selectedLive.ref && (
            <label className="chain-evaluation">
              Evaluation shown on the cards
              <select
                aria-label="Evaluation"
                value={selectedLive.evaluation ?? ""}
                onChange={(e) => void applyFlow(() => api.setChainEvaluation(camera, selectedLive.ref!, e.target.value || null))}
              >
                <option value="">None</option>
                {(canvas?.nodes ?? []).filter((n) => n.kind === "evaluation").map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
              </select>
            </label>
          )}
          {selectedLive.kind === "roi" && (
            <button type="button" className="danger" onClick={() => requestDelete(selectedLive.id)}>
              Delete…
            </button>
          )}
        </div>
      )}
      {flowPreview && (
        <div className="chain-delete" role="alertdialog" aria-label="Confirm delete">
          <p><strong>Delete {flowPreview.node}?</strong> This cannot be undone.</p>
          <ul>
            <li>{flowPreview.arrows} arrows</li>
            {flowPreview.kind === "detector" && <li>{flowPreview.detections} pictures with stored boxes</li>}
            {flowPreview.kind === "dedup" && <li>{flowPreview.mutes ?? 0} muted pictures come back; its clusters and map are forgotten</li>}
          </ul>
          <button type="button" className="danger" onClick={() => void confirmFlowDelete()}>Delete box</button>
          <button type="button" onClick={() => setFlowPreview(null)}>Keep it</button>
        </div>
      )}
      {preview && (
        <div className="chain-delete" role="alertdialog" aria-label="Confirm delete">
          <p><strong>Delete {preview.feature}?</strong> This cannot be undone.</p>
          {preview.role === "classify" && <p>The product labels go with it.</p>}
          <ul>
            <li>{preview.counts.labels} labels</li>
            <li>{preview.counts.goldens} goldens</li>
            <li>{preview.counts.detections} detections</li>
            <li>{preview.counts.versions} versions</li>
          </ul>
          {preview.dependents.length > 0 && (
            <p>The product-scoped ROIs {preview.dependents.join(", ")} are separate boxes and stay.</p>
          )}
          <button type="button" className="danger" onClick={() => void confirmDelete()}>Delete everything</button>
          <button type="button" onClick={() => setPreview(null)}>Keep it</button>
        </div>
      )}
    </div>
  );

  return (
    <SidePanel panel={panel}>
      {error && <p role="alert">{error}</p>}
      {lineDialog && (
        <LineConfirm
          notes={lineDialog.notes}
          confirmLabel={lineDialog.confirmLabel}
          onConfirm={() => {
            const run = lineDialog.run;
            setLineDialog(null);
            run();
          }}
          onCancel={() => setLineDialog(null)}
        />
      )}
      {!canvas && !error && <p className="muted">Loading…</p>}
      {canvas && (
        <div
          className="chain-canvas"
          data-testid="chain-canvas"
          ref={pane}
          onDragOver={(e) => { if (e.dataTransfer.types.includes(PALETTE_DRAG)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } }}
          onDrop={onPaletteDrop}
        >
          <ReactFlow
            key={camera}
            nodes={shownNodes}
            edges={edges}
            nodeTypes={nodeTypes}
            defaultViewport={canvas.viewport ?? undefined}
            fitView={!canvas.viewport}
            nodesConnectable
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            onNodeClick={(_, n) => { setSelectedId(n.id); setSelectedEdgeId(null); }}
            onNodeDoubleClick={(_, n) => { const live = canvas?.nodes.find((x) => x.id === n.id); if (live) openNode(live); }}
            onEdgeClick={(_, e) => { setSelectedEdgeId(e.id); setSelectedId(null); }}
            onPaneClick={() => { setSelectedId(null); setSelectedEdgeId(null); }}
            connectionRadius={CONNECT_RADIUS}
            deleteKeyCode={["Delete", "Backspace"]}
            onNodesChange={(changes) =>
              setNodes((current) => {
                return applyNodeChanges([...changes], current);
              })
            }
            onNodeDragStop={() => saveLayout(nodesRef.current)}
            onMoveEnd={(_, v) => {
              viewport.current = { x: v.x, y: v.y, zoom: v.zoom };
              saveLayout(nodesRef.current);
            }}
            onBeforeDelete={async ({ nodes: doomed, edges: doomedEdges }) => {
              const box = doomed.find((n) => n.id !== INGEST_ID);
              if (box) requestDelete(box.id); // a box is deleted by its own confirmation, not its arrows here
              else if (doomedEdges.length) requestLineDelete(doomedEdges);
              return { nodes: [], edges: [] }; // a line goes only after Enter in the overlay
            }}
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      )}
    </SidePanel>
  );
}

/** The chain canvas: a per-camera map of the processing chain, drawn from the ROI definitions. */
export default function ChainView({ camera, onOpenRoi, onOpenFlow }: { camera: string; onOpenRoi?: OpenRoi; onOpenFlow?: (id: string) => void }) {
  return (
    <ReactFlowProvider>
      <h2>Chain</h2>
      {camera ? <Canvas camera={camera} onOpenRoi={onOpenRoi} onOpenFlow={onOpenFlow} /> : <p className="muted">Pick a camera first.</p>}
    </ReactFlowProvider>
  );
}
