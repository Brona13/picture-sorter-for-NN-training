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
  const sections = within(screen.getByRole("navigation", { name: "Sections" }));
  for (const label of ["Overview", "Management", "Manipulation", "Export"]) {
    expect(sections.getByRole("link", { name: label })).toBeInTheDocument();
  }
  // Configuration is a separate button after the four sections
  const links = sections.getAllByRole("link");
  expect(links[links.length - 1]).toHaveAccessibleName("Configuration");
  // the Overview section has its own second-level bar: Overview and Status
  const overviewTools = within(screen.getByRole("navigation", { name: "Overview tools" }));
  expect(overviewTools.getByRole("link", { name: /Status/ })).toBeInTheDocument();
});

test("Manipulation opens a second-level bar with the tools, ROI editor among them, and remembers the last tool", async () => {
  render(
    <MemoryRouter>
      <App />
    </MemoryRouter>,
  );
  await screen.findByRole("heading", { name: "Overview" });
  const sections = within(screen.getByRole("navigation", { name: "Sections" }));
  expect(screen.queryByRole("navigation", { name: "Manipulation tools" })).toBeNull();
  await userEvent.click(sections.getByRole("link", { name: "Manipulation" }));
  const tools = within(await screen.findByRole("navigation", { name: "Manipulation tools" }));
  for (const label of ["Scatter", "Clusters", "Outliers", "ROI editor", "Detector", "Edge angle", "Classify", "Insights", "Verdict", "Augmentation"]) {
    expect(tools.getByRole("link", { name: new RegExp(label) })).toBeInTheDocument();
  }
  await userEvent.click(tools.getByRole("link", { name: /Classify/ }));
  expect(tools.getByRole("link", { name: /Classify/ })).toHaveAttribute("aria-current", "page");
  expect(sections.getByRole("link", { name: "Manipulation" })).toHaveAttribute("aria-current", "page");
  // Export is another section; coming back to Manipulation returns to Classify
  await userEvent.click(sections.getByRole("link", { name: "Export" }));
  expect(screen.queryByRole("navigation", { name: "Manipulation tools" })).toBeNull();
  await userEvent.click(sections.getByRole("link", { name: "Manipulation" }));
  expect(within(await screen.findByRole("navigation", { name: "Manipulation tools" })).getByRole("link", { name: /Classify/ })).toHaveAttribute("aria-current", "page");
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

test("remembers the last camera and product across a reload, and lands on the last page from the root", async () => {
  const first = render(
    <MemoryRouter initialEntries={["/classify"]}>
      <App />
    </MemoryRouter>,
  );
  await screen.findByLabelText("Product");
  await userEvent.selectOptions(screen.getByLabelText("Product"), "P2");
  first.unmount();

  render(
    <MemoryRouter initialEntries={["/"]}>
      <App />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByLabelText("Product")).toHaveValue("P2"));
  expect(screen.getByLabelText("Camera")).toHaveValue("camA");
  expect(screen.getByRole("link", { name: /Classify/ })).toHaveAttribute("aria-current", "page");
});

test("a remembered camera that no longer exists falls back to the first one", async () => {
  localStorage.setItem("picturesorter.camera", "gone");
  render(
    <MemoryRouter>
      <App />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByLabelText("Camera")).toHaveValue("camA"));
});

test("the status bar holds the hardware badge and the version; the top bar has an icon-only Configuration link", async () => {
  mockFetch({
    "/api/version": { version: "1.2.3", released: "2026-10-16" },
    "/api/device": { kind: "amd", label: "AMD GPU", name: "AMD Radeon RX 7800 XT", api: "ROCm", hint: "" },
    "/api/cameras": [],
  });
  render(
    <MemoryRouter>
      <App />
    </MemoryRouter>,
  );
  const badge = await screen.findByTestId("hardware-badge");
  const bar = badge.closest("footer") as HTMLElement;
  expect(bar).toHaveClass("statusbar");
  expect(within(bar).getByText("v1.2.3 · 2026-10-16")).toBeInTheDocument();
  const config = within(screen.getByRole("navigation", { name: "Sections" })).getByRole("link", { name: "Configuration" });
  expect(config).toHaveTextContent(/^\S{1,3}$/); // the icon only, no words
});

test("the status bar names the camera and product being worked on", async () => {
  render(
    <MemoryRouter>
      <App />
    </MemoryRouter>,
  );
  await screen.findByLabelText("Product");
  await userEvent.selectOptions(screen.getByLabelText("Product"), "P2");
  expect(screen.getByTestId("status-where")).toHaveTextContent("camA › P2");
});

test("/dedup goes to the Scatter tool, and the Duplicates tools sit under a group label", async () => {
  render(
    <MemoryRouter initialEntries={["/dedup"]}>
      <App />
    </MemoryRouter>,
  );
  const tools = await screen.findByRole("navigation", { name: "Manipulation tools" });
  await waitFor(() => expect(within(tools).getByRole("link", { name: /Scatter/ })).toHaveAttribute("aria-current", "page"));
  expect(within(tools).getByText("Duplicates")).toBeInTheDocument();
  const links = within(tools).getAllByRole("link").map((l) => l.textContent);
  expect(links.slice(0, 3).map((t) => t?.replace(/^[^\p{L}]+/u, ""))).toEqual(["Scatter", "Clusters", "Outliers"]);
});

