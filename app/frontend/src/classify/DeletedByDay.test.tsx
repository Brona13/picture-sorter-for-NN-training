import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import DeletedByDay, { dayKey, groupByDay } from "./DeletedByDay";

const at = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min).getTime() / 1000;
const ITEMS = [
  { frame: "a.png", deleted_at: at(2026, 10, 14, 9, 5), note: "foreign object" },
  { frame: "b.png", deleted_at: at(2026, 10, 15, 8, 0), note: "" },
  { frame: "c.png", deleted_at: at(2026, 10, 14, 16, 30), note: "" },
];

let calls: { url: string; method: string; body?: any }[];
let items: typeof ITEMS;
const onChanged = vi.fn();
const onNotice = vi.fn();
const onError = vi.fn();

beforeEach(() => {
  calls = [];
  items = [...ITEMS].sort((x, y) => y.deleted_at - x.deleted_at);
  onChanged.mockClear();
  onNotice.mockClear();
  onError.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, method, body });
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (url.includes("/classify/deleted-note")) return ok({ frame: body.frame, note: body.note.trim() });
      if (url.includes("/classify/deleted")) return ok({ items });
      if (url.endsWith("/classify/restore-bulk")) {
        items = items.filter((i) => !body.frames.includes(i.frame));
        return ok({ restored: body.frames.length });
      }
      return new Response("{}", { status: 404 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const SETTINGS = { per_page: 24, cols: 4, per_page_options: [12, 24, 48], cols_options: [3, 4, 5] };
const renderIt = () => render(<DeletedByDay camera="camA" feature="seal" revision={0} settings={SETTINGS} onSettings={() => {}} onChanged={onChanged} onNotice={onNotice} onError={onError} />);

test("groupByDay uses the local calendar day, newest day first and newest frame first", () => {
  expect(dayKey(at(2026, 10, 14, 23, 59))).toBe("2026-10-14");
  const groups = groupByDay(ITEMS);
  expect(groups.map((g) => g.day)).toEqual(["2026-10-15", "2026-10-14"]);
  expect(groups[1].items.map((i) => i.frame)).toEqual(["c.png", "a.png"]);
});

test("shows one section per deletion day with thumbnails that open the full image", async () => {
  renderIt();
  const newest = await screen.findByRole("region", { name: "Deleted on 2026-10-15" });
  const older = screen.getByRole("region", { name: "Deleted on 2026-10-14" });
  expect(within(newest).getAllByRole("img")).toHaveLength(1);
  expect(within(older).getAllByRole("img")).toHaveLength(2);
  expect(within(older).getByAltText("a.png").closest("a")!.getAttribute("href")).toBe("/api/cameras/camA/frames/a.png/image");
  expect(within(older).getByDisplayValue("foreign object")).toBeInTheDocument();
});

test("editing a note saves it", async () => {
  renderIt();
  const older = await screen.findByRole("region", { name: "Deleted on 2026-10-14" });
  const box = within(older).getByDisplayValue("foreign object");
  await userEvent.clear(box);
  await userEvent.type(box, "scratch{Enter}");
  await waitFor(() => expect(calls.some((c) => c.url.endsWith("/classify/deleted-note"))).toBe(true));
  expect(calls.find((c) => c.url.endsWith("/classify/deleted-note"))!.body).toEqual({ feature: "seal", frame: "a.png", note: "scratch" });
});

test("restoring one frame, a whole day (after confirming) or a ticked selection", async () => {
  renderIt();
  await screen.findByRole("region", { name: "Deleted on 2026-10-15" });

  await userEvent.click(screen.getByRole("button", { name: "Restore b.png" }));
  await waitFor(() => expect(calls.find((c) => c.url.endsWith("/restore-bulk"))!.body).toEqual({ feature: "seal", frames: ["b.png"] }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Deleted on 2026-10-15" })).toBeNull());
  expect(onChanged).toHaveBeenCalled();

  const day = screen.getByRole("region", { name: "Deleted on 2026-10-14" });
  await userEvent.click(within(day).getByRole("button", { name: "↺ Restore whole day" }));
  expect(calls.filter((c) => c.url.endsWith("/restore-bulk")).length).toBe(1); // needs the confirming click
  await userEvent.click(within(day).getByRole("button", { name: "Yes — restore all 2" }));
  await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/restore-bulk")).length).toBe(2));
  expect(calls.filter((c) => c.url.endsWith("/restore-bulk"))[1].body.frames.sort()).toEqual(["a.png", "c.png"]);
  expect(await screen.findByText("No deleted frames on this camera.")).toBeInTheDocument();
});

test("ticked frames from different days restore together", async () => {
  renderIt();
  await screen.findByRole("region", { name: "Deleted on 2026-10-15" });
  await userEvent.click(screen.getByRole("checkbox", { name: "Select b.png" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "Select a.png" }));
  await userEvent.click(screen.getByRole("button", { name: "↺ Restore selected (2)" }));
  await waitFor(() => expect(calls.find((c) => c.url.endsWith("/restore-bulk"))!.body.frames.sort()).toEqual(["a.png", "b.png"]));
  expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("Restored 2 frame(s)"));
});

test("follows the grid settings: the chosen columns, and paging by the chosen per-page", async () => {
  render(
    <DeletedByDay camera="camA" feature="seal" revision={0} settings={{ ...SETTINGS, per_page: 2, cols: 5 }} onSettings={() => {}} onChanged={onChanged} onNotice={onNotice} onError={onError} />,
  );
  await screen.findByTestId("deleted-by-day");
  const grids = screen.getByTestId("deleted-by-day").querySelectorAll<HTMLElement>("section > div");
  expect(grids[0].style.gridTemplateColumns).toBe("repeat(5, minmax(0, 1fr))");
  expect(screen.getAllByRole("img")).toHaveLength(2); // per page = 2 of 3
  await userEvent.click(screen.getAllByRole("button", { name: /Next/ })[0]);
  expect(screen.getAllByRole("img")).toHaveLength(1);
});
