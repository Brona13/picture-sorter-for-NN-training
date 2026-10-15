import { useCallback, useEffect, useMemo, useState } from "react";
import { api, DeletedItem, frameImageUrl } from "../api";
import { thumbUrl } from "./Card";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Local calendar day of an epoch-seconds timestamp, as sortable ``YYYY-MM-DD``. */
export function dayKey(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function groupByDay(items: DeletedItem[]): { day: string; items: DeletedItem[] }[] {
  const days = new Map<string, DeletedItem[]>();
  for (const it of items) {
    const k = dayKey(it.deleted_at);
    days.set(k, [...(days.get(k) ?? []), it]);
  }
  return [...days.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([day, list]) => ({ day, items: [...list].sort((a, b) => b.deleted_at - a.deleted_at) }));
}

const dayTitle = (epochSeconds: number) =>
  new Date(epochSeconds * 1000).toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
const timeOf = (epochSeconds: number) => new Date(epochSeconds * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

function NoteField({ value, onSave }: { value: string; onSave: (note: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft.trim() !== value) onSave(draft);
  };
  return (
    <input
      type="text"
      value={draft}
      maxLength={200}
      placeholder="note"
      aria-label="Deletion note"
      style={{ width: "100%", fontSize: 11, boxSizing: "border-box" }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

/**
 * Soft-deleted frames of the camera, one section per day they were deleted, newest first.
 * Each thumbnail opens the full image; notes are editable; frames can be restored one by one,
 * a whole day at a time, or from a ticked selection.
 */
export default function DeletedByDay({
  camera,
  feature,
  revision,
  onChanged,
  onNotice,
  onError,
}: {
  camera: string;
  feature: string;
  revision: number;
  onChanged: () => void;
  onNotice: (m: string) => void;
  onError: (m: string) => void;
}) {
  const [items, setItems] = useState<DeletedItem[] | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [confirmDay, setConfirmDay] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .deletedList(camera, feature)
      .then((r) => setItems(r.items))
      .catch((e: unknown) => onError(msg(e)));
  }, [camera, feature, onError]);

  useEffect(load, [load, revision]);

  const days = useMemo(() => groupByDay(items ?? []), [items]);

  async function restore(frames: string[], what: string) {
    try {
      const r = await api.restoreFrames(camera, feature, frames);
      onNotice(`Restored ${r.restored} frame(s) ${what}. They come back without labels or goldens.`);
      setTicked((t) => new Set([...t].filter((f) => !frames.includes(f))));
      setConfirmDay(null);
      load();
      onChanged();
    } catch (e) {
      onError(msg(e));
    }
  }

  function toggle(frames: string[], on: boolean) {
    setTicked((t) => {
      const next = new Set(t);
      for (const f of frames) (on ? next.add(f) : next.delete(f));
      return next;
    });
  }

  if (items === null) return <p aria-live="polite">Loading deleted frames…</p>;
  if (items.length === 0) return <p>No deleted frames on this camera.</p>;

  return (
    <div data-testid="deleted-by-day">
      <p>
        <strong>{items.length}</strong> deleted frame(s), grouped by the day they were deleted. Deleted frames stay on disk, are left out of Dedup and
        scoring, and are hidden in every ROI of this camera. Click a picture to open it full size.
      </p>
      <p>
        <button type="button" disabled={ticked.size === 0} onClick={() => restore([...ticked], "from the selection")}>
          ↺ Restore selected ({ticked.size})
        </button>{" "}
        {ticked.size > 0 && (
          <button type="button" onClick={() => setTicked(new Set())}>
            Clear selection
          </button>
        )}
      </p>
      {days.map(({ day, items: list }) => {
        const frames = list.map((i) => i.frame);
        const allTicked = frames.every((f) => ticked.has(f));
        return (
          <section key={day} aria-label={`Deleted on ${day}`} style={{ marginBottom: 16 }}>
            <h3 style={{ marginBottom: 4 }}>
              {dayTitle(list[0].deleted_at)} — {list.length} frame(s)
            </h3>
            <p style={{ margin: "0 0 6px" }}>
              <label>
                <input type="checkbox" checked={allTicked} onChange={(e) => toggle(frames, e.target.checked)} /> Select this day
              </label>{" "}
              {confirmDay === day ? (
                <>
                  <button type="button" onClick={() => restore(frames, `deleted on ${day}`)}>
                    Yes — restore all {list.length}
                  </button>{" "}
                  <button type="button" onClick={() => setConfirmDay(null)}>
                    Cancel
                  </button>
                </>
              ) : (
                <button type="button" onClick={() => setConfirmDay(day)}>
                  ↺ Restore whole day
                </button>
              )}
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              {list.map((it) => (
                <figure key={it.frame} style={{ margin: 0, width: 140 }}>
                  <a href={frameImageUrl(camera, it.frame)} target="_blank" rel="noreferrer">
                    <img src={thumbUrl(camera, it.frame, feature)} alt={it.frame} loading="lazy" style={{ width: "100%", display: "block" }} />
                  </a>
                  <figcaption style={{ fontSize: 11 }}>
                    <label>
                      <input type="checkbox" checked={ticked.has(it.frame)} onChange={(e) => toggle([it.frame], e.target.checked)} aria-label={`Select ${it.frame}`} />{" "}
                      {it.frame}
                    </label>
                    <br />
                    {timeOf(it.deleted_at)}{" "}
                    <button type="button" aria-label={`Restore ${it.frame}`} title="Restore this frame" onClick={() => restore([it.frame], "")}>
                      ↺
                    </button>
                    <NoteField
                      value={it.note}
                      onSave={(note) =>
                        api
                          .setDeletedNote(camera, feature, it.frame, note)
                          .then((r) => setItems((cur) => (cur ? cur.map((x) => (x.frame === it.frame ? { ...x, note: r.note } : x)) : cur)))
                          .catch((e: unknown) => onError(msg(e)))
                      }
                    />
                  </figcaption>
                </figure>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
