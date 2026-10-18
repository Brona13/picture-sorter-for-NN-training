import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CardData } from "../api";
import PictureGrid from "./PictureGrid";

const all = ["a.png", "b.png", "c.png", "d.png", "e.png"];
const cardOf = (frame: string): CardData => ({ frame, label: null, golden: null, deleted: false, leanings: {}, bars: null, cluster: null });

let calls: { url: string; method: string; body?: any }[];

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, method: init?.method ?? "GET", body });
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (url.endsWith("/classify/delete")) return ok({ card: { frame: body.frame, label: null, golden: null, deleted: true }, counts: {} });
      if (url.endsWith("/classify/restore")) return ok({ card: { frame: body.frame, label: null, golden: null, deleted: false }, counts: {} });
      return new Response("{}", { status: 404 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

/** A tool that owns its list the way Outliers and the Scatter selection do: a deleted frame leaves the list. */
function Tool({ restorable = false, takesBack = true, initial = all }: { restorable?: boolean; takesBack?: boolean; initial?: string[] }) {
  const [frames, setFrames] = useState(initial);
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(2);
  return (
    <>
      <button onClick={() => setFrames(["x.png", "y.png"])}>new list</button>
      <PictureGrid
        camera="camA"
        feature="seal"
        classes={["OK", "NG"]}
        frames={frames}
        cardOf={cardOf}
        via="Outliers"
        grid={{ per_page: perPage, cols: 2, per_page_options: [2, 4], cols_options: [2, 3] }}
        onGrid={(p) => setPerPage(p)}
        page={page}
        onPage={setPage}
        where="demo"
        restorable={restorable}
        onDeleted={(f) => setFrames((cur) => cur.filter((x) => x !== f))}
        onRestored={takesBack ? (f) => setFrames((cur) => (cur.includes(f) ? cur : [...cur, f].sort())) : undefined}
        onChanged={() => undefined}
        onError={() => undefined}
      />
    </>
  );
}

const shown = () => screen.queryAllByTestId(/^card-/).map((e) => e.getAttribute("data-testid")!.replace("card-", ""));
const del = (f: string) => userEvent.click(within(screen.getByTestId(`card-${f}`)).getByRole("button", { name: "Delete frame" }));
const next = () => userEvent.click(within(screen.getByRole("navigation", { name: "Pagination demo top" })).getByRole("button", { name: /Next/ }));

test("a deleted card fades and stays exactly where it was, with Restore, while the tool's own list shrinks", async () => {
  render(<Tool />);
  await del("a.png");
  await within(screen.getByTestId("card-a.png")).findByRole("button", { name: "Restore frame" });
  expect(shown()).toEqual(["a.png", "b.png"]); // nothing moved up from the next page
  expect(within(screen.getByTestId("card-a.png")).getByRole("img", { name: "a.png" })).toHaveStyle({ opacity: "0.5" });
});

test("several deletes in a row keep all their cards in place", async () => {
  render(<Tool />);
  await del("a.png");
  await within(screen.getByTestId("card-a.png")).findByRole("button", { name: "Restore frame" });
  await del("b.png");
  await within(screen.getByTestId("card-b.png")).findByRole("button", { name: "Restore frame" });
  expect(shown()).toEqual(["a.png", "b.png"]);
});

test("turning the page drops the deleted cards; the list then continues without them", async () => {
  render(<Tool />);
  await del("a.png");
  await within(screen.getByTestId("card-a.png")).findByRole("button", { name: "Restore frame" });
  await next();
  expect(shown()).toEqual(["d.png", "e.png"]); // page 2 of the list without the deleted picture
  await userEvent.click(within(screen.getByRole("navigation", { name: "Pagination demo top" })).getByRole("button", { name: /First/ }));
  expect(shown()).toEqual(["b.png", "c.png"]); // a.png is gone for good
});

test("changing the page size drops them too", async () => {
  render(<Tool />);
  await del("a.png");
  await within(screen.getByTestId("card-a.png")).findByRole("button", { name: "Restore frame" });
  await userEvent.selectOptions(screen.getAllByLabelText("Per page demo top")[0], "4");
  expect(shown()).toEqual(["b.png", "c.png", "d.png", "e.png"]);
});

test("searching drops them too", async () => {
  render(<Tool />);
  await del("a.png");
  await within(screen.getByTestId("card-a.png")).findByRole("button", { name: "Restore frame" });
  await userEvent.click(screen.getAllByRole("button", { name: "Search by file name" })[0]);
  await userEvent.type(screen.getAllByLabelText(/Search file name/)[0], "png");
  expect(shown()).toEqual(["b.png", "c.png"]);
});

test("a list the tool replaces is shown as it is, nothing is kept in place for it", async () => {
  render(<Tool />);
  await del("a.png");
  await within(screen.getByTestId("card-a.png")).findByRole("button", { name: "Restore frame" });
  await userEvent.click(screen.getByRole("button", { name: "new list" }));
  await waitFor(() => expect(shown()).toEqual(["x.png", "y.png"]));
});

test("a card deleted here can be restored in place when the tool takes pictures back; it then stays when the grid is turned", async () => {
  render(<Tool />);
  await del("a.png");
  await userEvent.click(await within(screen.getByTestId("card-a.png")).findByRole("button", { name: "Restore frame" }));
  await waitFor(() => expect(within(screen.getByTestId("card-a.png")).getByRole("button", { name: "Delete frame" })).toBeEnabled());
  expect(shown()).toEqual(["a.png", "b.png"]);
  expect(calls.some((c) => c.url.endsWith("/classify/restore"))).toBe(true);
  await userEvent.selectOptions(screen.getAllByLabelText("Per page demo top")[0], "4");
  expect(shown()).toEqual(["a.png", "b.png", "c.png", "d.png"]);
});

test("where the tool cannot take a picture back, the faded card's Restore is disabled and says where to restore it", async () => {
  render(<Tool takesBack={false} />);
  await del("a.png");
  const restore = await within(screen.getByTestId("card-a.png")).findByRole("button", { name: "Restore frame" });
  expect(restore).toBeDisabled();
  expect(restore).toHaveAttribute("title", expect.stringContaining("Show: Deleted"));
});

test("a faded card takes no label", async () => {
  render(<Tool />);
  await del("a.png");
  const card = screen.getByTestId("card-a.png");
  await within(card).findByRole("button", { name: "Restore frame" });
  expect(within(card).getByRole("button", { name: /OK/ })).toBeDisabled();
  fireEvent.mouseEnter(card);
  fireEvent.keyDown(window, { key: "1" });
  expect(calls.some((c) => c.url.endsWith("/classify/label"))).toBe(false);
});

test("the viewer walks over the faded card too, shows it as deleted, and can restore it", async () => {
  render(<Tool />);
  await del("a.png");
  await within(screen.getByTestId("card-a.png")).findByRole("button", { name: "Restore frame" });
  fireEvent.click(within(screen.getByTestId("card-a.png")).getByRole("link"));
  const viewer = await screen.findByRole("dialog", { name: "Full-size picture" });
  expect(within(viewer).getByTestId("viewer-position")).toHaveTextContent("1 / 5");
  expect(within(viewer).getByRole("button", { name: "Restore frame" })).toBeEnabled();
  expect(within(viewer).getByRole("button", { name: /OK/ })).toBeDisabled();
});
