import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import Card from "./Card";
import FrameViewer from "./FrameViewer";
import { endPaint } from "./paint";

afterEach(endPaint);

const base = { golden: null, leanings: {}, bars: null, cluster: null };

/** A row of cards: `state` gives each frame's deleted flag (and an optional label); Delete and its sweep call onDelete / onRestore. */
function row(state: Record<string, boolean | { deleted: boolean; label?: string; golden?: string }>, canRestore = true) {
  const calls: string[] = [];
  render(
    <ul>
      {Object.entries(state).map(([frame, v]) => {
        const o = typeof v === "boolean" ? { deleted: v } : v;
        return (
          <Card
            key={frame}
            camera="c"
            feature="f"
            classes={["OK", "NG"]}
            methods={[]}
            card={{ frame, ...base, label: o.label ?? null, golden: o.golden ?? null, deleted: o.deleted }}
            busy={false}
            canRestore={canRestore}
            onLabel={() => {}}
            onGolden={() => {}}
            onDelete={() => calls.push(`del ${frame}`)}
            onRestore={() => calls.push(`res ${frame}`)}
          />
        );
      })}
    </ul>,
  );
  return calls;
}

const move = (frame: string) => fireEvent.mouseMove(screen.getByTestId(`card-${frame}`), { movementX: 5, movementY: 2 });
const pressDeleteOn = (frame: string) => {
  fireEvent.mouseEnter(screen.getByTestId(`card-${frame}`));
  fireEvent.keyDown(window, { key: "Delete" });
};

test("Delete on a deleted card restores it, on a normal card deletes it", () => {
  const calls = row({ a: true, b: false });
  pressDeleteOn("a");
  fireEvent.mouseLeave(screen.getByTestId("card-a"));
  pressDeleteOn("b");
  expect(calls).toEqual(["res a", "del b"]);
});

test("a sweep that starts on a normal card deletes normal cards and leaves deleted ones alone", () => {
  const calls = row({ a: false, b: false, c: true, d: false });
  pressDeleteOn("a");
  for (const f of ["b", "c", "d"]) move(f);
  expect(calls).toEqual(["del a", "del b", "del d"]);
});

test("a sweep that starts on a deleted card restores deleted cards and leaves normal ones alone", () => {
  const calls = row({ a: true, b: true, c: false, d: true });
  pressDeleteOn("a");
  for (const f of ["b", "c", "d"]) move(f);
  expect(calls).toEqual(["res a", "res b", "res d"]);
});

test("a delete sweep still never deletes labeled or golden cards, but restoring has no such limit", () => {
  const del = row({ a: false, b: { deleted: false, label: "OK" }, c: { deleted: false, label: "OK", golden: "OK" }, d: false });
  pressDeleteOn("a");
  for (const f of ["b", "c", "d"]) move(f);
  expect(del).toEqual(["del a", "del d"]);
});

test("a restore sweep restores a deleted card even when it carries a label", () => {
  const calls = row({ a: true, b: { deleted: true, label: "OK" } });
  pressDeleteOn("a");
  move("b");
  expect(calls).toEqual(["res a", "res b"]);
});

test("where a deleted card cannot be restored, Delete and the sweep leave it alone", () => {
  const calls = row({ a: true, b: true }, false);
  pressDeleteOn("a");
  move("b");
  expect(calls).toEqual([]);
});

test("the viewer: Delete on a deleted picture restores it, on a normal one deletes it", () => {
  const onDelete = vi.fn();
  const onRestore = vi.fn();
  const mk = (deleted: boolean) => (
    <FrameViewer camera="c" feature="f" frames={["a.png"]} start="a.png" classes={["OK"]} marks={() => ({ label: null, golden: null })} busy={false} onLabel={() => {}} onGolden={() => {}} onDelete={onDelete} onRestore={onRestore} deleted={() => deleted} onClose={() => {}} />
  );
  const { rerender } = render(mk(true));
  fireEvent.keyDown(window, { key: "Delete" });
  expect(onRestore).toHaveBeenCalledWith("a.png");
  expect(onDelete).not.toHaveBeenCalled();
  rerender(mk(false));
  fireEvent.keyDown(window, { key: "Delete" });
  expect(onDelete).toHaveBeenCalledWith("a.png");
});
