import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CardData } from "../api";
import PictureGrid from "./PictureGrid";

const settings = { per_page: 2, cols: 2, per_page_options: [2, 4], cols_options: [2, 3] };
const frames = ["a.png", "b.png", "c.png"];
const cardOf = (frame: string): CardData => ({ frame, label: frame === "b.png" ? "OK" : null, golden: null, deleted: false, leanings: {}, bars: null, cluster: null });

let calls: { url: string; method: string; body?: any }[];
const onChanged = vi.fn();
const onDeleted = vi.fn();
const onError = vi.fn();

beforeEach(() => {
  calls = [];
  [onChanged, onDeleted, onError].forEach((f) => f.mockClear());
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, method: init?.method ?? "GET", body });
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (url.endsWith("/classify/label")) return ok({ card: { frame: body.frame, label: body.cls, golden: null, deleted: false }, counts: {} });
      if (url.endsWith("/classify/delete")) return ok({ card: { frame: body.frame, label: null, golden: null, deleted: true }, counts: {} });
      if (url.endsWith("/classify/restore")) return ok({ card: { frame: body.frame, label: null, golden: null, deleted: false }, counts: {} });
      return new Response("{}", { status: 404 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function Harness(props: { viewer?: boolean; restorable?: boolean; deleted?: boolean; pictureFeature?: string }) {
  const [page, setPage] = useState(1);
  return (
    <PictureGrid
      camera="camA"
      feature="seal"
      pictureFeature={props.pictureFeature}
      classes={["OK", "NG"]}
      frames={frames}
      cardOf={(f) => ({ ...cardOf(f), deleted: !!props.deleted && f === "a.png" })}
      via="Outliers"
      grid={settings}
      onGrid={() => undefined}
      page={page}
      onPage={setPage}
      where="demo"
      extras={(f) => ({ caption: `cap ${f}` })}
      viewer={props.viewer}
      restorable={props.restorable}
      onChanged={onChanged}
      onDeleted={onDeleted}
      onError={onError}
    />
  );
}

test("shows one page of cards with their captions and a pager above and below named after the tool", async () => {
  render(<Harness />);
  expect(screen.getByTestId("card-a.png")).toBeInTheDocument();
  expect(screen.getByTestId("card-b.png")).toBeInTheDocument();
  expect(screen.queryByTestId("card-c.png")).toBeNull();
  expect(screen.getByText("cap a.png")).toBeInTheDocument();
  expect(screen.getByRole("navigation", { name: "Pagination demo top" })).toBeInTheDocument();
  expect(screen.getByRole("navigation", { name: "Pagination demo bottom" })).toBeInTheDocument();
  await userEvent.click(within(screen.getByRole("navigation", { name: "Pagination demo top" })).getByRole("button", { name: /Next/ }));
  expect(screen.getByTestId("card-c.png")).toBeInTheDocument();
  expect(screen.queryByTestId("card-a.png")).toBeNull();
});

test("a label is stamped with the tool and reported once through onChanged", async () => {
  render(<Harness />);
  await userEvent.click(within(screen.getByTestId("card-a.png")).getByRole("button", { name: /NG/ }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  expect(calls.find((c) => c.url.endsWith("/classify/label"))!.body).toEqual({ feature: "seal", frame: "a.png", cls: "NG", via: "Outliers" });
  expect(onChanged).toHaveBeenCalledWith("a.png", expect.objectContaining({ label: "NG" }));
  expect(onDeleted).not.toHaveBeenCalled();
});

test("a delete is stamped with the tool and reported through onDeleted, not onChanged", async () => {
  render(<Harness />);
  await userEvent.click(within(screen.getByTestId("card-a.png")).getByRole("button", { name: "Delete frame" }));
  await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
  expect(calls.find((c) => c.url.endsWith("/classify/delete"))!.body).toEqual({ feature: "seal", frame: "a.png", via: "Outliers" });
  expect(onDeleted).toHaveBeenCalledWith("a.png", expect.objectContaining({ deleted: true }));
  expect(onChanged).not.toHaveBeenCalled();
});

test("a failed call is reported through onError and nothing else", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: "boom" }), { status: 500 })));
  render(<Harness />);
  await userEvent.click(within(screen.getByTestId("card-a.png")).getByRole("button", { name: /NG/ }));
  await waitFor(() => expect(onError).toHaveBeenCalled());
  expect(onChanged).not.toHaveBeenCalled();
});

test("clicking a picture opens the viewer, unless the tool turned it off", async () => {
  const { unmount } = render(<Harness />);
  await userEvent.click(within(screen.getByTestId("card-a.png")).getByRole("link"));
  expect(screen.getByRole("dialog", { name: "Full-size picture" })).toBeInTheDocument();
  unmount();
  render(<Harness viewer={false} />);
  const card = screen.getByTestId("card-a.png");
  expect(within(card).queryByRole("link")).toBeNull(); // the picture is not clickable, as before
  await userEvent.click(within(card).getByAltText("a.png"));
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("a deleted card in the viewer cannot be labeled and can be restored, but only where the tool keeps deleted frames", async () => {
  render(<Harness deleted restorable />);
  await userEvent.click(within(screen.getByTestId("card-a.png")).getByRole("link"));
  const viewer = await screen.findByRole("dialog", { name: "Full-size picture" });
  expect(within(viewer).getByRole("button", { name: /NG/ })).toBeDisabled();
  await userEvent.click(within(viewer).getByRole("button", { name: "Restore frame" }));
  await waitFor(() => expect(calls.some((c) => c.url.endsWith("/classify/restore"))).toBe(true));
});

test("a deleted card can be restored only when the tool keeps deleted frames on the grid", async () => {
  const { unmount } = render(<Harness deleted />);
  await userEvent.click(within(screen.getByTestId("card-a.png")).getByRole("button", { name: /Restore/ }));
  expect(calls.some((c) => c.url.endsWith("/classify/restore"))).toBe(false);
  unmount();
  render(<Harness deleted restorable />);
  await userEvent.click(within(screen.getByTestId("card-a.png")).getByRole("button", { name: /Restore/ }));
  await waitFor(() => expect(calls.some((c) => c.url.endsWith("/classify/restore"))).toBe(true));
  expect(onChanged).toHaveBeenCalledWith("a.png", expect.objectContaining({ deleted: false }));
});

test("the cards show the cutout of pictureFeature while labels go to the feature", async () => {
  const { container } = render(<Harness pictureFeature="dedup:2" />);
  const srcs = Array.from(container.querySelectorAll("img")).map((i) => i.getAttribute("src") ?? "");
  expect(srcs.length).toBeGreaterThan(0);
  expect(srcs.every((u) => u.includes("feature=dedup%3A2"))).toBe(true);
  await userEvent.click(screen.getAllByRole("button", { name: "OK" })[0]);
  await waitFor(() => expect(calls.some((c) => c.url.endsWith("/classify/label") && c.body.feature === "seal")).toBe(true));
});
