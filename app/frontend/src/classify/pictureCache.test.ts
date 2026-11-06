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
  const cache = makePictureCache(() => onScreen);
  onScreen = await cache.load("/p?frame=0"); // the oldest entry is the one being shown
  for (let i = 1; i < 14; i++) await cache.load(`/p?frame=${i}`);
  expect(revoked).toContain("blob:2"); // an old one went
  expect(revoked).not.toContain(onScreen);
  cache.dispose();
  await Promise.resolve();
  expect(revoked.length).toBeGreaterThan(10);
});

test("warm never rejects", async () => {
  stubNetwork();
  const cache = makePictureCache();
  expect(() => cache.warm("/p?missing")).not.toThrow();
});
