import { Fragment, ReactNode, useEffect, useState } from "react";
import Pager, { PagerGrid, PagerSettings } from "./Pager";

/**
 * The layout every card grid shares: the pager above and below, the columns, the page of cards in between, and the same
 * page and column choices. What a card is (a labeling card, a detection card, ...) comes in through `renderCard` (it returns
 * the card's own `<li>`); `header`
 * is for a line above the pager. The tool owns the items and the page. A list the server pages (Classify, Verdict) passes the
 * page it was given in `serverPage`; the items are then that page and are not cut again.
 *
 * The pager has a search by file name (the magnifying glass, top and bottom share one field). A list the grid holds is
 * filtered right here by the file name `keyOf` gives. A list the server pages can only be searched by the server, so it
 * passes `search`: the typed text comes out of `onChange` (after a short pause) and the page answers with the matching
 * items. A server-paged list without `search` has no search button.
 */
/** The server does the searching: the applied text and the way to change it. */
export interface GridSearch {
  value: string;
  onChange: (value: string) => void;
}

const SEARCH_PAUSE_MS = 300;

export default function CardGrid<T>({
  items,
  keyOf,
  renderCard,
  settings,
  onSettings,
  page,
  onPage,
  where,
  header,
  label,
  serverPage,
  search,
  onGridChange,
  container = "ul",
}: {
  items: T[];
  keyOf: (item: T) => string;
  renderCard: (item: T) => ReactNode;
  settings: PagerSettings;
  onSettings: (perPage: number, cols: number) => void;
  page: number;
  onPage: (page: number) => void;
  /** Prefix of the pagers' accessible names ("selection" gives "Pagination selection top"). */
  where?: string;
  header?: ReactNode;
  label?: string;
  /** The page the server returned, when the list is paged there (then `items` is that page). */
  serverPage?: PagerGrid;
  /** Server-side search by file name (see above). */
  search?: GridSearch;
  /** The user turned the grid: another page, size or columns, or a search. Pictures deleted in place are dropped then. */
  onGridChange?: () => void;
  /** The element holding the cards: a list when each card is an `<li>`, a div for other cards. */
  container?: "ul" | "div";
}) {
  const searchable = !!search || !serverPage;
  const [open, setOpen] = useState(!!search?.value);
  const [draft, setDraft] = useState(search?.value ?? "");
  // The server answers for the text after a short pause, so typing does not ask once per key.
  useEffect(() => {
    if (!search || draft.trim() === search.value) return;
    const timer = setTimeout(() => search.onChange(draft.trim()), SEARCH_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [draft, search?.value]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (search && search.value !== draft.trim()) setDraft(search.value);
  }, [search?.value]); // eslint-disable-line react-hooks/exhaustive-deps

  const needle = draft.trim().toLowerCase();
  const list = !search && !serverPage && needle ? items.filter((item) => keyOf(item).toLowerCase().includes(needle)) : items;
  const searching = search ? search.value !== "" : needle !== "";
  const pagerSearch = searchable
    ? {
        open,
        value: draft,
        onOpen: () => setOpen(true),
        onClose: () => {
          setOpen(false);
          setDraft("");
          onGridChange?.();
          if (search) search.onChange("");
          else onPage(1);
        },
        onChange: (value: string) => {
          setDraft(value);
          onGridChange?.();
          if (!search) onPage(1);
        },
      }
    : undefined;

  const turnPage = (p: number) => {
    onGridChange?.();
    onPage(p);
  };
  const turnSettings = (perPage: number, cols: number) => {
    onGridChange?.();
    onSettings(perPage, cols);
  };

  const perPage = settings.per_page;
  const nPages = Math.max(1, Math.ceil(list.length / perPage));
  const cur = Math.min(Math.max(page, 1), nPages);
  const shown = serverPage ? list : list.slice((cur - 1) * perPage, cur * perPage);
  const pagerGrid = serverPage ?? { page: cur, per_page: perPage, n_pages: nPages, total: list.length };
  const Container = container;
  const name = (side: string) => (where ? `${where} ${side}` : side);
  return (
    <div aria-label={label}>
      {header}
      <Pager grid={pagerGrid} settings={settings} onPage={turnPage} onSettings={turnSettings} where={name("top")} search={pagerSearch} />
      {searching && shown.length === 0 ? (
        <p role="status">Not found</p>
      ) : (
        <Container style={{ display: "grid", gridTemplateColumns: `repeat(${settings.cols}, minmax(0, 1fr))`, gap: 8, padding: 0, margin: 0 }}>
          {shown.map((item) => (
            <Fragment key={keyOf(item)}>{renderCard(item)}</Fragment>
          ))}
        </Container>
      )}
      <Pager grid={pagerGrid} settings={settings} onPage={turnPage} onSettings={turnSettings} where={name("bottom")} search={pagerSearch} />
    </div>
  );
}
