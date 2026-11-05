import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import ExportWork, { when } from "./ExportWork";

let calls: { url: string; method: string; body?: any }[];
let frozen: any[];
let boxState: Record<string, unknown>;
let counts: { both: number; not_golden: number; no_product: number; total: number; folders: Record<string, number> };
const detail = { kind: "export" as const, lines: { ok: [{ feature: "seal", dot: "OK" }], ng: [{ box: "eval:1", dot: "fail" }] }, goldens_only: true, step: 2 as const };

const version = (over: Record<string, unknown> = {}) => ({
  id: 7, number: 2, name: "x", created: 1793350800, counts: { total: 5, ok: 3, ng: 2 }, changed: false, exported: false, folder: "exports/project/v002__x", ...over,
});

beforeEach(() => {
  calls = [];
  frozen = [];
  boxState = {};
  counts = { both: 1, not_golden: 4, no_product: 2, total: 5, folders: { "A/OK": 3, "A/NG": 2 } };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url.endsWith("/export") && method === "GET")
      return new Response(JSON.stringify({
        folders: counts.folders, total: counts.total, ok: 3, ng: 2, both: counts.both, not_golden: counts.not_golden, no_product: counts.no_product,
        uses_product: true, goldens_only: true, lines: { ok: 1, ng: 1 }, latest: frozen[0] ?? null, versions: frozen, ...boxState,
      }));
    if (url.endsWith("/export/left-out"))
      return new Response(JSON.stringify({
        total: 2, reasons: { "foam-4: muted by Dedup 5": 1, "foam-1: Detector 2 found no target": 1 },
        items: [
          { frame: "a.png", missing: [{ classifier: "foam-4", feature: "foam4", state: "absent", why: "muted by Dedup 5" }], said: { "foam-1": "OK" } },
          { frame: "b.png", missing: [{ classifier: "foam-1", feature: "foam1", state: "absent", why: "Detector 2 found no target" }], said: {} },
        ],
      }));
    if (url.endsWith("/export/freeze")) { frozen = [version(), ...frozen]; return new Response(JSON.stringify({ id: 7, number: 2, counts: {} }), { status: 201 }); }
    if (url.endsWith("/project-versions/7/export")) {
      frozen = frozen.map((v) => (v.id === 7 ? { ...v, exported: true } : v));
      return new Response(JSON.stringify({ destination: "exports/project/v002__x", written: 5, missing: [], hash_mismatch: [], ...("box" in boxState ? { boxes: 4, no_box: 1 } : {}) }));
    }
    if (url.endsWith("/project-versions/7/ds-export")) {
      frozen = frozen.map((v) => (v.id === 7 ? { ...v, ds: { zip: "exports/project/set_v002.zip", written: 4 } } : v));
    }
    if (url.endsWith("/project-versions/7/ds-export"))
      return new Response(JSON.stringify({ destination: "exports/project/set_v002.zip", written: 4, no_box: 0, left_out: 1, missing: [], hash_mismatch: [], name_clash: [], other_class: 0 }));
    return new Response(JSON.stringify(detail));
  }));
});
afterEach(() => vi.unstubAllGlobals());

const mount = (d: typeof detail | { step: 1 } = detail) => render(<ExportWork camera="camA" nodeId="export:1" detail={{ ...detail, ...d }} setDetail={() => {}} onError={() => {}} />);

test("one table holds the folders, what is left out and why, and the total", async () => {
  mount();
  expect(await screen.findByText("A/OK")).toBeInTheDocument();
  expect(screen.getAllByRole("table")).toHaveLength(1);
  expect(screen.getByText("Left out: they reach both OK and NG").nextSibling).toHaveTextContent("1");
  expect(screen.getByText("Left out: not golden").nextSibling).toHaveTextContent("4");
  expect(screen.getByText("Left out: no product").nextSibling).toHaveTextContent("2");
  expect(screen.getByText("Total to export").nextSibling).toHaveTextContent("5");
});

