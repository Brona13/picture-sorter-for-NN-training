import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, test } from "vitest";
import { FeatureContext, usePublishFeature, useSharedFeature } from "./SharedFeature";

const LIST = [{ feature: "seal" }, { feature: "cap" }];

/** A stand-in for a page with its own ROI selector. */
function Page({ list = LIST }: { list?: { feature: string }[] }) {
  const shared = useSharedFeature();
  const [feature, setFeature] = useState(() => shared.pick(list));
  usePublishFeature(feature, shared.publish);
  return (
    <select aria-label="ROI" value={feature} onChange={(e) => setFeature(e.target.value)}>
      {list.map((f) => (
        <option key={f.feature}>{f.feature}</option>
      ))}
    </select>
  );
}

function Host({ initial, list }: { initial: string; list?: { feature: string }[] }) {
  const [feature, setFeature] = useState(initial);
  return (
    <FeatureContext.Provider value={{ feature, setFeature }}>
      <span data-testid="shared">{feature}</span>
      <Page list={list} />
    </FeatureContext.Provider>
  );
}

test("a page starts on the shared ROI when it offers it", () => {
  render(<Host initial="cap" />);
  expect(screen.getByLabelText("ROI")).toHaveValue("cap");
});

test("otherwise it starts on its first ROI and tells the others", () => {
  render(<Host initial="gone" />);
  expect(screen.getByLabelText("ROI")).toHaveValue("seal");
  expect(screen.getByTestId("shared")).toHaveTextContent("seal");
});

test("changing the page's ROI is published, nothing is published for an empty one", async () => {
  render(<Host initial="" list={[]} />);
  expect(screen.getByTestId("shared")).toHaveTextContent("");
  render(<Host initial="seal" />);
  await userEvent.selectOptions(screen.getAllByLabelText("ROI")[1], "cap");
  expect(screen.getAllByTestId("shared")[1]).toHaveTextContent("cap");
});

test("without any provider a page still manages its own selection", async () => {
  render(<Page />);
  expect(screen.getByLabelText("ROI")).toHaveValue("seal");
  await userEvent.selectOptions(screen.getByLabelText("ROI"), "cap");
  expect(screen.getByLabelText("ROI")).toHaveValue("cap");
});
