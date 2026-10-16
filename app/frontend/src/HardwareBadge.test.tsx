import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { DeviceInfo } from "./api";
import HardwareBadge from "./HardwareBadge";

const amd: DeviceInfo = { kind: "amd", label: "AMD GPU", name: "AMD Radeon RX 7800 XT", api: "ROCm", hint: "" };
const nvidia: DeviceInfo = { kind: "nvidia", label: "NVIDIA GPU", name: "NVIDIA GeForce RTX 4070", api: "CUDA", hint: "" };
const cpu: DeviceInfo = { kind: "cpu", label: "CPU", name: "Test CPU 9000", api: "", hint: "" };

test("an AMD card shows its vendor, name and compute API", () => {
  render(<HardwareBadge info={amd} />);
  const b = screen.getByTestId("hardware-badge");
  expect(b).toHaveAttribute("data-kind", "amd");
  expect(b).toHaveTextContent("AMD GPU");
  expect(b).toHaveTextContent("AMD Radeon RX 7800 XT · ROCm");
  expect(screen.getByRole("img", { name: "Graphics card" })).toBeInTheDocument();
});

test("an NVIDIA card is ready too", () => {
  render(<HardwareBadge info={nvidia} />);
  expect(screen.getByTestId("hardware-badge")).toHaveTextContent("NVIDIA GPU");
  expect(screen.getByTestId("hardware-badge")).toHaveTextContent("NVIDIA GeForce RTX 4070 · CUDA");
});

test("no card: a processor symbol, and the hint when a GPU exists but cannot be used", () => {
  const { rerender } = render(<HardwareBadge info={cpu} />);
  expect(screen.getByRole("img", { name: "Processor" })).toBeInTheDocument();
  expect(screen.getByTestId("hardware-badge")).toHaveTextContent("CPU only");
  expect(screen.getByTestId("hardware-badge")).toHaveTextContent("Test CPU 9000");
  rerender(<HardwareBadge info={{ ...cpu, hint: "AMD GPU found, but the CPU-only PyTorch build is installed" }} />);
  expect(screen.getByTestId("hardware-badge")).toHaveTextContent("AMD GPU found");
});

test("a click switches between the three looks and the choice is remembered", async () => {
  const first = render(<HardwareBadge info={amd} />);
  expect(screen.getByTestId("hardware-badge")).toHaveAttribute("data-variant", "card");
  await userEvent.click(screen.getByTestId("hardware-badge"));
  expect(screen.getByTestId("hardware-badge")).toHaveAttribute("data-variant", "chip");
  await userEvent.click(screen.getByTestId("hardware-badge"));
  expect(screen.getByTestId("hardware-badge")).toHaveAttribute("data-variant", "banner");
  first.unmount();
  render(<HardwareBadge info={amd} />);
  expect(screen.getByTestId("hardware-badge")).toHaveAttribute("data-variant", "banner");
  await userEvent.click(screen.getByTestId("hardware-badge"));
  expect(screen.getByTestId("hardware-badge")).toHaveAttribute("data-variant", "card");
});
