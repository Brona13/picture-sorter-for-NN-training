import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import IngestView from "./IngestView";

let calls: { url: string; method: string; body?: unknown }[];
let jobPolls: number;
const at = (iso: string) => new Date(iso).getTime() / 1000;
let framesList: { frame: string; name: string; created: number }[];

beforeEach(() => {
  calls = [];
  jobPolls = 0;
  framesList = [
    { frame: "new.png", name: "cam_0002.png", created: at("2026-10-19T09:30:00") },
    { frame: "mid.png", name: "mid.png", created: at("2026-10-17T09:30:00") },
    { frame: "old.png", name: "old.png", created: at("2026-10-01T09:30:00") },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body });
      if (url.endsWith("/status"))
        return new Response(JSON.stringify({ camera: "camA", frame_count: 7, feature_count: 0, products: [], features: [] }));
      if (url.endsWith("/ingest/frames"))
        return new Response(JSON.stringify({ frames: framesList }));
      if (url.includes("/ingest/upload") || url.includes("/ingest/folder"))
        return new Response(JSON.stringify({ id: "job1", status: "queued", progress: {} }), { status: 202 });
      if (url.includes("/ingest/rebuild"))
        return new Response(JSON.stringify({ id: "job2", status: "queued", progress: {} }), { status: 202 });
      if (url === "/api/jobs/job1") {
        jobPolls += 1;
        return jobPolls < 2
          ? new Response(JSON.stringify({ id: "job1", status: "running", progress: { phase: "hashing", done: 1, total: 2 }, result: null, error: null }))
          : new Response(JSON.stringify({ id: "job1", status: "done", progress: {}, result: { added: 1, skipped: ["dup.png"], errors: ["bad.txt: unsupported file type"] }, error: null }));
      }
      if (url === "/api/jobs/job2")
        return new Response(JSON.stringify({ id: "job2", status: "done", progress: {}, result: { tracked: 5 }, error: null }));
      if (url === "/api/cameras" && init?.method === "POST")
        return new Response(JSON.stringify({ name: "cam-new" }), { status: 201 });
      return new Response("{}", { status: 404 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

test("uploads files, shows progress, then the report", async () => {
  render(<IngestView camera="camA" />);
  expect(await screen.findByText("Frames in this camera: 7")).toBeInTheDocument();
  const file = new File(["x"], "a.png", { type: "image/png" });
  await userEvent.upload(screen.getByLabelText(/Drop or browse/), file);
  await userEvent.click(screen.getByRole("button", { name: /Add frames/ }));

  const upload = calls.find((c) => c.url.includes("/ingest/upload"))!;
  expect(upload.method).toBe("POST");
  expect((upload.body as FormData).getAll("files")).toHaveLength(1);

  expect(await screen.findByText(/Hashing and staging/)).toBeInTheDocument();
  expect(await screen.findByText(/skipped 1 duplicate/, undefined, { timeout: 3000 })).toBeInTheDocument();
  expect(screen.getByText("dup.png", { exact: false })).toBeInTheDocument();
  expect(screen.getByText(/bad.txt: unsupported file type/)).toBeInTheDocument();
});

test("folder import posts the path; empty path is refused client-side", async () => {
  render(<IngestView camera="camA" />);
  await screen.findByText("Frames in this camera: 7");
  await userEvent.click(screen.getByRole("button", { name: "Import folder" }));
  expect(screen.getByText("Enter a folder path.")).toBeInTheDocument();
  expect(calls.some((c) => c.url.includes("/ingest/folder"))).toBe(false);

  await userEvent.type(screen.getByLabelText(/Folder path/), " /data/in ");
  await userEvent.click(screen.getByRole("button", { name: "Import folder" }));
  await waitFor(() => expect(calls.some((c) => c.url.includes("/ingest/folder"))).toBe(true));
  expect(JSON.parse(calls.find((c) => c.url.includes("/ingest/folder"))!.body as string)).toEqual({ path: "/data/in" });
});

test("rebuild catalog reports tracked images; camera creation lives on the Overview page", async () => {
  render(<IngestView camera="camA" />);
  await screen.findByText("Frames in this camera: 7");
  await userEvent.click(screen.getByText("Maintenance"));
  await userEvent.click(screen.getByRole("button", { name: /Rebuild frame catalog/ }));
  expect(await screen.findByText(/Rebuilt catalog: 5 unique image/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Create camera" })).toBeNull();
});

test("the ingested pictures are listed newest first with the date, and can be narrowed to one day", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  render(<IngestView camera="camA" />);
  const cards = await screen.findAllByTestId(/^value-card-/);
  expect(cards.map((c) => c.getAttribute("data-testid"))).toEqual(["value-card-new.png", "value-card-mid.png", "value-card-old.png"]);
  expect(cards[0]).toHaveTextContent("ingested 2026-10-19 09:30");
  expect(cards[0]).toHaveTextContent("was cam_0002.png"); // the name it came in under
  expect(screen.getByRole("option", { name: "2026-10-17 (1)" })).toBeInTheDocument();

  await userEvent.selectOptions(screen.getByLabelText(/Ingested/), "day:2026-10-17");
  expect(screen.getAllByTestId(/^value-card-/).map((c) => c.getAttribute("data-testid"))).toEqual(["value-card-mid.png"]);

  await userEvent.selectOptions(screen.getByLabelText(/Ingested/), "all");
  await userEvent.selectOptions(screen.getByLabelText(/Order/), "old");
  expect(screen.getAllByTestId(/^value-card-/)[0]).toHaveAttribute("data-testid", "value-card-old.png");
});

test("with no pictures the page says so, and the list reloads after an upload finishes", async () => {
  framesList = [];
  render(<IngestView camera="camA" />);
  expect(await screen.findByText(/No pictures yet — add some above/)).toBeInTheDocument();
  expect(calls.filter((c) => c.url.endsWith("/ingest/frames"))).toHaveLength(1);
  await userEvent.upload(screen.getByLabelText(/Drop or browse/), new File(["x"], "a.png", { type: "image/png" }));
  await userEvent.click(screen.getByRole("button", { name: /Add frames/ }));
  await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/ingest/frames")).length).toBeGreaterThan(1), { timeout: 4000 });
});

test("opened from the Chain it has a way back; opened from the menu it does not", async () => {
  const onBack = vi.fn();
  const { unmount } = render(<IngestView camera="camA" onBack={onBack} />);
  await userEvent.click(await screen.findByRole("button", { name: "← Back to chain" }));
  expect(onBack).toHaveBeenCalled();
  unmount();
  render(<IngestView camera="camA" />);
  await screen.findByText("Frames in this camera: 7");
  expect(screen.queryByRole("button", { name: "← Back to chain" })).toBeNull();
});