test("clicking the cogwheel again on Configuration goes back to the page you came from", async () => {
  render(
    <MemoryRouter initialEntries={["/classify"]}>
      <App />
    </MemoryRouter>,
  );
  await screen.findByLabelText("Product");
  const cog = screen.getByRole("link", { name: "Configuration" });
  await userEvent.click(cog);
  expect(await screen.findByRole("heading", { name: /Configuration/ })).toBeInTheDocument();
  await userEvent.click(cog);
  await waitFor(() => expect(within(screen.getByRole("navigation", { name: "Manipulation tools" })).getByRole("link", { name: /Classify/ })).toHaveAttribute("aria-current", "page"));
});

test("the product picker is in the top bar on every page, Dedup included, and the choice follows you", async () => {
  render(
    <MemoryRouter initialEntries={["/dedup"]}>
      <App />
    </MemoryRouter>,
  );
  const panel = await screen.findByRole("complementary", { name: "Options" });
  const bar = within(screen.getByRole("navigation", { name: "Sections" }));
  const select = await bar.findByLabelText("Product");
  expect(within(panel).queryByLabelText("Product")).toBeNull();
  await userEvent.selectOptions(select, "P2");
  await userEvent.click(within(screen.getByRole("navigation", { name: "Manipulation tools" })).getByRole("link", { name: /Classify/ }));
  await waitFor(() => expect(bar.getByLabelText("Product")).toHaveValue("P2"));
});

test("tool icons are muted until the tool has left a trace on the camera, and colorful after", async () => {
  mockFetch({
    "/api/cameras": ["camA"],
    "/api/cameras/camA/products": [],
    "/api/cameras/camA/tools-used": { "dedup/scatter": false, "dedup/clusters": true, classify: true, roi: false },
  });
  render(
    <MemoryRouter initialEntries={["/classify"]}>
      <App />
    </MemoryRouter>,
  );
  const used = async (id: string) => (await screen.findByTestId(`tool-icon-${id}`)).getAttribute("data-used");
  await waitFor(async () => expect(await used("clusters")).toBe("true"));
  expect(await used("classify")).toBe("true");
  expect(await used("scatter")).toBe("false");
  expect(await used("roi")).toBe("false");
  expect(await used("detector")).toBe("false"); // a tracked tool the answer does not mention is unused
  expect(screen.getByRole("link", { name: /Clusters/ })).toHaveAttribute("title", "Clusters — used on this camera");
  expect(screen.getByRole("link", { name: /Scatter/ })).toHaveAttribute("title", "Scatter — not used on this camera yet");
});

test("a page with no state to show (Overview, Status) always has a colorful icon", async () => {
  render(
    <MemoryRouter initialEntries={["/overview"]}>
      <App />
    </MemoryRouter>,
  );
  expect((await screen.findByTestId("tool-icon-overview")).getAttribute("data-used")).toBe("true");
  expect((await screen.findByTestId("tool-icon-status")).getAttribute("data-used")).toBe("true");
});

test("a renamed product stays the selected one, and a renamed product's ROI stays the selected ROI", async () => {
  render(
    <MemoryRouter initialEntries={["/classify"]}>
      <App />
    </MemoryRouter>,
  );
  await screen.findByLabelText("Product");
  await userEvent.selectOptions(screen.getByLabelText("Product"), "P2");
  await waitFor(() => expect(localStorage.getItem("picturesorter.product.camA")).toBe("P2"));
  localStorage.setItem("picturesorter.feature.camA", "P2::rod");
  // the server now has the product under its new name
  mockFetch({
    "/api/cameras": ["camA", "camB"],
    "/api/cameras/camA/products": ["P1", "Beta"],
    "/api/cameras/camB/products": [],
  });
  window.dispatchEvent(new Event("picturesorter:changed")); // the save itself
  window.dispatchEvent(new CustomEvent("picturesorter:products-renamed", { detail: { P2: "Beta" } }));
  await waitFor(() => expect(screen.getByLabelText("Product")).toHaveValue("Beta"));
  expect(localStorage.getItem("picturesorter.product.camA")).toBe("Beta");
  expect(localStorage.getItem("picturesorter.feature.camA")).toBe("Beta::rod");
});

test("the product list in the top bar follows a change made elsewhere", async () => {
  render(
    <MemoryRouter initialEntries={["/classify"]}>
      <App />
    </MemoryRouter>,
  );
  const select = await screen.findByLabelText("Product");
  expect(within(select).queryByRole("option", { name: "P3" })).toBeNull();
  mockFetch({
    "/api/cameras": ["camA", "camB"],
    "/api/cameras/camA/products": ["P1", "P2", "P3"],
    "/api/cameras/camB/products": [],
  });
  window.dispatchEvent(new Event("picturesorter:changed"));
  expect(await within(screen.getByLabelText("Product")).findByRole("option", { name: "P3" })).toBeInTheDocument();
});
