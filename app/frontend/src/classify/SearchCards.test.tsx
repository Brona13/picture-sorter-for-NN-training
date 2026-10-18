import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { CardData } from "../api";
import Card from "./Card";
import FrameViewer from "./FrameViewer";
import { ProductRow, SearchNote, ShowAgain } from "./SearchExtras";

const base = (over: Partial<CardData> = {}): CardData => ({
  frame: "blue_0.png", label: null, golden: null, deleted: false, leanings: {}, bars: null, cluster: null, ...over,
});

const renderCard = (card: CardData, props: Record<string, unknown> = {}) => {
  const handlers = { onLabel: vi.fn(), onGolden: vi.fn(), onDelete: vi.fn(), onRestore: vi.fn() };
  render(
    <ul>
      <Card camera="camA" feature="seal" classes={["OK", "NG"]} methods={[]} card={card} busy={false} {...handlers} {...props} />
    </ul>,
  );
  return handlers;
};

test("a normal card has the usual thin frame and no hint", () => {
  renderCard(base());
  const li = screen.getByTestId("card-blue_0.png");
  expect(li).toHaveStyle({ border: "1px solid #ccc" });
  expect(li).not.toHaveAttribute("title");
});

test("a picture outside the ROI's scope gets a red frame and a hint with its product, and its labels are locked", async () => {
  const h = renderCard(base({ outside: true, product: "B" }));
  const li = screen.getByTestId("card-blue_0.png");
  expect(li).toHaveStyle({ border: "2px solid #c62828" });
  expect(li).toHaveAttribute("title", expect.stringContaining("In product B, so outside this ROI"));
  expect(screen.getByRole("button", { name: /OK/ })).toBeDisabled();
  expect(screen.getByRole("button", { name: /NG/ })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Make golden" })).toBeDisabled();
  fireEvent.mouseEnter(li);
  fireEvent.keyDown(window, { key: "1" });
  expect(h.onLabel).not.toHaveBeenCalled();
});

test("outside with no product yet says that", () => {
  renderCard(base({ outside: true, product: null }));
  expect(screen.getByTestId("card-blue_0.png")).toHaveAttribute("title", expect.stringContaining("No product yet"));
});

test("a muted picture gets a dark grey dashed frame and a hint; its labels still work", () => {
  renderCard(base({ muted: true }));
  const li = screen.getByTestId("card-blue_0.png");
  expect(li).toHaveStyle({ border: "2px dashed #555" });
  expect(li).toHaveAttribute("title", expect.stringContaining("Muted for this ROI"));
  expect(screen.getByRole("button", { name: /OK/ })).toBeEnabled();
});

test("outside beats muted, and a deleted picture outside its scope can still be restored or deleted", async () => {
  const h = renderCard(base({ outside: true, muted: true, deleted: true }));
  expect(screen.getByTestId("card-blue_0.png")).toHaveStyle({ border: "2px solid #c62828" });
  await userEvent.click(screen.getByRole("button", { name: "Restore frame" }));
  expect(h.onRestore).toHaveBeenCalled();
});

// --- what the viewer adds ---
const info = { query: "blue", classify_feature: "type", product_classes: ["A", "B"] };
const renderProduct = (card: CardData, productRow = true) => {
  const h = { onProduct: vi.fn() };
  const view = render(<ProductRow card={card} search={info} productRow={productRow} busy={false} {...h} />);
  return { ...h, ...view };
};
test("in a feature ROI every found picture shows which product it is in, outside the scope or not, and the product can be changed", async () => {
  for (const outside of [false, true]) {
    const { onProduct, unmount } = renderProduct(base({ outside, product: "A" }));
    const group = screen.getByRole("group", { name: "Product" });
    expect(within(group).getByRole("button", { name: "A" })).toHaveAttribute("aria-pressed", "true");
    expect(within(group).getByRole("button", { name: "B" })).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(within(group).getByRole("button", { name: "B" }));
    expect(onProduct).toHaveBeenCalledWith("B");
    await userEvent.click(within(group).getByRole("button", { name: "A" }));
    expect(onProduct).toHaveBeenLastCalledWith(null); // pressing the current product removes it
    unmount();
  }
});

test("a picture with no product says so (inside the scope, a whole-camera ROI covers such pictures)", () => {
  renderProduct(base({ outside: false, product: null }));
  expect(screen.getByText("no product yet")).toBeInTheDocument();
  for (const name of ["A", "B"]) expect(within(screen.getByRole("group", { name: "Product" })).getByRole("button", { name })).toHaveAttribute("aria-pressed", "false");
});

test("in the product-sorting ROI itself there is no Product row", () => {
  const { container } = renderProduct(base(), false);
  expect(container).toBeEmptyDOMElement();
});

test("a deleted picture has no Product row: it is restored first", () => {
  const { container } = renderProduct(base({ outside: true, deleted: true }));
  expect(container).toBeEmptyDOMElement();
});

test("a muted picture gets a Show again button, which unmutes it; there is no button to mute one", async () => {
  const onUnmute = vi.fn();
  render(<ShowAgain card={base({ muted: true })} busy={false} onUnmute={onUnmute} />);
  await userEvent.click(screen.getByRole("button", { name: "Show again" }));
  expect(onUnmute).toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: /^Mute$/ })).toBeNull();
});

