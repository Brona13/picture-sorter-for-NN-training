import { Fragment, ReactNode } from "react";
import Pager, { PagerGrid, PagerSettings } from "./Pager";

/**
 * The layout every card grid shares: the pager above and below, the columns, the page of cards in between, and the same
 * page and column choices. What a card is (a labeling card, a detection card, ...) comes in through `renderCard` (it returns
 * the card's own `<li>`); `header`
 * is for a line above the pager. The tool owns the items and the page. A list the server pages (Classify, Verdict) passes the
 * page it was given in `serverPage`; the items are then that page and are not cut again.
 */
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
  /** The element holding the cards: a list when each card is an `<li>`, a div for other cards. */
  container?: "ul" | "div";
}) {
  const perPage = settings.per_page;
  const nPages = Math.max(1, Math.ceil(items.length / perPage));
  const cur = Math.min(Math.max(page, 1), nPages);
  const shown = serverPage ? items : items.slice((cur - 1) * perPage, cur * perPage);
  const pagerGrid = serverPage ?? { page: cur, per_page: perPage, n_pages: nPages, total: items.length };
  const Container = container;
  const name = (side: string) => (where ? `${where} ${side}` : side);
  return (
    <div aria-label={label}>
      {header}
      <Pager grid={pagerGrid} settings={settings} onPage={onPage} onSettings={onSettings} where={name("top")} />
      <Container style={{ display: "grid", gridTemplateColumns: `repeat(${settings.cols}, minmax(0, 1fr))`, gap: 8, padding: 0, margin: 0 }}>
        {shown.map((item) => (
          <Fragment key={keyOf(item)}>{renderCard(item)}</Fragment>
        ))}
      </Container>
      <Pager grid={pagerGrid} settings={settings} onPage={onPage} onSettings={onSettings} where={name("bottom")} />
    </div>
  );
}
