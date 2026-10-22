import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FlowCrop, FlowEdit, FlowFollow, FlowNodeDetail } from "../api";
import { filterStep, moveStep, newStepId, usePictureEdits } from "./pictureEdits";
import PictureEditsPanel, { describeEdit } from "./PictureEditsPanel";

let calls: { url: string; method: string; body?: any }[];
let saved: FlowEdit[];

const FILTERS = {
  gaussian: { label: "Gaussian blur", params: { sigma: { min: 0.1, max: 10, step: 0.1, default: 1.5 } } },
  median: { label: "Median blur", params: { size: { min: 3, max: 15, step: 2, default: 3 } } },
};
const gauss = (id: string, sigma = 1.5): FlowEdit => ({ id, op: "filter", name: "gaussian", params: { sigma } });
const crop = (id: string, rect: [number, number, number, number] | null = null): FlowEdit => ({ id, op: "crop", rect });
const base = (steps: FlowEdit[], over: Partial<FlowCrop> = {}): FlowCrop => ({ kind: "crop", steps, input_box: "ingest", crops: [], ...over });

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url.includes("/vision/filters")) return new Response(JSON.stringify({ filters: FILTERS }));
    if (method === "PUT" && calls.at(-1)!.body.steps) saved = calls.at(-1)!.body.steps;
    return new Response(JSON.stringify({ kind: "crop", steps: saved, input_box: "ingest", crops: [] }));
  }));
});
afterEach(() => vi.unstubAllGlobals());

const puts = () => calls.filter((c) => c.method === "PUT");
const ids = (steps: FlowEdit[]) => steps.map((s) => s.id);

function Harness({ detail }: { detail: FlowCrop }) {
  const [d, setD] = useState<FlowNodeDetail>(detail);
  const edits = usePictureEdits("camA", "crop:1", d as FlowCrop, setD, () => {}, () => {});
  return <PictureEditsPanel edits={edits} />;
}
const setup = async (detail: FlowCrop) => {
  saved = detail.steps;
  render(<Harness detail={detail} />);
  await waitFor(() => expect(calls.some((c) => c.url.includes("/vision/filters"))).toBe(true));
  await new Promise((r) => setTimeout(r, 10)); // the catalogue is in
};

