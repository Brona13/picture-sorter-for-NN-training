import { afterEach, expect, test, vi } from "vitest";
import { makePictureCache } from "./pictureCache";

afterEach(() => vi.unstubAllGlobals());

function stubNetwork() {
  const fetchMock = vi.fn(async (url: string) => ({ ok: !url.includes("missing"), status: url.includes("missing") ? 404 : 200, blob: async () => new Blob([url]) }));
  let n = 0;
  const revoked: string[] = [];
  vi.stubGlobal("fetch", fetchMock);
  URL.createObjectURL = vi.fn(() => `blob:${++n}`);
  URL.revokeObjectURL = vi.fn((u: string) => void revoked.push(u));
  return { fetchMock, revoked };
}

test("a picture is fetched once and then served from the cache", async () => {
  const { fetchMock } = stubNetwork();
  const cache = makePictureCache();
  const first = await cache.load("/p?frame=a");
  expect(await cache.load("/p?frame=a")).toBe(first);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("a picture that cannot be had is not kept, so a later try asks again", async () => {
  const { fetchMock } = stubNetwork();
  const cache = makePictureCache();
  await expect(cache.load("/p?missing")).rejects.toThrow("404");
  await expect(cache.load("/p?missing")).rejects.toThrow("404");
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("old pictures are freed beyond the limit, but never the one on screen; dispose frees the rest", async () => {
  const { revoked } = stubNetwork();
  let onScreen: string | undefined;
  const cache = makePictureCache(() => onScreen, 12);
  onScreen = await cache.load("/p?frame=0"); // the oldest entry is the one being shown
  for (let i = 1; i < 14; i++) await cache.load(`/p?frame=${i}`);
  expect(revoked).toContain("blob:2"); // an old one went
  expect(revoked).not.toContain(onScreen);
  cache.dispose();
  await Promise.resolve();
  expect(revoked.length).toBeGreaterThan(10);
});

test("prefetch fetches a few at a time, nearest first, and never twice", async () => {
  const { fetchMock } = stubNetwork();
  const cache = makePictureCache();
  const urls = Array.from({ length: 8 }, (_, i) => `/p?frame=${i}`);
  cache.prefetch(urls);
  await Promise.resolve();
  expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(urls.slice(0, 3)); // three at once, in the order given
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(8));
  cache.prefetch(urls);
  await new Promise((r) => setTimeout(r, 10));
  expect(fetchMock).toHaveBeenCalledTimes(8);
});

test("a new list drops what has not started; a picture asked for while queued is fetched once", async () => {
  const { fetchMock } = stubNetwork();
  const cache = makePictureCache();
  cache.prefetch(["/p?1", "/p?2", "/p?3", "/p?4", "/p?5"]);
  cache.prefetch(["/p?9", "/p?8"]); // the viewer moved
  await vi.waitFor(() => expect(fetchMock.mock.calls.map((c) => c[0])).toContain("/p?8"));
  const asked = fetchMock.mock.calls.map((c) => c[0]);
  expect(asked).not.toContain("/p?4");
  expect(asked).not.toContain("/p?5");
  await cache.load("/p?8");
  expect(fetchMock.mock.calls.filter((c) => c[0] === "/p?8")).toHaveLength(1);
});

test("a picture that is not there (404) is not asked for again by prefetch", async () => {
  const { fetchMock } = stubNetwork();
  const cache = makePictureCache();
  cache.prefetch(["/p?missing", "/p?ok"]);
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  cache.prefetch(["/p?missing", "/p?ok"]);
  await new Promise((r) => setTimeout(r, 10));
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("dispose stops the queue and frees the pictures", async () => {
  const { fetchMock, revoked } = stubNetwork();
  const cache = makePictureCache();
  cache.prefetch(Array.from({ length: 10 }, (_, i) => `/p?frame=${i}`));
  await Promise.resolve();
  cache.dispose();
  await new Promise((r) => setTimeout(r, 10));
  expect(fetchMock.mock.calls.length).toBeLessThan(10);
  expect(revoked.length).toBeGreaterThan(0);
});
