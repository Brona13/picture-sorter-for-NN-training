import type { IngestedFrame } from "./api";

/** The calendar day (in this browser's time zone) a picture was ingested, as yyyy-mm-dd. */
export function dayOf(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

export const timeOf = (epochSeconds: number): string => {
  const d = new Date(epochSeconds * 1000);
  return `${dayOf(epochSeconds)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** Days that have pictures, newest first, with how many each. */
export function daysOf(frames: IngestedFrame[]): { day: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const f of frames) counts.set(dayOf(f.created), (counts.get(dayOf(f.created)) ?? 0) + 1);
  return [...counts.entries()].map(([day, count]) => ({ day, count })).sort((a, b) => b.day.localeCompare(a.day));
}

/** `all`, `today`, `7d` (today and the six days before) or `day:yyyy-mm-dd`. */
export type Period = "all" | "today" | "7d" | `day:${string}`;

export function inPeriod(f: IngestedFrame, period: Period, now: Date = new Date()): boolean {
  if (period === "all") return true;
  const day = dayOf(f.created);
  if (period === "today") return day === dayOf(now.getTime() / 1000);
  if (period === "7d") return day >= dayOf(now.getTime() / 1000 - 6 * 86400);
  return day === period.slice(4);
}
