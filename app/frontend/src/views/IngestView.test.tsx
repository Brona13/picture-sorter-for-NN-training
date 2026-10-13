import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import IngestView from "./IngestView";

let calls: { url: string; method: string; body?: unknown }[];
let jobPolls: number;

beforeEach(() => {
  calls = [];
  jobPolls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body });
      if (url.endsWith("/status"))
        return new Response(JSON.stringify({ camera: "camA", frame_count: 7, feature_count: 0, products: [], features: [] }));
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
  await userEvent.click(screen.getByText(/or import from a folder path/));
  await userEvent.click(screen.getByRole("button", { name: "Import folder" }));
  expect(screen.getByText("Enter a folder path.")).toBeInTheDocument();
  expect(calls.some((c) => c.url.includes("/ingest/folder"))).toBe(false);

  await userEvent.type(screen.getByLabelText("Folder path"), " /data/in ");
  await userEvent.click(screen.getByRole("button", { name: "Import folder" }));
  await waitFor(() => expect(calls.some((c) => c.url.includes("/ingest/folder"))).toBe(true));
  expect(JSON.parse(calls.find((c) => c.url.includes("/ingest/folder"))!.body as string)).toEqual({ path: "/data/in" });
});

test("rebuild catalog reports tracked images; create camera notifies parent", async () => {
  const onCreated = vi.fn();
  render(<IngestView camera="camA" onCameraCreated={onCreated} />);
  await screen.findByText("Frames in this camera: 7");
  await userEvent.click(screen.getByText("Maintenance"));
  await userEvent.click(screen.getByRole("button", { name: /Rebuild frame catalog/ }));
  expect(await screen.findByText(/Rebuilt catalog: 5 unique image/)).toBeInTheDocument();

  await userEvent.type(screen.getByLabelText(/Create a new camera/), "cam new");
  await userEvent.click(screen.getByRole("button", { name: "Create camera" }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith("cam-new"));
});
