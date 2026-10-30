import { useCallback, useEffect, useRef, useState } from "react";
import { api, FilterSpec, FlowCrop, FlowEdit, FlowNodeDetail } from "../api";
import type { MaskShape } from "../shapeGeometry";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** How long a change of a slider waits for the next one before it is saved (the preview does not wait). */
export const SAVE_DELAY = 350;

/** The id a new step gets: the first `sN` nobody uses (the server keeps ids, so they stay stable while steps move). */
export function newStepId(steps: FlowEdit[]): string {
  const taken = new Set(steps.map((s) => s.id));
  let n = 1;
  while (taken.has(`s${n}`)) n += 1;
  return `s${n}`;
}

/** `steps` with the one at `from` moved to place `to` (the others keep their order). */
export function moveStep<T>(steps: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= steps.length || to >= steps.length) return steps;
  const next = steps.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export type StepOp = "crop" | "filter" | "mask";

/** A new step of the given kind: a crop with nothing drawn, a mask with no shape chosen, or a filter with the catalogue's defaults. */
export function newStep(id: string, op: StepOp, catalogue: Record<string, FilterSpec>): FlowEdit {
  if (op === "crop") return { id, op: "crop", rect: null };
  if (op === "mask") return { id, op: "mask", shape: null };
  return filterStep(id, Object.keys(catalogue)[0] ?? "gaussian", catalogue);
}

/** A filter step with the catalogue's default parameters. */
export function filterStep(id: string, name: string, catalogue: Record<string, FilterSpec>): FlowEdit {
  const spec = catalogue[name];
  const params = spec ? Object.fromEntries(Object.entries(spec.params).map(([k, p]) => [k, p.default])) : {};
  return { id, op: "filter", name, params };
}

/**
 * The state of a Picture Edits box page, shared by its options panel (the list of steps and their parameters) and its
 * work area (the big picture). Changes show at once: the steps shown are a draft, the preview picture is computed from
 * the draft on the server (nothing is saved for it), and the draft is saved a moment after the last change.
 */
export interface PictureEdits {
  /** The steps as shown now (the draft). */
  steps: FlowEdit[];
  selected: string | null;
  select: (id: string | null) => void;
  /** Filter catalogue of the Detector page: name -> label and parameters. */
  filters: Record<string, FilterSpec>;
  detail: FlowCrop | null;
  addStep: (op: StepOp) => void;
  removeStep: (id: string) => void;
  moveStep: (from: number, to: number) => void;
  setOp: (id: string, op: StepOp) => void;
  /** Switch a step off (it keeps its place and is skipped) or on. The server stores the flag only while it is off. */
  setEnabled: (id: string, on: boolean) => void;
  setRect: (id: string, rect: [number, number, number, number] | null) => void;
  setFilter: (id: string, name: string) => void;
  /** Change (or clear, `null`) the shape of a mask step. While a detector target feeds the box it is sent with the picture it is drawn on. */
  setShape: (id: string, shape: MaskShape | null) => void;
  /** Turn a mask with the followed target's angle, or not. */
  setTurn: (id: string, turn: boolean) => void;
  /** The picture the work area shows now: a mask drawn while a detector target feeds the box is placed relative to the target found on it. */
  setFrame: (frame: string) => void;
  setParam: (id: string, key: string, value: number | string) => void;
  /** Any other change of the box (how a followed target is used, the rectangle of a following crop). */
  update: (body: Record<string, unknown>) => Promise<void>;
}