test("a reason with nothing behind it has no row, and nothing arriving says where to connect", async () => {
  counts = { both: 0, not_golden: 0, no_product: 0, total: 0, folders: {} };
  mount();
  expect(await screen.findByText(/Nothing arrives yet/)).toHaveTextContent("on the Chain");
  expect(screen.queryByText(/Left out/)).not.toBeInTheDocument();
  expect(screen.queryByText("Total to export")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Freeze" })).toBeDisabled();
});

test("the lines are not listed here: they are drawn on the Chain", async () => {
  mount();
  await screen.findByText("A/OK");
  expect(screen.queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
  expect(screen.queryByText("seal · OK")).not.toBeInTheDocument();
});

test("freezes with a name, lists the freeze, then exports it and shows where it went", async () => {
  mount();
  await screen.findByText("A/OK");
  expect(screen.getByText(/Nothing frozen yet/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Export version/ })).not.toBeInTheDocument();

  fireEvent.change(screen.getByLabelText("Freeze name"), { target: { value: "x" } });
  fireEvent.click(screen.getByRole("button", { name: "Freeze" }));
  await waitFor(() => expect(calls.some((c) => c.url.endsWith("/export/freeze") && c.body.name === "x")).toBe(true));

  const row = within((await screen.findByRole("table", { name: "Frozen versions" })).querySelector("tbody tr") as HTMLElement);
  expect(row.getByText("v2")).toBeInTheDocument();
  expect(row.getByText("x")).toBeInTheDocument();
  expect(row.getByText("Not exported")).toBeInTheDocument();
  expect(row.getByText("exports/project/v002__x")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Export version 2" }));
  expect(await screen.findByText(/Wrote 5 pictures/)).toHaveTextContent("exports/project/v002__x");
  expect(screen.getByRole("button", { name: "Copy path" })).toBeInTheDocument();
  expect(await screen.findByText("Exported")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Export version 2" })).toHaveTextContent("Export files again");
});

test("every freeze has a row, newest first, and only the newest can say the Chain changed", async () => {
  frozen = [version({ id: 9, number: 3, name: "third", changed: true }), version({ id: 7, number: 2, name: "second", exported: true, changed: true })];
  mount();
  const rows = Array.from((await screen.findByRole("table", { name: "Frozen versions" })).querySelectorAll("tbody tr"));
  expect(rows).toHaveLength(2);
  expect(within(rows[0] as HTMLElement).getByText("v3")).toBeInTheDocument();
  expect(within(rows[1] as HTMLElement).getByText("v2")).toBeInTheDocument();
  expect(within(rows[0] as HTMLElement).getByText("Chain changed")).toBeInTheDocument();
  expect(within(rows[1] as HTMLElement).queryByText("Chain changed")).not.toBeInTheDocument();
  expect(within(rows[1] as HTMLElement).getByText("Exported")).toBeInTheDocument();
});

test("an older backend that only sends the latest freeze still fills the table", async () => {
  frozen = [version()];
  (fetch as any).mockImplementation(async (url: string) =>
    new Response(JSON.stringify(url.endsWith("/export")
      ? { folders: {}, total: 0, ok: 0, ng: 0, both: 0, not_golden: 0, no_product: 0, uses_product: false, goldens_only: true, lines: { ok: 0, ng: 0 }, latest: frozen[0] }
      : detail)));
  mount();
  expect(await screen.findByText("v2")).toBeInTheDocument();
});

test("the goldens tick goes through the node update", async () => {
  mount();
  await screen.findByText("A/OK");
  fireEvent.click(screen.getByLabelText("Only goldens"));
  await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.body?.goldens_only === false)).toBe(true));
});

test("the Freeze module (step 1) has no goldens tick: it takes every OK and NG picture", async () => {
  mount({ step: 1 });
  await screen.findByText("A/OK");
  expect(screen.queryByLabelText("Only goldens")).toBeNull();
  expect(screen.getByText("Freeze: every OK and NG picture")).toBeInTheDocument();
});

test("a freeze time in epoch seconds is shown as a date, text is kept as it is", () => {
  expect(when(1793350800)).toMatch(/^2026-10-30 \d\d:\d\d$/);
  expect(when("yesterday")).toBe("yesterday");
});

test("step 2 with a Box: the page says which Box, how many pictures have a rectangle, and offers the layout of the numbers", async () => {
  boxState = { box: "box:1", with_box: 4, no_box: 1, box_format: "corners" };
  mount();
  const box = await screen.findByTestId("export-box");
  expect(box).toHaveTextContent("Rectangles from box:1: 4 of 5 pictures have one; 1 will be exported without numbers");
  expect(box).toHaveTextContent("boxes.csv");
  const layout = screen.getByLabelText("Layout of the numbers") as HTMLSelectElement;
  expect(layout.value).toBe("corners");
  fireEvent.change(layout, { target: { value: "size" } });
  await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.body?.box_format === "size")).toBe(true));
});

test("step 2 without a Box says the pictures go out without numbers; the Freeze of step 1 shows no such section", async () => {
  boxState = { box: null, with_box: 0, no_box: 0 };
  const { unmount } = render(<ExportWork camera="camA" nodeId="export:1" detail={detail} setDetail={() => {}} onError={() => {}} />);
  expect(await screen.findByText(/No Box on these lines/)).toBeInTheDocument();
  unmount();
  mount({ step: 1 });
  await screen.findByText("A/OK");
  expect(screen.queryByTestId("export-box")).toBeNull();
});

test("the export report lists the rectangles written to boxes.csv", async () => {
  boxState = { box: "box:1", with_box: 4, no_box: 1, box_format: "corners" };
  frozen = [version()];
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Export version 2" }));
  expect(await screen.findByText(/Listed 4 rectangles in/)).toBeInTheDocument();
  expect(screen.getByText(/1 picture has none/)).toBeInTheDocument();
});