test("helpers: a step moves to its new place, ids never repeat, a filter starts with the catalogue defaults", () => {
  expect(moveStep(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
  expect(moveStep(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  expect(moveStep(["a", "b"], 1, 1)).toEqual(["a", "b"]);
  expect(moveStep(["a", "b"], 0, 5)).toEqual(["a", "b"]);
  expect(newStepId([])).toBe("s1");
  expect(newStepId([crop("s1"), crop("s3")])).toBe("s2");
  expect(filterStep("s4", "median", FILTERS)).toEqual({ id: "s4", op: "filter", name: "median", params: { size: 3 } });
});

test("describeEdit: one line per step", () => {
  expect(describeEdit(gauss("s1", 2), FILTERS, false)).toBe("Gaussian blur · sigma 2");
  expect(describeEdit(crop("s1", [0, 0, 0.5, 0.25]), FILTERS, false)).toBe("50 × 25 % of the picture");
  expect(describeEdit(crop("s1"), FILTERS, false)).toBe("no crop drawn yet");
  expect(describeEdit(crop("s1"), FILTERS, true)).toBe("follows the target");
});

test("lists the steps in order; only the first is open, the others are one line", async () => {
  await setup(base([gauss("s1", 2), crop("s2", [0, 0, 0.5, 0.5])]));
  const items = screen.getAllByRole("listitem");
  expect(items).toHaveLength(2);
  expect(within(items[0]).getByLabelText("sigma")).toHaveValue("2");
  expect(within(items[0]).getByRole("combobox", { name: "Filter" })).toHaveValue("gaussian");
  expect(within(items[1]).queryByRole("combobox")).not.toBeInTheDocument(); // the operation is in the open part
  expect(within(items[1]).getByText("Crop")).toBeInTheDocument();
  expect(items[1]).toHaveTextContent(/^\s*⠿\s*2\s*Crop\s*▸\s*$/); // grip, name, arrow (the switch has no text)
  fireEvent.click(within(items[1]).getByRole("button", { name: "Open step 2" }));
  expect(await within(screen.getAllByRole("listitem")[1]).findByRole("button", { name: "Clear crop" })).toBeInTheDocument();
  expect(within(screen.getAllByRole("listitem")[0]).queryByLabelText("sigma")).not.toBeInTheDocument(); // opening one closes the other
  expect(screen.getAllByRole("listitem")[0]).not.toHaveAttribute("aria-current");
});

test("a collapsed step is one line: grip, name, arrow and the on/off switch, and a click on the line opens it", async () => {
  await setup(base([gauss("s1"), gauss("s2", 3)]));
  const second = screen.getAllByRole("listitem")[1];
  expect(within(second).getByLabelText("Drag step 2")).toBeInTheDocument();
  expect(within(second).getByRole("switch", { name: "Step 2 on" })).toBeChecked();
  expect(within(second).getByRole("button", { name: "Open step 2" })).toHaveAttribute("aria-expanded", "false");
  expect(second.querySelectorAll("select, input[type=range], button")).toHaveLength(1); // only the arrow
  fireEvent.click(within(second).getByText("Gaussian blur"));
  expect(within(screen.getAllByRole("listitem")[1]).getByLabelText("sigma")).toHaveValue("3");
});

test("the switch skips a step without removing it; it is stored only while off", async () => {
  await setup(base([gauss("s1"), crop("s2")]));
  fireEvent.click(screen.getByRole("switch", { name: "Step 1 on" }));
  await waitFor(() => expect(puts()).toHaveLength(1));
  expect(puts()[0].body.steps).toEqual([{ ...gauss("s1"), enabled: false }, crop("s2")]); // same place, same parameters
  expect(screen.getByRole("switch", { name: "Step 1 on" })).not.toBeChecked();
  expect(screen.getByText(/This step is off/)).toBeInTheDocument();
  expect(screen.getByLabelText("sigma")).toBeInTheDocument(); // an off step can still be opened and changed
  fireEvent.click(screen.getByRole("switch", { name: "Step 1 on" }));
  await waitFor(() => expect(puts()).toHaveLength(2));
  expect(puts()[1].body.steps[0]).toEqual(gauss("s1")); // on again: no flag at all
  expect(screen.queryByText(/This step is off/)).not.toBeInTheDocument();
});

test("a step that follows a detector target cannot be switched off", async () => {
  const follow: FlowFollow = { detector: "det:1", target: "hole", mode: "keep", frame: null, size: null, offset: null, missing: [], offered: ["position"], modes: [{ id: "keep", label: "Position only", enabled: true, needs: [] }] };
  await setup(base([crop("s1"), gauss("s2")], { follow, follow_step: "s1", input_box: "det:1" }));
  expect(screen.getByRole("switch", { name: "Step 1 on" })).toBeDisabled();
  expect(screen.getByRole("switch", { name: "Step 2 on" })).toBeEnabled();
});

test("a step is added from the drop-down; a filter gets the catalogue's defaults and a new id", async () => {
  await setup(base([crop("s1")]));
  fireEvent.change(screen.getByRole("combobox", { name: "Add step" }), { target: { value: "filter" } });
  await waitFor(() => expect(puts()).toHaveLength(1));
  expect(puts()[0].body.steps).toEqual([crop("s1"), gauss("s2", 1.5)]);
  expect(await screen.findAllByRole("listitem")).toHaveLength(2);
  fireEvent.change(screen.getByRole("combobox", { name: "Add step" }), { target: { value: "crop" } });
  await waitFor(() => expect(puts()).toHaveLength(2));
  expect(ids(puts()[1].body.steps)).toEqual(["s1", "s2", "s3"]);
});

test("the arrow buttons of the open step change the order and keep the ids", async () => {
  await setup(base([gauss("s1"), crop("s2"), gauss("s3", 4)]));
  expect(screen.getByRole("button", { name: "Move step 1 up" })).toBeDisabled(); // step 1 is the open one
  expect(screen.queryByRole("button", { name: "Move step 3 up" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Open step 3" }));
  expect(screen.getByRole("button", { name: "Move step 3 down" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Move step 3 up" }));
  await waitFor(() => expect(puts()).toHaveLength(1));
  expect(ids(puts()[0].body.steps)).toEqual(["s1", "s3", "s2"]);
});

test("dragging a step by its grip onto another moves it there", async () => {
  await setup(base([gauss("s1"), crop("s2"), gauss("s3", 4)]));
  const dataTransfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
  const items = screen.getAllByRole("listitem");
  fireEvent.dragStart(within(items[0]).getByLabelText("Drag step 1"), { dataTransfer });
  fireEvent.dragOver(items[2], { dataTransfer });
  fireEvent.drop(items[2], { dataTransfer });
  await waitFor(() => expect(puts()).toHaveLength(1));
  expect(ids(puts()[0].body.steps)).toEqual(["s2", "s3", "s1"]);
});

test("dropping a step on itself, or a drop that did not start from a grip, changes nothing", async () => {
  await setup(base([gauss("s1"), crop("s2")]));
  const dataTransfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
  const items = screen.getAllByRole("listitem");
  fireEvent.dragStart(within(items[1]).getByLabelText("Drag step 2"), { dataTransfer });
  fireEvent.drop(items[1], { dataTransfer });
  fireEvent.drop(items[0], { dataTransfer });
  await new Promise((r) => setTimeout(r, 50));
  expect(puts()).toHaveLength(0);
});

test("a step is removed, and the operation or the filter can be changed", async () => {
  await setup(base([gauss("s1"), crop("s2")]));
  fireEvent.change(screen.getByRole("combobox", { name: "Filter" }), { target: { value: "median" } });
  await waitFor(() => expect(puts()).toHaveLength(1));
  expect(puts()[0].body.steps[0]).toEqual({ id: "s1", op: "filter", name: "median", params: { size: 3 } });
  fireEvent.click(screen.getByRole("button", { name: "Open step 2" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Step 2 operation" }), { target: { value: "filter" } });
  await waitFor(() => expect(puts()).toHaveLength(2));
  expect(puts()[1].body.steps[1]).toEqual({ id: "s2", op: "filter", name: "gaussian", params: { sigma: 1.5 } });
  fireEvent.click(screen.getByRole("button", { name: "Open step 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove step 1" }));
  await waitFor(() => expect(puts()).toHaveLength(3));
  expect(ids(puts()[2].body.steps)).toEqual(["s2"]);
});

test("a parameter is saved a moment after the last change, not on every tick", async () => {
  await setup(base([gauss("s1")]));
  const slider = screen.getByLabelText("sigma");
  fireEvent.change(slider, { target: { value: "3" } });
  fireEvent.change(slider, { target: { value: "4.5" } });
  expect(slider).toHaveValue("4.5"); // shown at once
  expect(puts()).toHaveLength(0);
  await waitFor(() => expect(puts()).toHaveLength(1), { timeout: 2000 });
  expect(puts()[0].body.steps).toEqual([gauss("s1", 4.5)]);
});

test("a refused change is shown and the steps go back to what is saved", async () => {
  await setup(base([gauss("s1")]));
  const failing = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "PUT") return new Response(JSON.stringify({ detail: "No." }), { status: 422 });
    return new Response(JSON.stringify({ kind: "crop", steps: [gauss("s1")], input_box: "ingest", crops: [] }));
  });
  vi.stubGlobal("fetch", failing);
  fireEvent.click(screen.getByRole("button", { name: "Move step 1 down" }) as HTMLElement); // disabled: a single step
  fireEvent.change(screen.getByRole("combobox", { name: "Add step" }), { target: { value: "crop" } });
  await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1)); // the added step is taken back
});

test("a Picture edits box fed by a target: its crop step cannot be removed, and the way to use the target is chosen there", async () => {
  const follow: FlowFollow = {
    detector: "det:1", target: "hole", mode: "keep", frame: null, size: null, offset: null, missing: [], offered: ["position", "angle"],
    modes: [
      { id: "keep", label: "Position only", enabled: true, needs: [] },
      { id: "straighten", label: "Straighten", enabled: false, needs: ["Angle"] },
    ],
  };
  await setup(base([gauss("s1"), crop("s2")], { follow, follow_step: "s2", input_box: "det:1" }));
  expect(screen.getByRole("button", { name: "Remove step 1" })).toBeEnabled(); // step 1 is open
  fireEvent.click(screen.getByRole("button", { name: "Open step 2" }));
  expect(screen.getByRole("button", { name: "Remove step 2" })).toBeDisabled();
  expect(await screen.findByText(/det:1 offers from hole: position, angle/)).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "Position only" })).toBeEnabled();
  expect(screen.getByRole("option", { name: /Straighten.*tick Angle/ })).toBeDisabled();
  expect(screen.getByText(/its first Crop step is the one that follows the target/)).toBeInTheDocument();
});
