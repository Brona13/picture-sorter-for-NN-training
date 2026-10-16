import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import Card from "./Card";
import { endPaint } from "./paint";

afterEach(endPaint);

const CLASSES = ["OK", "NG"];
const base = { deleted: false, leanings: {}, bars: null, cluster: null };

function cards(marks: Record<string, { label: string | null; golden: string | null }>) {
  const onLabel = vi.fn();
  render(
    <ul>
      {Object.entries(marks).map(([frame, m]) => (
        <Card
          key={frame}
          camera="c"
          feature="f"
          classes={CLASSES}
          methods={[]}
          card={{ frame, ...m, ...base }}
          busy={false}
          onLabel={(cls) => onLabel(frame, cls)}
          onGolden={() => {}}
          onDelete={() => {}}
          onRestore={() => {}}
        />
      ))}
    </ul>,
  );
  return onLabel;
}

const move = (frame: string) => fireEvent.mouseMove(screen.getByTestId(`card-${frame}`), { movementX: 5, movementY: 2 });

test("holding 1 labels only unlabeled cards; labeled and golden ones are left alone", () => {
  const onLabel = cards({
    a: { label: null, golden: null },
    b: { label: "NG", golden: null },
    c: { label: "OK", golden: "OK" },
    d: { label: null, golden: null },
  });
  fireEvent.keyDown(window, { key: "1" });
  for (const f of ["a", "b", "c", "d"]) move(f);
  expect(onLabel.mock.calls).toEqual([["a", "OK"], ["d", "OK"]]);
  move("a"); // already handled in this stroke
  expect(onLabel).toHaveBeenCalledTimes(2);
  fireEvent.keyUp(window, { key: "1" });
  move("a");
  expect(onLabel).toHaveBeenCalledTimes(2); // key released: no painting
});

test("holding 0 clears labeled non-golden cards only", () => {
  const onLabel = cards({
    a: { label: "OK", golden: null },
    b: { label: null, golden: null },
    c: { label: "NG", golden: "NG" },
  });
  fireEvent.keyDown(window, { key: "0" });
  for (const f of ["a", "b", "c"]) move(f);
  expect(onLabel.mock.calls).toEqual([["a", null]]);
});

test("a move with no pointer movement (a scroll) does not paint, and the cursor takes the class colour", () => {
  const onLabel = cards({ a: { label: null, golden: null } });
  fireEvent.keyDown(window, { key: "2" });
  fireEvent.mouseMove(screen.getByTestId("card-a"), { movementX: 0, movementY: 0 });
  expect(onLabel).not.toHaveBeenCalled();
  expect(decodeURIComponent(document.body.style.cursor)).toContain("#c62828"); // NG is red
  fireEvent.keyUp(window, { key: "2" });
  expect(document.body.style.cursor).toBe("");
});
