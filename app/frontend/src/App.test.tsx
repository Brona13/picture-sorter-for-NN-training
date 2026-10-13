import { render, screen, waitFor } from "@testing-library/react";
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

test("shows cameras, products and view navigation; redirects to Status", async () => {
  render(
    <MemoryRouter>
      <App />
    </MemoryRouter>,
  );
  expect(await screen.findByRole("heading", { name: "Status — camA" })).toBeInTheDocument();
  await waitFor(() => expect(screen.getByLabelText("Camera")).toHaveValue("camA"));
  expect(await screen.findByLabelText("Product")).toBeInTheDocument();
  for (const label of ["Status", "Ingest", "ROI editor", "Classify", "Insights", "Versions", "Dedup"]) {
    expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
  }
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
  expect(await screen.findByRole("alert")).toBeInTheDocument();
});
