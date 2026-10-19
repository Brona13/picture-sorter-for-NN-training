import "@xyflow/react/dist/style.css";
import {
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ChainCanvas, ChainDeletePreview, ChainNode, ChainViewport, FlowDeletePreview } from "../api";
import { INGEST_ID, connectAction, describeNode, disconnectAction, flowConnect, freshName, isAnchorEdge, isFlowKind, layoutOf, productHandle } from "../chain/chainModel";
import AnchorSection from "../chain/AnchorSection";
import { useSharedFeature } from "../SharedFeature";
import SidePanel from "../SidePanel";

type BoxData = {
  node: ChainNode;
  onRename: (id: string, label: string) => void;
};
type BoxNode = Node<BoxData, "box">;

const HUE = { ingest: 160, roi: 30, classify: 145, detector: 265, calc: 200, evaluation: 340 } as const;
const hueOf = (n: ChainNode) => HUE[n.kind];

/** A box of the chain: a rounded two-tone rectangle with an inline-renamable title. */
function Box({ data, selected }: NodeProps<BoxNode>) {
  const { node, onRename } = data;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(node.label);
  const commit = () => {
    setEditing(false);
    const label = draft.trim();
    if (label && label !== node.label) onRename(node.id, label);
    else setDraft(node.label);
  };
  const isClassify = node.kind === "classify";
  return (
    <div
      className={`chain-node${selected ? " selected" : ""}`}
      style={{ ["--hue" as string]: hueOf(node) }}
      data-testid={`chain-node-${node.id}`}
    >
      {node.kind !== "ingest" && <Handle type="target" position={Position.Left} />}
      <div className="chain-node-title" onDoubleClick={() => { setDraft(node.label); setEditing(true); }}>
        {editing ? (
          <input
            className="nodrag"
            autoFocus
            value={draft}
            maxLength={60}
            aria-label="Box name"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") { setDraft(node.label); setEditing(false); }
            }}
          />
        ) : (
          node.label
        )}
      </div>
      <div className="chain-node-sub">{describeNode(node)}</div>
      {isClassify &&
        node.classes.map((product) => (
          <div className="chain-node-product" key={product}>
            {product}: {node.product_counts[product] ?? 0}
            {node.role === "classify" && <Handle type="source" position={Position.Right} id={productHandle(product)} />}
          </div>
        ))}
      {isClassify && node.unlabeled > 0 && <div className="chain-node-sub">{node.unlabeled} not labeled yet</div>}
      {!isClassify && <Handle type="source" position={Position.Right} />}
    </div>
  );
}

const nodeTypes = { box: Box };
const FLOW_PAGE = { detector: "Detector", calc: "Calculate", evaluation: "Evaluation" } as const;

function toFlowNode(n: ChainNode, onRename: BoxData["onRename"], selected: boolean): BoxNode {
  return { id: n.id, type: "box", position: { x: n.x, y: n.y }, data: { node: n, onRename }, selected, deletable: n.kind === "roi" || isFlowKind(n.kind) };
}

export function toFlowEdge(e: ChainCanvas["edges"][number]): Edge {
  return {
    id: e.id,
    source: e.source,
    sourceHandle: e.source_handle,
    target: e.target,
    type: "smoothstep",
    deletable: !e.locked,
    className: e.locked ? "chain-edge-locked" : undefined,
  };
}

type OpenRoi = (feature: string, view: "roi" | "classify") => void;