export function usePictureEdits(
  camera: string,
  nodeId: string,
  detail: FlowCrop | null,
  setDetail: (d: FlowNodeDetail) => void,
  onChanged: () => void,
  onError: (e: string | null) => void,
): PictureEdits {
  const [steps, setSteps] = useState<FlowEdit[]>(detail?.steps ?? []);
  const [selected, setSelected] = useState<string | null>(null);
  const [filters, setFilters] = useState<Record<string, FilterSpec>>({});
  const timer = useRef<number | undefined>(undefined);
  const pending = useRef<{ camera: string; nodeId: string; steps: FlowEdit[] } | null>(null); // a draft that is not saved yet, and the box it belongs to
  const inflight = useRef(0);
  const frame = useRef("");
  const latest = useRef({ camera, nodeId, setDetail, onChanged, onError });
  latest.current = { camera, nodeId, setDetail, onChanged, onError };

  useEffect(() => {
    api.visionFilters().then((r) => setFilters(r.filters)).catch(() => undefined);
  }, []);

  // The saved steps replace the draft unless something of it is still waiting to be saved.
  useEffect(() => {
    if (detail && pending.current === null && inflight.current === 0) setSteps(detail.steps);
  }, [detail?.steps]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void flush(); // what was changed last on the box before this one is kept (the draft knows its own box)
    setSelected(null);
  }, [nodeId]); // eslint-disable-line react-hooks/exhaustive-deps
  // A step is always selected when there is one: the last, so the big picture shows the result, until the user picks another.
  useEffect(() => {
    setSelected((cur) => (cur && steps.some((s) => s.id === cur) ? cur : steps[steps.length - 1]?.id ?? null));
  }, [steps]);

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    const draft = pending.current;
    if (!draft) return;
    pending.current = null;
    const { camera: cam, nodeId: id, steps: next } = draft;
    const here = () => latest.current.camera === cam && latest.current.nodeId === id; // still on the box the draft belongs to
    inflight.current += 1;
    try {
      const saved = (await api.flowUpdate(cam, id, { steps: next })) as unknown as { steps?: FlowEdit[] };
      if (here()) {
        const fresh = await api.flowNode(cam, id).catch(() => null);
        if (fresh) latest.current.setDetail(fresh);
        if (pending.current === null) setSteps(saved.steps ?? next);
        latest.current.onError(null);
      }
      latest.current.onChanged();
    } catch (e) {
      latest.current.onError(msg(e));
      const fresh = here() ? await api.flowNode(cam, id).catch(() => null) : null;
      if (fresh && fresh.kind === "crop") {
        latest.current.setDetail(fresh);
        if (pending.current === null) setSteps(fresh.steps);
      }
    } finally {
      inflight.current -= 1;
    }
  }, []);

  // Leaving the page keeps what was changed last.
  useEffect(() => () => { void flush(); }, [flush]);

  const commit = useCallback((next: FlowEdit[], delay = 0) => {
    setSteps(next);
    pending.current = { camera: latest.current.camera, nodeId: latest.current.nodeId, steps: next };
    window.clearTimeout(timer.current);
    if (delay > 0) timer.current = window.setTimeout(() => void flush(), delay);
    else void flush();
  }, [flush]);

  const patch = (id: string, fn: (s: FlowEdit) => FlowEdit, delay = 0) => commit(steps.map((s) => (s.id === id ? fn(s) : s)), delay);

  const update = useCallback(async (body: Record<string, unknown>) => {
    const { camera: cam, nodeId: id } = latest.current;
    try {
      await flush();
      const next = await api.flowUpdate(cam, id, body);
      latest.current.setDetail(await api.flowNode(cam, id).catch(() => next));
      latest.current.onError(null);
      latest.current.onChanged();
    } catch (e) {
      latest.current.onError(msg(e));
    }
  }, [flush]);

  return {
    steps,
    selected,
    select: setSelected,
    filters,
    detail,
    addStep: (op) => {
      const id = newStepId(steps);
      commit([...steps, newStep(id, op, filters)]);
      setSelected(id);
    },
    removeStep: (id) => commit(steps.filter((s) => s.id !== id)),
    moveStep: (from, to) => {
      const next = moveStep(steps, from, to);
      if (next !== steps) commit(next); // a step dropped where it already is changes nothing
    },
    setOp: (id, op) => {
      const at = steps.findIndex((s) => s.id === id);
      if (at < 0 || steps[at].op === op) return;
      commit(steps.map((s) => (s.id === id ? newStep(id, op, filters) : s)));
    },
    setEnabled: (id, on) =>
      patch(id, (s) => {
        const { enabled: _was, ...rest } = s;
        return (on ? rest : { ...rest, enabled: false }) as FlowEdit;
      }),
    setRect: (id, rect) => patch(id, (s) => (s.op === "crop" ? { ...s, rect } : s)),
    setFilter: (id, name) => patch(id, (s) => (s.op === "filter" ? filterStep(id, name, filters) : s)),
    setShape: (id, shape) =>
      patch(id, (s) => {
        if (s.op !== "mask") return s;
        const { rel: _rel, ref_angle: _ref, frame: _frame, anchor: _anchor, ...rest } = s; // what was measured for the old shape no longer fits
        return { ...rest, shape, ...(shape && detail?.follow && frame.current ? { anchor: { frame: frame.current } } : {}) };
      }, SAVE_DELAY),
    setTurn: (id, turn) =>
      patch(id, (s) => {
        if (s.op !== "mask") return s;
        const { turn: _was, ...rest } = s;
        return turn ? { ...rest, turn: true } : rest;
      }),
    setFrame: (f) => { frame.current = f; },
    setParam: (id, key, value) => patch(id, (s) => (s.op === "filter" ? { ...s, params: { ...s.params, [key]: value } } : s), SAVE_DELAY),
    update,
  };
}
