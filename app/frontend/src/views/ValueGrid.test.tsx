import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import ValueGrid, { ValueRow } from "./ValueGrid";

beforeEach(() => localStorage.clear());

const ROWS: ValueRow[] = [
  { frame: "a.png", value: 1.2, verdict: "pass" },
  { frame: "b.png", value: 9.9, verdict: "fail" },
  { frame: "c.png", value: null, verdict: "undetermined" },
];

test("a page can give the card picture; without it the camera's square thumbnail is used", () => {
  const { unmount } = render(<ValueGrid camera="cam" rows={ROWS} />);
  expect(screen.getByAltText("a.png").getAttribute("src")).toContain("variant=square");
  unmount();
  render(<ValueGrid camera="cam" rows={ROWS} thumb={(f) => `/whole/${f}`} />);
  expect(screen.getByAltText("a.png").getAttribute("src")).toBe("/whole/a.png");
});

test("a card of a pass or fail picture has a green or red edge, any other card keeps the plain one", () => {
  render(<ValueGrid camera="cam" rows={ROWS} />);
  expect(screen.getByTestId("value-card-a.png").style.border).toContain("rgb(60, 207, 110)");
  expect(screen.getByTestId("value-card-b.png").style.border).toContain("rgb(255, 91, 91)");
  expect(screen.getByTestId("value-card-c.png").style.border).toContain("var(--border)");
});

test("in the viewer, holding Space shows the reference picture and releasing goes back to the selected one", () => {
  render(<ValueGrid camera="cam" rows={ROWS} viewer={{ reference: ROWS[1] }} />);
  fireEvent.click(screen.getByAltText("a.png"));
  const shown = () => screen.getByTestId("value-viewer").querySelector("img[alt$='.png']")?.getAttribute("alt");
  expect(shown()).toBe("a.png");
  fireEvent.keyDown(window, { code: "Space", key: " " });
  expect(shown()).toBe("b.png");
  fireEvent.keyUp(window, { code: "Space", key: " " });
  expect(shown()).toBe("a.png");
});

test("without a reference picture Space does nothing", () => {
  render(<ValueGrid camera="cam" rows={ROWS} viewer={{ reference: null }} />);
  fireEvent.click(screen.getByAltText("a.png"));
  fireEvent.keyDown(window, { code: "Space", key: " " });
  expect(screen.getByTestId("value-viewer").querySelector("img[alt$='.png']")?.getAttribute("alt")).toBe("a.png");
});

test("with labeling the cards are Classify cards: class buttons, golden, delete, a pass / fail edge and a one-line name", async () => {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    return new Response(JSON.stringify({ card: { frame: "a.png", label: "NG", golden: null, deleted: false }, counts: {} }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    render(<ValueGrid camera="cam" rows={ROWS} labeling={{ feature: "seal", classes: ["OK", "NG"], marks: { "a.png": { label: "OK", golden: null } } }} />);
    const card = screen.getByTestId("card-a.png");
    expect(card.style.border).toContain("rgb(60, 207, 110)");
    expect(screen.getByText("a.png").getAttribute("title")).toBe("a.png");
    expect(within(card).getByRole("button", { name: "OK" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(card).getByTestId("measure-badge")).not.toHaveTextContent("pass"); // the green edge says it; no word on top
    expect(within(screen.getByTestId("card-c.png")).getByTestId("measure-badge")).toHaveTextContent("undetermined"); // plain edge: the word stays
    fireEvent.click(within(card).getByRole("button", { name: "NG" }));
    await waitFor(() => expect(within(screen.getByTestId("card-a.png")).getByRole("button", { name: "NG" }).getAttribute("aria-pressed")).toBe("true"));
    expect(calls.some((c) => c.includes("/frames/a.png/label") || c.includes("label"))).toBe(true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("without labeling the card keeps the plain look but the name is one line", () => {
  render(<ValueGrid camera="cam" rows={ROWS} />);
  expect(screen.queryByTestId("card-a.png")).toBeNull();
  expect(screen.getByText("a.png").style.whiteSpace).toBe("nowrap");
});

test("with labeling, a zone card shows dx, dy on one line and the distance from the nominal on the next, without 'from nominal'", () => {
  const rows: ValueRow[] = [
    { frame: "z.png", value: 15, verdict: "fail", point: [109, 12], deviation: [9, 12] },
    { frame: "n.png", value: null, verdict: "undetermined", point: [109, 12], deviation: null }, // no nominal yet: no distance
  ];
  render(<ValueGrid camera="cam" rows={rows} labeling={{ feature: "seal", classes: ["OK", "NG"], marks: {} }} />);
  const badge = within(screen.getByTestId("card-z.png")).getByTestId("measure-badge");
  expect(badge).toHaveTextContent("dx 9.0, dy 12.0 px");
  expect(badge).not.toHaveTextContent("fail");
  expect(badge).not.toHaveTextContent("from nominal");
  expect(within(badge).getByTestId("measure-distance")).toHaveTextContent("distance 15.0 px");
  expect(within(screen.getByTestId("card-n.png")).queryByTestId("measure-distance")).toBeNull();
});

test("pass and fail are told by the edge only; 'Use as nominal' is a small aim icon on the card and in the viewer", () => {
  const onNominal = vi.fn();
  render(<ValueGrid camera="cam" rows={ROWS} onNominal={onNominal} />);
  const card = screen.getByTestId("value-card-b.png");
  expect(card).not.toHaveTextContent("fail");
  expect(screen.getByTestId("value-card-c.png")).toHaveTextContent("undetermined");
  const aim = within(card).getByRole("button", { name: "Use as nominal" });
  expect(aim).not.toHaveTextContent("Use as nominal"); // an icon, not words
  expect(aim.querySelector("svg")).not.toBeNull();
  fireEvent.click(aim);
  expect(onNominal).toHaveBeenCalledWith(9.9);
  fireEvent.click(screen.getByAltText("b.png"));
  const toolbar = screen.getByTestId("viewer-value");
  expect(toolbar).not.toHaveTextContent("fail");
  expect(within(toolbar).getByRole("button", { name: "Use as nominal" }).querySelector("svg")).not.toBeNull();
});
