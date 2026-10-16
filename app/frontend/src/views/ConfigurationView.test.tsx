import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import ConfigurationView from "./ConfigurationView";

const method = (id: string, label: string, tag: string, over: Record<string, unknown> = {}) => ({
  id,
  label,
  tag,
  description: `${label} description`,
  installed: true,
  active: true,
  reason: null,
  ...over,
});

let puts: any[];
let methods: any[];

beforeEach(() => {
  puts = [];
  methods = [method("cpu", "CPU", "CPU"), method("resnet18", "ResNet18", "R18"), method("resnet50", "ResNet50", "R50")];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/config/methods" && init?.method === "PUT") {
        const body = JSON.parse(init.body as string);
        puts.push(body);
        methods = methods.map((m) => ({ ...m, active: body.active.includes(m.id) }));
      }
      if (url === "/api/config/methods")
        return new Response(JSON.stringify({ methods, device: "cpu", device_label: "CPU" }), { status: 200 });
      return new Response("{}", { status: 404 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

test("lists the three methods, all ticked", async () => {
  render(<ConfigurationView />);
  for (const name of ["CPU", "ResNet18", "ResNet50"]) expect(await screen.findByRole("checkbox", { name })).toBeChecked();
});

test("unticking a method saves the remaining ones and says it is off", async () => {
  render(<ConfigurationView />);
  await userEvent.click(await screen.findByRole("checkbox", { name: "CPU" }));
  await waitFor(() => expect(puts).toEqual([{ active: ["resnet18", "resnet50"] }]));
  expect(await screen.findByText(/Switched off/)).toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: "CPU" })).not.toBeChecked();
});

test("switching a method back on tells the user to refresh scores", async () => {
  methods[0].active = false;
  render(<ConfigurationView />);
  await userEvent.click(await screen.findByRole("checkbox", { name: "CPU" }));
  await waitFor(() => expect(puts).toEqual([{ active: ["resnet18", "resnet50", "cpu"] }]));
  expect(await screen.findByText(/Refresh scores/, { selector: "p[role=status]" })).toBeInTheDocument();
});

test("the last active method cannot be switched off", async () => {
  methods[0].active = false;
  methods[1].active = false;
  render(<ConfigurationView />);
  expect(await screen.findByRole("checkbox", { name: "ResNet50" })).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: "CPU" })).toBeEnabled();
});

test("a method that is not installed is disabled and explains why", async () => {
  methods[2] = method("resnet50", "ResNet50", "R50", { installed: false, active: false, reason: "weights not found" });
  render(<ConfigurationView />);
  expect(await screen.findByRole("checkbox", { name: "ResNet50" })).toBeDisabled();
  expect(screen.getByText(/weights not found/)).toBeInTheDocument();
});