function Canvas({ camera, onOpenRoi, onOpenFlow }: { camera: string; onOpenRoi?: OpenRoi; onOpenFlow?: (id: string) => void }) {
  const navigate = useNavigate();
  const shared = useSharedFeature();
  const [canvas, setCanvas] = useState<ChainCanvas | null>(null);
  const [nodes, setNodes] = useState<BoxNode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState<"product" | null>(null);
  const [productNames, setProductNames] = useState("");
  const [preview, setPreview] = useState<ChainDeletePreview | null>(null);
  const [flowPreview, setFlowPreview] = useState<FlowDeletePreview | null>(null);
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

  const edges = useMemo(() => canvas?.edges.map(toFlowEdge) ?? [], [canvas]);
  const shownNodes = useMemo(() => nodes.map((n) => ({ ...n, selected: n.id === selectedId })), [nodes, selectedId]);
  const selected = canvas?.nodes.find((n) => n.id === selectedId) ?? null;
  const selectedLive = selected ? (nodes.find((n) => n.id === selected.id)?.data.node ?? selected) : null;

  const apply = async (result: ReturnType<typeof connectAction>) => {
    if ("error" in result) {
      setError(result.error);
    } else {
      setError(null);
      try {
        await api.setRoiProducts(camera, result.feature, result.products);
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
    const link = { source: c.source, sourceHandle: c.sourceHandle, target: c.target };
    const flowArrow = flowConnect(canvas, link);
    if (flowArrow === null) void apply(connectAction(canvas, link));
    else if ("error" in flowArrow) setError(flowArrow.error);
    else void applyFlow(() => api.flowConnect(camera, flowArrow.source, flowArrow.target));
  };

  const isValidConnection = (c: Connection | Edge) => {
    if (!canvas) return false;
    const link = { source: c.source, sourceHandle: c.sourceHandle ?? null, target: c.target };
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

  const addFlowBox = async (kind: "detector" | "calc" | "evaluation") => {
    await applyFlow(async () => {
      const made = await api.flowCreate(camera, kind);
      setSelectedId(made.id);
    });
  };

  const addFeature = async () => {
    const taken = canvas?.nodes.filter((n) => n.ref).map((n) => n.ref!.split("::").pop()!) ?? [];
    try {
      await api.saveRoi(camera, { name: freshName("feature", taken), x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
      setError(null);
    } catch (e) {
      fail(e);
    }
    await reload();
  };

  const addProduct = async () => {
    const names = productNames.split(",").map((p) => p.trim()).filter(Boolean);
    try {
      await api.saveRoi(camera, { name: "product", x: 0.05, y: 0.05, w: 0.9, h: 0.9, make_classifier: true, product_names: names });
      setError(null);
      setAdding(null);
      setProductNames("");
    } catch (e) {
      fail(e);
    }
    await reload();
  };

  // Opens the page for a box: Ingest, or the ROI editor / Classify on the box's ROI.
  const openPage = (n: ChainNode, view: "roi" | "classify") => {
    if (n.kind === "ingest" || !n.ref) {
      navigate("/ingest");
      return;
    }
    if (onOpenRoi) {
      onOpenRoi(n.ref, view);
    } else {
      shared.publish(n.ref);
      navigate(`/${view}`);
    }
  };

  const panel = (
    <div className="chain-panel">
      <h3>Add</h3>
      <div className="chain-palette">
        <button type="button" disabled={!canvas || !!canvas.classify} onClick={() => setAdding("product")}>
          + ROI product
        </button>
        <button type="button" disabled={!canvas} onClick={() => void addFeature()}>
          + ROI feature
        </button>
        <button type="button" disabled={!canvas} onClick={() => void addFlowBox("detector")}>
          + Detector
        </button>
        <button type="button" disabled={!canvas} onClick={() => void addFlowBox("calc")}>
          + Calculate
        </button>
        <button type="button" disabled={!canvas} onClick={() => void addFlowBox("evaluation")}>
          + Evaluation
        </button>
      </div>
      {canvas?.classify && <p className="muted">The camera already has its product-sorting ROI.</p>}
      {adding === "product" && (
        <form
          className="chain-form"
          onSubmit={(e) => { e.preventDefault(); void addProduct(); }}
        >
          <label>
            Product names, separated by commas
            <input value={productNames} onChange={(e) => setProductNames(e.target.value)} placeholder="4x4, 4x4RS, 2x4" autoFocus />
          </label>
          <button type="submit">Create</button>
          <button type="button" onClick={() => setAdding(null)}>Cancel</button>
        </form>
      )}
      <h3>Selected box</h3>
      {!selectedLive && <p className="muted">Click a box. Double-click its name to rename it. Drag from a handle to draw an arrow.</p>}
      {selectedLive?.kind === "classify" && (
        <p className="muted">
          {selectedLive.role === "classify"
            ? "Label the pictures here to tell which product each one is."
            : "Label this ROI's pictures here (OK / NG)."}{" "}
          It goes when its ROI is deleted.
        </p>
      )}
      {selectedLive && (
        <div className="chain-selected">
          <p><strong>{selectedLive.label}</strong></p>
          <p className="muted">{describeNode(selectedLive)}</p>
          {selectedLive.ref && <p className="muted">ROI: {selectedLive.ref}</p>}
          {isFlowKind(selectedLive.kind) && (
            <>
              <button type="button" onClick={() => (onOpenFlow ? onOpenFlow(selectedLive.id) : navigate(`/flow?focus=${encodeURIComponent(selectedLive.id)}`))}>
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
          {(selectedLive.kind === "roi" || selectedLive.kind === "classify") && (
            <button type="button" onClick={() => openPage(selectedLive, "classify")}>
              Classify
            </button>
          )}
          {selectedLive.kind === "roi" && selectedLive.role !== "classify" && canvas && (
            <AnchorSection
              key={`${selectedLive.id}:${selectedLive.anchor?.detector ?? ""}:${selectedLive.anchor?.target ?? ""}`}
              camera={camera}
              roi={selectedLive}
              detectors={canvas.nodes.filter((n) => n.kind === "detector")}
              onChanged={() => void reload()}
              onError={setError}
            />
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
          </ul>
          <button type="button" className="danger" onClick={() => void confirmFlowDelete()}>Delete box</button>
          <button type="button" onClick={() => setFlowPreview(null)}>Keep it</button>
        </div>
      )}
      {preview && (
        <div className="chain-delete" role="alertdialog" aria-label="Confirm delete">
          <p><strong>Delete {preview.feature}?</strong> This cannot be undone.</p>
          {preview.role === "classify" && <p>Its Classify box and the product labels go with it.</p>}
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
      {!canvas && !error && <p className="muted">Loading…</p>}
      {canvas && (
        <div className="chain-canvas" data-testid="chain-canvas">
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
            onNodeClick={(_, n) => setSelectedId(n.id)}
            onPaneClick={() => setSelectedId(null)}
            onNodesChange={(changes) => setNodes((current) => applyNodeChanges(changes, current))}
            onNodeDragStop={() => saveLayout(nodesRef.current)}
            onMoveEnd={(_, v) => {
              viewport.current = { x: v.x, y: v.y, zoom: v.zoom };
              saveLayout(nodesRef.current);
            }}
            onBeforeDelete={async ({ nodes: doomed, edges: doomedEdges }) => {
              const box = doomed.find((n) => n.id !== INGEST_ID);
              if (box) requestDelete(box.id);
              return { nodes: [], edges: doomedEdges };
            }}
            onEdgesDelete={(gone) => {
              if (canvas) for (const e of gone) {
                const edge = canvas.edges.find((x) => x.id === e.id);
                if (!edge) continue;
                const ends = [edge.source, edge.target].map((id) => canvas.nodes.find((n) => n.id === id)?.kind);
                if (isAnchorEdge(canvas, edge)) void api.clearRoiAnchor(camera, canvas.nodes.find((n) => n.id === edge.target)!.ref!).then(() => reload()).catch(fail);
                else if (ends.some((k) => isFlowKind(k))) void applyFlow(() => api.flowDisconnect(camera, edge.source, edge.target));
                else void apply(disconnectAction(canvas, edge));
              }
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
