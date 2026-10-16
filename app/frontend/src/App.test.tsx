import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "./App";

function mockFetch(routes: Record<string, unknown>, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = routes[url];
      if (body === undefined) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify(body), { status });
    }),
  );
}

beforeEach(() => {
  mockFetch({
    "/api/cameras": ["camA", "camB"],
    "/api/overview": { cameras: [] },
    "/api/cameras/camA/products": ["P1", "P2"],
    "/api/cameras/camB/products": [],
    "/api/cameras/camA/status": {
      camera: "camA",
      frame_count: 0,
      feature_count: 0,
      products: ["P1", "P2"],
      features: [],
    },
    "/api/cameras/camB/status": {
      camera: "camB",
      frame_count: 0,
      feature_count: 0,
      products: [],
      features: [],
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

test("shows cameras, products and view navigation; redirects to Overview", async () => {
  render(
    <MemoryRouter>
      <App />
    </MemoryRouter>,
  );
  expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
  await waitFor(() => expect(screen.getByLabelText("Camera")).toHaveValue("camA"));
  expect(await screen.findByLabelText("Product")).toBeInTheDocument();
  for (const label of ["Overview", "Status", "Ingest", "ROI editor", "Classify", "Insights", "Versions", "Dedup"]) {
    expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
  }
  // Configuration is the last link in the sidebar
  const links = screen.getAllByRole("link");
  expect(links[links.length - 1]).toHaveAccessibleName("Configuration");
});

test("shows the app version and release date", async () => {
  mockFetch({
    "/api/version": { version: "0.3.1", released: "2026-10-14" },
    "/api/cameras": [],
  });
  render(
    <MemoryRouter>
      <App />
    </MemoryRouter>,
  );
  expect(await screen.findByText("v0.3.1 · 2026-10-14")).toBeInTheDocument();
});

test("hides the product picker for cameras without products", async () => {
  render(
    <MemoryRouter>
      <App />
    </MemoryRouter>,
  );
  await screen.findByLabelText("Product");
  await userEvent.selectOptions(screen.getByLabelText("Camera"), "camB");
  await waitFor(() => expect(screen.queryByLabelText("Product")).toBeNull());
});

test("shows API errors", async () => {
  mockFetch({}, 200);
  render(
    <MemoryRouter>
      <App />
    </MemoryRouter>,
  );
  expect((await screen.findAllByRole("alert")).length).toBeGreaterThan(0);
});

test("a stage clicked on the Overview opens its page on that ROI and product, with the step bar", async () => {
  const roi = (feature: string, owner: string | null) => ({
    feature, short_name: feature.split("::").pop(), owner_product: owner, role: "quality", classes: ["OK", "NG"],
    shared_products: null, x: 0.1, y: 0.1, w: 0.3, h: 0.3, frames_seen: 4, inbox_total: 4, labeled: 1, goldens: 0,
    version_count: 0, active_version: null,
    pipeline: {
      feature, frames: 4, labeled: 1, next: "labeled",
      stages: [
        { id: "roi", label: "ROI", view: "roi", optional: false, status: "done", detail: "" },
        { id: "version", label: "Version", view: "versions", optional: false, status: "todo", detail: "" },
      ],
    },
  });
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      const ok = (b: unknown) => new Response(JSON.stringify(b));
      if (url === "/api/cameras") return ok(["camA", "camB"]);
      if (url === "/api/overview")
        return ok({
          cameras: [
            { camera: "camA", frame_count: 4, picture_frame: null, products: ["P1"], classify_feature: null, rois: [roi("P1::seal", "P1")] },
            { camera: "camB", frame_count: 4, picture_frame: null, products: [], classify_feature: null, rois: [roi("cap", null), roi("ring", null)] },
          ],
        });
      if (url.startsWith("/api/cameras/camA/products")) return ok(["P1"]);
      if (url.startsWith("/api/cameras/camB/products")) return ok([]);
      if (url.includes("/versions/features")) {
        if (url.includes("camB")) return ok([{ feature: "cap", label: "cap" }, { feature: "ring", label: "ring" }]);
        return ok([{ feature: "P1::seal", label: "seal" }]);
      }
      if (url.includes("/pipeline")) {
        const f = decodeURIComponent(new URL(url, "http://x").searchParams.get("feature") ?? "");
        return ok({ ...roi(f, null).pipeline, feature: f });
      }
      if (url.includes("/versions?")) return ok({ feature: "x", classes: ["OK", "NG"], counts: { total: 4 }, versions: [], result_names: [] });
      return new Response("{}", { status: 404 });
    }),
  );
  render(
    <MemoryRouter>
      <App />
    </MemoryRouter>,
  );
  // A ROI of the other camera that is not the first one the Versions page would list.
  const ring = await screen.findByTestId("pipeline-camB-ring");
  await userEvent.click(within(ring).getByTestId("stage-version"));
  expect(await screen.findByRole("heading", { name: /Versions — camB/ })).toBeInTheDocument();
  await waitFor(() => expect(screen.getByLabelText("Camera")).toHaveValue("camB"));
  await waitFor(() => expect((screen.getByLabelText(/Feature \(ROI\)/) as HTMLSelectElement).value).toBe("ring"));
  const bar = await screen.findByTestId("step-bar");
  expect(bar).toHaveTextContent("ring");
  expect(within(bar).getByTestId("stage-version")).toHaveAttribute("aria-current", "step");
  expect(calls).toContain("/api/cameras/camB/pipeline?feature=ring");
});

test("a product-owned ROI opens with its product selected, on this camera and on another", async () => {
  const roi = (feature: string, owner: string | null) => ({
    feature, short_name: feature.split("::").pop(), owner_product: owner, role: "quality", classes: ["OK", "NG"],
    shared_products: null, x: 0.1, y: 0.1, w: 0.3, h: 0.3, frames_seen: 4, inbox_total: 4, labeled: 0, goldens: 0,
    version_count: 0, active_version: null,
    pipeline: {
      feature, frames: 4, labeled: 0, next: "labeled",
      stages: [{ id: "version", label: "Version", view: "versions", optional: false, status: "todo", detail: "" }],
    },
  });
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      const ok = (b: unknown) => new Response(JSON.stringify(b));
      if (url === "/api/cameras") return ok(["camA", "camB"]);
      if (url === "/api/overview")
        return ok({
          cameras: [
            { camera: "camA", frame_count: 4, picture_frame: null, products: ["P1"], classify_feature: null, rois: [roi("P1::seal", "P1")] },
            { camera: "camB", frame_count: 4, picture_frame: null, products: ["Q"], classify_feature: null, rois: [roi("Q::cap", "Q")] },
          ],
        });
      if (url.startsWith("/api/cameras/camA/products")) return ok(["P1"]);
      if (url.startsWith("/api/cameras/camB/products")) return ok(["Q"]);
      if (url.includes("/versions/features")) return ok([{ feature: url.includes("camB") ? "Q::cap" : "P1::seal", label: "x" }]);
      if (url.includes("/pipeline")) return ok(roi("P1::seal", "P1").pipeline);
      if (url.includes("/versions?")) return ok({ feature: "x", classes: ["OK", "NG"], counts: { total: 4 }, versions: [], result_names: [] });
      return new Response("{}", { status: 404 });
    }),
  );
  render(
    <MemoryRouter>
      <App />
    </MemoryRouter>,
  );
  await userEvent.click(within(await screen.findByTestId("pipeline-camA-P1::seal")).getByTestId("stage-version"));
  await waitFor(() => expect(calls).toContain("/api/cameras/camA/versions/features?product=P1"));
  await waitFor(() => expect(screen.getByLabelText("Product")).toHaveValue("P1"));

  await userEvent.click(screen.getByRole("link", { name: "Overview" }));
  await userEvent.click(within(await screen.findByTestId("pipeline-camB-Q::cap")).getByTestId("stage-version"));
  await waitFor(() => expect(calls).toContain("/api/cameras/camB/versions/features?product=Q"));
  await waitFor(() => expect(screen.getByLabelText("Camera")).toHaveValue("camB"));
  await waitFor(() => expect(screen.getByLabelText("Product")).toHaveValue("Q"));
});
