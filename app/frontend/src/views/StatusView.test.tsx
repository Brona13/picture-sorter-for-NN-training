import { render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import StatusView, { breakdown, scopeOf } from "./StatusView";

const feature = {
  feature: "seal",
  short_name: "seal",
  owner_product: null,
  shared_products: null,
  role: "quality",
  classes: ["OK", "NG"],
  labeled: { OK: 3, NG: 1 },
  goldens: { OK: 1, NG: 0 },
  unlabeled: 5,
  total: 9,
  version_count: 2,
  active_version: 2,
};

function mockStatus(body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body))));
}
afterEach(() => vi.unstubAllGlobals());

test("renders metrics and a feature row", async () => {
  mockStatus({ camera: "camA", frame_count: 9, feature_count: 1, products: [], features: [feature] });
  render(<StatusView camera="camA" />);
  expect(await screen.findByText("Status — camA")).toBeInTheDocument();
  expect(screen.getByText("OK: 3 · NG: 1")).toBeInTheDocument();
  expect(screen.getByText("OK: 1 · NG: 0")).toBeInTheDocument();
  expect(screen.getByText("v2")).toBeInTheDocument();
  expect(screen.getByText("— all")).toBeInTheDocument();
});

test("shows a hint when no ROIs exist", async () => {
  mockStatus({ camera: "camA", frame_count: 0, feature_count: 0, products: [], features: [] });
  render(<StatusView camera="camA" />);
  expect(await screen.findByText(/No ROIs defined yet/)).toBeInTheDocument();
});

test("scope labels", () => {
  expect(scopeOf({ ...feature, role: "classify" })).toBe("(defines products)");
  expect(scopeOf({ ...feature, owner_product: "P1" })).toBe("P1");
  expect(scopeOf({ ...feature, shared_products: ["P1", "P2"] })).toBe("🔗 P1, P2");
  expect(breakdown([], {})).toBe("—");
});
