import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, frameCutoutUrl } from "../api";
import { thumbUrl } from "./Card";

let keys: { state: string; list: string; overview: string };
beforeEach(() => {
  keys = { state: "k1", list: "r1", overview: "o1" };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/classify/state")) return new Response(JSON.stringify({ feature: "pick", picture_key: keys.state }));
    if (url.endsWith("/rois")) return new Response(JSON.stringify({ rois: [{ feature: "pick", picture_key: keys.list }] }));
    if (url.endsWith("/overview")) return new Response(JSON.stringify({ cameras: [{ camera: "camA", rois: [{ feature: "pick", picture_key: keys.overview }] }] }));
    return new Response("{}", { status: 404 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

test("the Classifier's state records its picture key: every thumbnail and cutout address carries it, and another key is another address", async () => {
  const before = thumbUrl("camA", "a.png", "pick");
  expect(before).not.toContain("&v=");
  await api.classifyState("camA", "pick");
  const one = thumbUrl("camA", "a.png", "pick");
  expect(one).toContain("&v=k1");
  expect(frameCutoutUrl("camA", "a.png", "pick")).toContain("&v=k1");
  keys.state = "k2"; // the Box got other margins
  await api.classifyState("camA", "pick");
  expect(thumbUrl("camA", "a.png", "pick")).toContain("&v=k2");
  expect(thumbUrl("camA", "a.png", "pick")).not.toBe(one);
});

test("the ROI list and the Overview record the key too, before any thumbnail they show is drawn", async () => {
  await api.rois("camA");
  expect(thumbUrl("camA", "a.png", "pick")).toContain("&v=r1");
  await api.overview();
  expect(thumbUrl("camA", "a.png", "pick")).toContain("&v=o1");
});

test("a Classifier whose pictures have no key keeps its plain address", async () => {
  await api.classifyState("camA", "pick");
  keys.state = "";
  await api.classifyState("camA", "pick");
  expect(thumbUrl("camA", "a.png", "pick")).not.toContain("&v=");
});