test("a picture that is not muted, or is deleted, has no Show again button", () => {
  for (const card of [base(), base({ muted: true, deleted: true })]) {
    const { container, unmount } = render(<ShowAgain card={card} busy={false} onUnmute={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
    unmount();
  }
});

test("the zoom-line note names the product of a picture outside the scope, in red, on one line", () => {
  render(<SearchNote card={base({ outside: true, product: "B" })} />);
  const note = screen.getByTestId("search-note");
  expect(note).toHaveTextContent("Outside this ROI: in product B. Set its product first.");
  expect(note).toHaveStyle({ color: "#c62828" });
  expect(note).toHaveAttribute("title", expect.stringContaining("OK / NG buttons unlock"));
});

test("no product yet is said in the note", () => {
  render(<SearchNote card={base({ outside: true, product: null })} />);
  expect(screen.getByTestId("search-note")).toHaveTextContent("no product yet");
});

test("a muted picture says it was hidden by duplicate removal; both can be said together", () => {
  const { unmount } = render(<SearchNote card={base({ muted: true })} />);
  expect(screen.getByTestId("search-note")).toHaveTextContent("Hidden by duplicate removal.");
  unmount();
  render(<SearchNote card={base({ muted: true, outside: true, product: "B" })} />);
  expect(screen.getByTestId("search-note")).toHaveTextContent("Outside this ROI: in product B. Set its product first. Hidden by duplicate removal.");
});

test("a picture inside the scope that is not muted has no note, and neither has a deleted one", () => {
  for (const card of [base({ outside: false, product: "A" }), base({ outside: true, deleted: true })]) {
    const { container, unmount } = render(<SearchNote card={card} />);
    expect(container).toBeEmptyDOMElement();
    unmount();
  }
});

// --- the viewer ---
function renderViewer(over: Record<string, unknown> = {}) {
  const h = { onLabel: vi.fn(), onGolden: vi.fn(), onDelete: vi.fn(), onRestore: vi.fn(), onClose: vi.fn() };
  render(
    <FrameViewer
      camera="camA"
      feature="seal"
      frames={["a.png", "b.png"]}
      start="a.png"
      classes={["OK", "NG"]}
      marks={() => ({ label: null, golden: null })}
      busy={false}
      {...h}
      {...over}
    />,
  );
  return h;
}

test("in the viewer a locked picture's label buttons and keys do nothing, but Delete still works", () => {
  const h = renderViewer({ labelsLocked: (f: string) => f === "a.png" });
  const labels = screen.getByRole("group", { name: "Label" });
  expect(within(labels).getByRole("button", { name: /OK/ })).toBeDisabled();
  expect(within(labels).getByRole("button", { name: "Make golden" })).toBeDisabled();
  fireEvent.keyDown(window, { key: "1" });
  expect(h.onLabel).not.toHaveBeenCalled();
  fireEvent.keyDown(window, { key: "Delete" });
  expect(h.onDelete).toHaveBeenCalledWith("a.png");
});

test("browsing to an unlocked picture unlocks the labels again", () => {
  const h = renderViewer({ labelsLocked: (f: string) => f === "a.png" });
  fireEvent.keyDown(window, { key: "ArrowRight" });
  expect(within(screen.getByRole("group", { name: "Label" })).getByRole("button", { name: /OK/ })).toBeEnabled();
  fireEvent.keyDown(window, { key: "1" });
  expect(h.onLabel).toHaveBeenCalledWith("b.png", "OK");
});

test("the viewer asks for the lead and the trail of the picture on screen, so they follow when browsing", () => {
  renderViewer({ lead: (f: string) => <div role="group" aria-label="Product">{`lead ${f}`}</div>, trail: (f: string) => <span data-testid="trail">{`trail ${f}`}</span> });
  expect(screen.getByRole("group", { name: "Product" })).toHaveTextContent("lead a.png");
  expect(screen.getByTestId("trail")).toHaveTextContent("trail a.png");
  fireEvent.keyDown(window, { key: "ArrowRight" });
  expect(screen.getByRole("group", { name: "Product" })).toHaveTextContent("lead b.png");
  expect(screen.getByTestId("trail")).toHaveTextContent("trail b.png");
});

test("the viewer puts the lead (the Product buttons) first on the label line, then the OK / NG buttons, in one row", () => {
  renderViewer({ lead: () => <div role="group" aria-label="Product"><button>A</button><button>B</button></div> });
  const product = screen.getByRole("group", { name: "Product" });
  const labels = screen.getByRole("group", { name: "Label" });
  expect(product.parentElement).toBe(labels.parentElement); // one line
  const row = Array.from((labels.parentElement as HTMLElement).children);
  expect(row.indexOf(product)).toBeLessThan(row.indexOf(labels)); // product first, then the feature's buttons
});

test("the Feature caption starts the feature's buttons when the Product row precedes them", () => {
  renderViewer({ lead: () => <div role="group" aria-label="Product" />, leadCaption: () => "Feature" });
  expect(within(screen.getByRole("group", { name: "Label" })).getByText("Feature")).toBeInTheDocument();
});

test("with no Product row there is no caption", () => {
  renderViewer({ leadCaption: () => null });
  expect(screen.queryByText("Feature")).toBeNull();
});

test("the trail (Show again) ends the label line, after the golden star", () => {
  renderViewer({ trail: () => <button>Show again</button> });
  const labels = screen.getByRole("group", { name: "Label" });
  const row = Array.from(labels.children);
  expect(row.at(-1)).toHaveTextContent("Show again");
  expect(within(labels).getByRole("button", { name: "Make golden" })).toBeInTheDocument();
});

test("the note goes on the zoom line above the picture and the viewer has no second row under the label line", () => {
  renderViewer({ note: () => <span data-testid="the-note">hello</span>, lead: () => <div role="group" aria-label="Product" /> });
  const note = screen.getByTestId("the-note");
  const percent = screen.getByTestId("zoom-level");
  expect(note.parentElement!.parentElement).toBe(percent.parentElement); // on the zoom controls line
  const labels = screen.getByRole("group", { name: "Label" });
  expect(labels.parentElement!.parentElement!.children).toHaveLength(1); // nothing is stacked under the label line
});
