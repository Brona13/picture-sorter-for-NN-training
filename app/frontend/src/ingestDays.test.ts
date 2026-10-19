import { expect, test } from "vitest";
import { dayOf, daysOf, inPeriod } from "./ingestDays";

const at = (iso: string) => new Date(iso).getTime() / 1000;
const f = (frame: string, iso: string) => ({ frame, name: frame, created: at(iso) });

test("days are counted newest first, in local calendar days", () => {
  const frames = [f("a", "2026-10-17T10:00:00"), f("b", "2026-10-19T08:00:00"), f("c", "2026-10-19T23:59:00")];
  expect(daysOf(frames)).toEqual([{ day: "2026-10-19", count: 2 }, { day: "2026-10-17", count: 1 }]);
  expect(dayOf(at("2026-01-05T00:30:00"))).toBe("2026-01-05");
});

test("periods: all, today, the last seven days, and one day", () => {
  const now = new Date("2026-10-19T12:00:00");
  const today = f("t", "2026-10-19T01:00:00");
  const sixAgo = f("s", "2026-10-13T20:00:00");
  const sevenAgo = f("o", "2026-10-12T20:00:00");
  expect([today, sixAgo, sevenAgo].map((x) => inPeriod(x, "all", now))).toEqual([true, true, true]);
  expect([today, sixAgo, sevenAgo].map((x) => inPeriod(x, "today", now))).toEqual([true, false, false]);
  expect([today, sixAgo, sevenAgo].map((x) => inPeriod(x, "7d", now))).toEqual([true, true, false]);
  expect([today, sixAgo, sevenAgo].map((x) => inPeriod(x, "day:2026-10-13", now))).toEqual([false, true, false]);
});
