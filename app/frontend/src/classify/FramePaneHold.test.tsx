import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import FramePane from "./FramePane";

afterEach(() => {
  vi.unstubAllGlobals();
  delete (Image.prototype as { decode?: unknown }).decode;
});

test("the old picture stays on screen until the next has loaded; neighbours are fetched ahead", async () => {
  const release: Record<string, () => void> = {};
  const fetchMock = vi.fn((url: string) => new Promise((resolve) => { release[url] = () => resolve({ ok: true, status: 200, blob: async () => new Blob([url]) }); }));
  vi.stubGlobal("fetch", fetchMock);
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:${++n}`);
  URL.revokeObjectURL = vi.fn();
  (Image.prototype as { decode?: () => Promise<void> }).decode = () => Promise.resolve();

  const urlOf = (f: string) => `/box/picture?frame=${f}`;
  const { rerender } = render(<FramePane camera="c" frame="a.png" width={400} imageUrl={urlOf("a.png")} preload={[urlOf("b.png")]} />);
  expect(screen.getByRole("img", { name: "a.png" })).toHaveAttribute("src", urlOf("a.png"));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(urlOf("b.png")));

  rerender(<FramePane camera="c" frame="b.png" width={400} imageUrl={urlOf("b.png")} preload={[urlOf("c.png")]} />);
  // b is still on its way: a stays, there is no empty gap
  expect(screen.getByRole("img", { name: "a.png" })).toBeInTheDocument();
  expect(screen.queryByRole("img", { name: "b.png" })).toBeNull();

  await act(async () => { release[urlOf("b.png")](); });
  await waitFor(() => expect(screen.getByRole("img", { name: "b.png" })).toHaveAttribute("src", "blob:1"));
  expect(fetchMock.mock.calls.filter((c) => c[0] === urlOf("b.png"))).toHaveLength(1); // fetched once, shown from the preload
});

test("a picture that cannot be had is shown the usual way instead of leaving the old one", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, blob: async () => new Blob() })));
  (Image.prototype as { decode?: () => Promise<void> }).decode = () => Promise.resolve();
  const { rerender } = render(<FramePane camera="c" frame="a.png" width={400} imageUrl="/x?a" preload={[]} />);
  rerender(<FramePane camera="c" frame="b.png" width={400} imageUrl="/x?b" preload={[]} />);
  await waitFor(() => expect(screen.getByRole("img", { name: "b.png" })).toHaveAttribute("src", "/x?b"));
});
