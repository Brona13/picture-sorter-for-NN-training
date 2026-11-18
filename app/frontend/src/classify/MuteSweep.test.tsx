import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import Card from "./Card";
import FrameViewer from "./FrameViewer";
import { endPaint } from "./paint";

afterEach(endPaint);

const base = { label: null, golden: null, deleted: false, leanings: {}, bars: null, cluster: null };

/** A row of Dedup cards: `state` says which are muted; M and the M sweep call `onMute(frame)`. */
function row(state: Record<string, boolean>, withMute = true) {
  const onMute = vi.fn();
  render(
    <ul>
      {Object.entries(state).map(([frame, muted]) => (
        <Card
          key={frame}
          camera="c"
          feature="f"
          classes={["OK", "NG"]}
          labeling={false}
          methods={[]}
          card={{ frame, ...base, muted }}
          busy={false}
          onLabel={() => {}}
          onGolden={() => {}}
          onDelete={() => {}}
          onRestore={() => {}}
          onMute={withMute ? () => onMute(frame) : undefined}
        />
      ))}
    </ul>,
  );
  return onMute;
}

const painting = () =>
  document.documentElement.classList.contains("painting") ? decodeURIComponent(document.documentElement.style.getPropertyValue("--paint-cursor")) : null;
const move = (frame: string) => fireEvent.mouseMove(screen.getByTestId(`card-${frame}`), { movementX: 5, movementY: 2 });
const pressMOn = (frame: string) => {
  fireEvent.mouseEnter(screen.getByTestId(`card-${frame}`));
  fireEvent.keyDown(window, { key: "m" });
};

test("a sweep that starts on an unmuted card mutes unmuted cards and leaves muted ones alone", () => {
  const onMute = row({ a: false, b: false, c: true, d: false });
  pressMOn("a"); // the press itself mutes the card under the pointer
  expect(onMute.mock.calls).toEqual([["a"]]);
  expect(painting()).toContain("#111"); // the black circle
  for (const f of ["b", "c", "d"]) move(f);
  expect(onMute.mock.calls).toEqual([["a"], ["b"], ["d"]]); // c was muted already: it keeps its state
  move("a"); // handled in this stroke
  expect(onMute).toHaveBeenCalledTimes(3);
});

test("a sweep that starts on a muted card unmutes muted cards and leaves unmuted ones alone", () => {
  const onMute = row({ a: true, b: true, c: false, d: true });
  pressMOn("a");
  for (const f of ["b", "c", "d"]) move(f);
  expect(onMute.mock.calls).toEqual([["a"], ["b"], ["d"]]);
});

test("with the pointer off the cards when M goes down, the first card entered decides", () => {
  const onMute = row({ a: true, b: false, c: true });
  fireEvent.keyDown(window, { key: "m" });
  for (const f of ["a", "b", "c"]) move(f);
  expect(onMute.mock.calls).toEqual([["a"], ["c"]]); // started on a muted card: unmutes
});

test("the next stroke decides again", () => {
  const onMute = row({ a: false, b: true });
  pressMOn("a");
  fireEvent.keyUp(window, { key: "m" });
  fireEvent.mouseLeave(screen.getByTestId("card-a"));
  onMute.mockClear();
  pressMOn("b"); // a new stroke, started on a muted card
  expect(onMute.mock.calls).toEqual([["b"]]);
  move("a");
  expect(onMute.mock.calls).toEqual([["b"]]); // the unmuted a is not touched by an unmuting stroke
});

test("without a mute handler M neither sweeps nor changes the cursor", () => {
  const onMute = row({ a: false, b: false }, false);
  fireEvent.mouseEnter(screen.getByTestId("card-a"));
  fireEvent.keyDown(window, { key: "m" });
  move("b");
  expect(onMute).not.toHaveBeenCalled();
  expect(painting()).toBeNull();
});

test("a muted card is faded; a deleted card is not, it has the diagonal line", () => {
  render(
    <ul>
      <Card camera="c" feature="f" classes={["OK"]} methods={[]} card={{ frame: "m", ...base, muted: true }} busy={false} onLabel={() => {}} onGolden={() => {}} onDelete={() => {}} onRestore={() => {}} onMute={() => {}} />
      <Card camera="c" feature="f" classes={["OK"]} methods={[]} card={{ frame: "d", ...base, deleted: true }} busy={false} onLabel={() => {}} onGolden={() => {}} onDelete={() => {}} onRestore={() => {}} />
    </ul>,
  );
  expect(screen.getByTestId("card-m").querySelector("img")).toHaveStyle({ opacity: "0.4" });
  expect(screen.queryByTestId("deleted-line-m")).toBeNull();
  expect(screen.getByTestId("card-d").querySelector("img")).toHaveStyle({ opacity: "1" });
  expect(screen.getByTestId("deleted-line-d")).toBeInTheDocument();
});

const viewer = (extra: Record<string, unknown>) =>
  render(
    <FrameViewer camera="c" feature="f" frames={["a.png"]} start="a.png" classes={["OK", "NG"]} marks={() => ({ label: null, golden: null })} busy={false} onLabel={() => {}} onGolden={() => {}} onDelete={() => {}} onClose={() => {}} {...extra} />,
  );

test("the viewer fades a muted picture", () => {
  viewer({ onMute: () => {}, isMuted: () => true });
  expect(screen.getByAltText("a.png")).toHaveStyle({ opacity: "0.4" });
  expect(screen.queryByTestId("viewer-deleted-line")).toBeNull();
});

test("the viewer draws the diagonal line across a deleted picture, and Restore works when the grid allows it", () => {
  const onRestore = vi.fn();
  viewer({ deleted: () => true, onRestore, canRestore: () => true });
  expect(screen.getByTestId("viewer-deleted-line")).toBeInTheDocument();
  expect(screen.getByAltText("a.png")).toHaveStyle({ opacity: "1" });
  fireEvent.click(screen.getByRole("button", { name: "Restore frame" }));
  expect(onRestore).toHaveBeenCalledWith("a.png");
});

test("the viewer's Restore is disabled when the grid cannot restore that picture", () => {
  viewer({ deleted: () => true, onRestore: vi.fn(), canRestore: () => false });
  expect(screen.getByRole("button", { name: "Restore frame" })).toBeDisabled();
});
