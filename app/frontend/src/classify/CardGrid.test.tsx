import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import CardGrid from "./CardGrid";

const settings = { per_page: 12, cols: 4, per_page_options: [12, 24], cols_options: [3, 4] };
const names = ["blue_0.png", "blue_1.png", "red_0.png", "Red_1.png", "green_9.png"];

function Held({ items = names, perPage = 12 }: { items?: string[]; perPage?: number }) {
  const [page, setPage] = useState(1);
  return (
    <CardGrid
      items={items}
      keyOf={(f) => f}
      settings={{ ...settings, per_page: perPage }}
      onSettings={() => {}}
      page={page}
      onPage={setPage}
      where="test"
      renderCard={(f) => <li key={f} data-testid={`c-${f}`}>{f}</li>}
    />
  );
}
const shown = () => screen.queryAllByTestId(/^c-/).map((e) => e.textContent);

test("a list the grid holds is searched by file name, ignoring case, with a field next to the magnifying glass", async () => {
  const user = userEvent.setup();
  render(<Held />);
  expect(screen.queryAllByLabelText(/Search file name/)).toHaveLength(0); // closed until asked for
  await user.click(screen.getAllByRole("button", { name: "Search by file name" })[0]);
  const field = screen.getAllByLabelText(/Search file name/)[0];
  expect(field).toHaveFocus();
  await user.type(field, "RED");
  expect(shown()).toEqual(["red_0.png", "Red_1.png"]);
  expect(screen.getAllByText(/of 2$/)[0]).toBeInTheDocument();
});

test("the magnifying glass is the first button of the pager, before First, in the top and the bottom pager", async () => {
  render(<Held />);
  for (const side of ["top", "bottom"]) {
    const nav = screen.getByRole("navigation", { name: `Pagination test ${side}` });
    const buttons = within(nav).getAllByRole("button");
    expect(buttons[0]).toHaveAccessibleName("Search by file name");
    expect(buttons[1]).toHaveTextContent("First");
  }
});

test("top and bottom share one search; the field of the pager whose button was pressed takes the focus", async () => {
  const user = userEvent.setup();
  render(<Held />);
  await user.click(within(screen.getByRole("navigation", { name: "Pagination test bottom" })).getByRole("button", { name: "Search by file name" }));
  const bottom = screen.getByLabelText("Search file name test bottom");
  expect(bottom).toHaveFocus();
  await user.type(bottom, "blue");
  expect(screen.getByLabelText("Search file name test top")).toHaveValue("blue");
  expect(shown()).toEqual(["blue_0.png", "blue_1.png"]);
});

test("nothing found says so and keeps the field, no cards", async () => {
  const user = userEvent.setup();
  render(<Held />);
  await user.click(screen.getAllByRole("button", { name: "Search by file name" })[0]);
  await user.type(screen.getAllByLabelText(/Search file name/)[0], "zzz");
  expect(screen.getByText("Not found")).toBeInTheDocument();
  expect(shown()).toEqual([]);
  expect(screen.getAllByLabelText(/Search file name/)[0]).toBeInTheDocument();
  expect(screen.getAllByText("No pictures")[0]).toBeInTheDocument();
});

test("Esc, or the magnifying glass again, closes the field and clears the search", async () => {
  const user = userEvent.setup();
  render(<Held />);
  await user.click(screen.getAllByRole("button", { name: "Search by file name" })[0]);
  await user.type(screen.getAllByLabelText(/Search file name/)[0], "blue");
  expect(shown()).toHaveLength(2);
  fireEvent.keyDown(screen.getAllByLabelText(/Search file name/)[0], { key: "Escape" });
  expect(screen.queryAllByLabelText(/Search file name/)).toHaveLength(0);
  expect(shown()).toHaveLength(5);

  await user.click(screen.getAllByRole("button", { name: "Search by file name" })[0]);
  await user.type(screen.getAllByLabelText(/Search file name/)[0], "red");
  await user.click(screen.getAllByRole("button", { name: "Search by file name" })[0]);
  expect(shown()).toHaveLength(5);
});

test("a search returns to the first page", async () => {
  const user = userEvent.setup();
  const many = Array.from({ length: 30 }, (_, i) => `f_${String(i).padStart(2, "0")}.png`);
  render(<Held items={many} perPage={12} />);
  await user.click(screen.getAllByRole("button", { name: "Next ›" })[0]);
  expect(shown()[0]).toBe("f_12.png");
  await user.click(screen.getAllByRole("button", { name: "Search by file name" })[0]);
  await user.type(screen.getAllByLabelText(/Search file name/)[0], "f_2");
  expect(shown()).toHaveLength(10);
  expect(shown()[0]).toBe("f_20.png");
});

// --- a list the server pages ---
const serverPage = { page: 1, per_page: 12, n_pages: 1, total: 2 };

test("a server-paged list without a search handler has no magnifying glass", () => {
  render(
    <CardGrid items={["a.png"]} keyOf={(f) => f} serverPage={serverPage} settings={settings} onSettings={() => {}} page={1} onPage={() => {}} renderCard={(f) => <li key={f}>{f}</li>} />,
  );
  expect(screen.queryAllByRole("button", { name: "Search by file name" })).toHaveLength(0);
});

describe("a list the server searches", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  test("with a search handler the typed text goes out after a short pause, not on every key, and the items are the server's", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <CardGrid items={["x.png"]} keyOf={(f) => f} serverPage={serverPage} search={{ value: "", onChange }} settings={settings} onSettings={() => {}} page={1} onPage={() => {}} renderCard={(f) => <li key={f} data-testid={`c-${f}`}>{f}</li>} />,
    );
    await user.click(screen.getAllByRole("button", { name: "Search by file name" })[0]);
    await user.type(screen.getAllByLabelText(/Search file name/)[0], "ab ");
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("ab"); // trimmed
    expect(screen.getByTestId("c-x.png")).toBeInTheDocument(); // the server's items are shown as given
  });

  test("closing the field clears the server search at once", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <CardGrid items={["x.png"]} keyOf={(f) => f} serverPage={serverPage} search={{ value: "ab", onChange }} settings={settings} onSettings={() => {}} page={1} onPage={() => {}} renderCard={(f) => <li key={f}>{f}</li>} />,
    );
    expect(screen.getAllByLabelText(/Search file name/)[0]).toHaveValue("ab"); // an active search shows its field
    await user.click(screen.getAllByRole("button", { name: "Search by file name" })[0]);
    expect(onChange).toHaveBeenCalledWith("");
  });

  test("an empty server answer for an active search says Not found", () => {
    render(
      <CardGrid items={[]} keyOf={(f: string) => f} serverPage={{ page: 1, per_page: 12, n_pages: 1, total: 0 }} search={{ value: "zzz", onChange: () => {} }} settings={settings} onSettings={() => {}} page={1} onPage={() => {}} renderCard={(f) => <li key={f}>{f}</li>} />,
    );
    expect(screen.getByText("Not found")).toBeInTheDocument();
  });
});
