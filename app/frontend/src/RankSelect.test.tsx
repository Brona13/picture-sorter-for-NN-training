import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { MethodInfo } from "./api";
import RankSelect from "./RankSelect";
import { defaultRank } from "./RankContext";

const method = (id: string, label: string, over: Partial<MethodInfo> = {}): MethodInfo => ({ id, label, tag: id, description: "", installed: true, active: true, reason: null, ...over });
const all = [method("cpu", "Classical (CPU)"), method("resnet18", "ResNet 18"), method("resnet50", "ResNet 50")];

test("offers the methods in use by their names and shows ResNet 50 when nothing was chosen", () => {
  render(<RankSelect methods={all} value="" onChange={() => {}} />);
  const select = screen.getByLabelText("Rank using");
  expect(select).toHaveValue("resnet50");
  expect(Array.from(select.querySelectorAll("option")).map((o) => o.textContent)).toEqual(["Classical (CPU)", "ResNet 18", "ResNet 50"]);
});

test("reports the chosen method's id", async () => {
  const onChange = vi.fn();
  render(<RankSelect methods={all} value="resnet50" onChange={onChange} />);
  await userEvent.selectOptions(screen.getByLabelText("Rank using"), "cpu");
  expect(onChange).toHaveBeenCalledWith("cpu");
});

test("methods that are switched off or not installed are not offered", () => {
  render(<RankSelect methods={[all[0], method("resnet18", "ResNet 18", { active: false }), method("resnet50", "ResNet 50", { installed: false, active: false })]} value="" onChange={() => {}} />);
  expect(screen.queryByLabelText("Rank using")).toBeNull(); // only one is left: nothing to choose
});

test("a saved choice that is no longer in use falls back to the default", () => {
  render(<RankSelect methods={[all[0], all[2]]} value="resnet18" onChange={() => {}} />);
  expect(screen.getByLabelText("Rank using")).toHaveValue("resnet50");
});

test("the default rule is the server's: ResNet 50 if in use, else the first", () => {
  expect(defaultRank(["cpu", "resnet18", "resnet50"])).toBe("resnet50");
  expect(defaultRank(["cpu", "resnet18"])).toBe("cpu");
  expect(defaultRank([])).toBe("");
});
