import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import InsightsView from "./InsightsView";

const base = {
  feature: "seal",
  classes: ["OK", "NG"],
  methods: ["cpu", "resnet50"],
  goldens_in: ["OK", "NG"],
  evaluable: 6,
  reason: null,
  has_results: false,
  matrices: {},
};

let insights: any;
let calls: string[];

beforeEach(() => {
  calls = [];
  insights = base;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (url.includes("/versions/features")) return ok([{ feature: "seal", label: "seal" }]);
      if (url.includes("/insights")) return ok(insights);
      if (url.endsWith("/classify/refresh")) return ok({ id: "j1", status: "queued", progress: {} }, 202);
      if (url === "/api/jobs/j1") {
        insights = {
          ...base,
          has_results: true,
          matrices: {
            cpu: { matrix: { OK: { OK: 3, NG: 1 }, NG: { OK: 0, NG: 2 } }, skipped: 1, correct: 5, total: 6, accuracy: 83.3333 },
            resnet50: { matrix: { OK: { OK: 4, NG: 0 }, NG: { OK: 0, NG: 2 } }, skipped: 0, correct: 6, total: 6, accuracy: 100 },
          },
        };
        return ok({ id: "j1", status: "done", progress: {}, result: { frames: 8 }, error: null });
      }
      return new Response("{}", { status: 404 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

test("explains why a matrix is not available yet", async () => {
  insights = { ...base, reason: "needs_two_golden_classes", goldens_in: ["OK"] };
  render(<InsightsView camera="camA" />);
  expect(await screen.findByText(/needs goldens in at least two classes/)).toBeInTheDocument();
  expect(screen.getByText("OK")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Compute matrices/ })).toBeNull();

  insights = { ...base, reason: "no_held_out_labels" };
  render(<InsightsView camera="camB" />);
  expect(await screen.findByText(/No held-out labelled frames yet/)).toBeInTheDocument();
});

test("compute runs a refresh job, then renders a matrix per method with accuracy", async () => {
  render(<InsightsView camera="camA" />);
  expect(await screen.findByText(/Click Compute matrices/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /Compute matrices/ }));
  const cpu = await screen.findByTestId("matrix-cpu");
  expect(within(cpu).getByText(/Accuracy/)).toHaveTextContent("Accuracy 83.3% (5/6) · 1 unscored");
  const rows = within(cpu).getAllByRole("row");
  expect(within(rows[1]).getAllByRole("cell").map((c) => c.textContent)).toEqual(["3", "1"]);
  expect(within(screen.getByTestId("matrix-resnet50")).getByText(/100.0%/)).toBeInTheDocument();
  expect(calls.some((c) => c.startsWith("POST") && c.endsWith("/classify/refresh"))).toBe(true);
  await waitFor(() => expect(screen.queryByText(/Computing insight matrices/)).toBeNull());
});
