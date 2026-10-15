import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import OverviewView from "./OverviewView";

const roi = (feature: string, extra: object = {}) => ({
  feature, short_name: feature, owner_product: null, role: "quality", classes: ["OK", "NG"],
  shared_products: null, x: 0.1, y: 0.2, w: 0.3, h: 0.4, frames_seen: 5, inbox_total: 5,
  labeled: 3, goldens: 1, version_count: 1, active_version: 2, ...extra,
});

function install(cameras: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url === "/api/overview" ? new Response(JSON.stringify({ cameras })) : new Response("{}", { status: 404 }),
    ),
  );
}
afterEach(() => vi.unstubAllGlobals());

const CAMS = [
  { camera: "camA", frame_count: 5, picture_frame: "f1.png", products: ["P1"], classify_feature: null,
    rois: [roi("seal"), roi("label", { role: "classify", x: 0.5 })] },
  { camera: "camB", frame_count: 0, picture_frame: null, products: [], classify_feature: null, rois: [] },
];

test("shows each camera with its picture, ROI boxes and ROI cards", async () => {
  install(CAMS);
  render(<OverviewView camera="camA" onSelectCamera={() => {}} />);
  expect(await screen.findByAltText("camA reference frame")).toHaveAttribute(
    "src", "/api/cameras/camA/frames/f1.png/image");
  expect(screen.getByTestId("box-camA-seal")).toHaveStyle({ left: "10%", width: "30%" });
  const card = screen.getByRole("button", { name: "ROI seal of camA" });
  expect(card).toHaveTextContent("3 labeled · 1 golden · v2");
  expect(screen.getByRole("button", { name: "ROI label of camA" })).toHaveTextContent("classify");
  expect(screen.getByText("No frames yet.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Select camera camA" })).toHaveAttribute("aria-pressed", "true");
});

test("clicking a camera or an ROI selects that camera", async () => {
  install(CAMS);
  const onSelect = vi.fn();
  render(<OverviewView camera="camA" onSelectCamera={onSelect} />);
  await userEvent.click(await screen.findByRole("button", { name: "Select camera camB" }));
  expect(onSelect).toHaveBeenLastCalledWith("camB");
  await userEvent.click(screen.getByRole("button", { name: "ROI seal of camA" }));
  expect(onSelect).toHaveBeenLastCalledWith("camA");
  await waitFor(() => expect(screen.getByRole("button", { name: "ROI seal of camA" })).toHaveAttribute("aria-pressed", "true"));
});
