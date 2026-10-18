import { useEffect, useRef } from "react";

export interface PagerGrid {
  page: number;
  per_page: number;
  n_pages: number;
  total: number;
}

export interface PagerSettings {
  per_page: number;
  cols: number;
  per_page_options: number[];
  cols_options: number[];
}

/** The pager's search by file name: a magnifying glass, and next to it a text field while it is open. */
export interface PagerSearch {
  open: boolean;
  value: string;
  onOpen: () => void;
  /** Closing also clears the search. */
  onClose: () => void;
  onChange: (value: string) => void;
}

interface PagerProps {
  grid: PagerGrid;
  settings: PagerSettings;
  onPage: (p: number) => void;
  onSettings: (perPage: number, cols: number) => void;
  where: string;
  search?: PagerSearch;
}

export default function Pager({ grid, settings, onPage, onSettings, where, search }: PagerProps) {
  const input = useRef<HTMLInputElement>(null);
  const opened = useRef(false);
  // The field of the pager whose button was pressed takes the focus (the top and the bottom pager share one search).
  useEffect(() => {
    if (search?.open && opened.current) input.current?.focus();
    opened.current = false;
  }, [search?.open]);
  const start = (grid.page - 1) * grid.per_page;
  const end = Math.min(start + grid.per_page, grid.total);
  const atStart = grid.page <= 1;
  const atEnd = grid.page >= grid.n_pages;
  return (
    <div role="navigation" aria-label={`Pagination ${where}`} style={{ display: "flex", gap: 8, alignItems: "center", margin: "8px 0" }}>
      {search && (
        <>
          <button
            type="button"
            aria-label="Search by file name"
            aria-pressed={search.open}
            title="Search by file name"
            onClick={() => {
              if (search.open) search.onClose();
              else {
                opened.current = true;
                search.onOpen();
              }
            }}
          >
            🔍
          </button>
          {search.open && (
            <input
              ref={input}
              type="text"
              value={search.value}
              placeholder="file name"
              aria-label={`Search file name ${where}`}
              style={{ width: 150 }}
              onChange={(e) => search.onChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") search.onClose();
              }}
            />
          )}
        </>
      )}
      <button disabled={atStart} onClick={() => onPage(1)}>
        « First
      </button>
      <button disabled={atStart} onClick={() => onPage(grid.page - 1)}>
        ‹ Prev
      </button>
      <span style={{ flex: 1, textAlign: "center" }}>
        {grid.total === 0 ? (
          "No pictures"
        ) : (
          <>
            Page <strong>{grid.page}</strong> of {grid.n_pages} · frames <strong>{start + 1}–{end}</strong> of {grid.total}
          </>
        )}
      </span>
      <button disabled={atEnd} onClick={() => onPage(grid.page + 1)}>
        Next ›
      </button>
      <button disabled={atEnd} onClick={() => onPage(grid.n_pages)}>
        Last »
      </button>
      <label>
        Per page{" "}
        <select
          aria-label={`Per page ${where}`}
          value={settings.per_page}
          onChange={(e) => onSettings(Number(e.target.value), settings.cols)}
        >
          {settings.per_page_options.map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
      </label>
      <label>
        Columns{" "}
        <select
          aria-label={`Columns ${where}`}
          value={settings.cols}
          onChange={(e) => onSettings(settings.per_page, Number(e.target.value))}
        >
          {settings.cols_options.map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
      </label>
    </div>
  );
}