test("the DS card opens from a freeze row, takes the fields, says what was written and the row says a DS zip was made", async () => {
  boxState = { box: "box:1", with_box: 4, no_box: 1, box_format: "corners" };
  frozen = [version({ counts: { total: 5, ok: 3, ng: 2, with_box: 4 } })];
  mount();
  await screen.findByRole("table", { name: "Frozen versions" });
  expect(screen.queryByRole("region", { name: "DS import file" })).not.toBeInTheDocument(); // closed until a row asks for it
  fireEvent.click(screen.getByRole("button", { name: "DS dataset of version 2" }));
  const card = within(screen.getByRole("region", { name: "DS import file" }));
  expect(card.getByText(/3 · DS dataset from v2/)).toBeInTheDocument();
  expect(card.queryByLabelText("Freeze for the DS file")).not.toBeInTheDocument(); // the row chose the freeze
  expect(card.getByLabelText("Dataset name")).toHaveValue("camA");
  expect(card.getByLabelText("NG colour")).toHaveValue("#f44336");
  fireEvent.change(card.getByLabelText("Dataset name"), { target: { value: "My set" } });
  fireEvent.change(card.getByLabelText("NG class name"), { target: { value: "Bad" } });
  fireEvent.click(card.getByRole("checkbox"));
  fireEvent.click(card.getByRole("button", { name: "Make DS zip" }));
  await waitFor(() => expect(calls.some((c) => c.url.endsWith("/project-versions/7/ds-export"))).toBe(true));
  const sent = calls.find((c) => c.url.endsWith("/project-versions/7/ds-export"))!;
  expect(sent.method).toBe("POST");
  expect(sent.body).toMatchObject({ dataset_name: "My set", folder_name: "camA", ok_name: "OK", ng_name: "Bad", include_without_box: true, zip_name: "" });
  expect(await screen.findByRole("status", { name: "DS zip result" })).toHaveTextContent("Wrote 4 pictures to exports/project/set_v002.zip");
  expect(screen.getByRole("status", { name: "DS zip result" })).toHaveTextContent("1 left out: no rectangle.");
  expect(await screen.findByText("DS zip made")).toBeInTheDocument(); // section 2 says it
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("region", { name: "DS import file" })).not.toBeInTheDocument();
});

test("the form comes back with the last values; the zip name stays empty", async () => {
  boxState = { box: "box:1", with_box: 4, no_box: 1, box_format: "corners", ds_fields: { dataset_name: "Mine", folder_name: "200", ok_name: "Good", ng_name: "Bad", ok_color: "#010203", ng_color: "#0a0b0c", include_without_box: true, zip_name: "old" } };
  frozen = [version({ counts: { total: 5, ok: 3, ng: 2, with_box: 4 } })];
  mount();
  await screen.findByRole("table", { name: "Frozen versions" });
  fireEvent.click(screen.getByRole("button", { name: "DS dataset of version 2" }));
  const card = within(screen.getByRole("region", { name: "DS import file" }));
  await waitFor(() => expect(card.getByLabelText("Dataset name")).toHaveValue("Mine"));
  expect(card.getByLabelText("NG class name")).toHaveValue("Bad");
  expect(card.getByLabelText("OK colour")).toHaveValue("#010203");
  expect(card.getByRole("checkbox")).toBeChecked();
  expect(card.getByLabelText("Zip file name")).toHaveValue("");
});

test("no DS buttons in step 1; a freeze without rectangles has its DS button off", async () => {
  mount({ step: 1 });
  await screen.findByText("Freeze: every OK and NG picture");
  expect(screen.queryByRole("button", { name: /DS dataset/ })).not.toBeInTheDocument();
});

test("a freeze without rectangles cannot open the DS card", async () => {
  boxState = { box: "box:1", with_box: 4, no_box: 1, box_format: "corners" };
  frozen = [version()];
  mount();
  await screen.findByRole("table", { name: "Frozen versions" });
  expect(screen.getByRole("button", { name: "DS dataset of version 2" })).toBeDisabled();
});

test("Freeze: the pictures in neither pile are listed on request, with the Classifier and the reason for each", async () => {
  mount({ step: 1 });
  await screen.findByText("A/OK");
  expect(calls.some((c) => c.url.endsWith("/export/left-out"))).toBe(false); // only when asked for
  fireEvent.click(screen.getByRole("button", { name: "Show them" }));
  const card = await screen.findByTestId("left-out-a.png");
  expect(card).toHaveTextContent("foam-4: muted by Dedup 5");
  expect(card).toHaveTextContent("foam-1 OK");
  expect(screen.getByTestId("left-out-b.png")).toHaveTextContent("foam-1: Detector 2 found no target");
  expect(screen.getByRole("table", { name: "Why pictures are left out" })).toHaveTextContent("foam-4: muted by Dedup 5");
});

test("the step-2 Export has no such list", async () => {
  mount();
  await screen.findByText("A/OK");
  expect(screen.queryByTestId("left-out")).toBeNull();
});
