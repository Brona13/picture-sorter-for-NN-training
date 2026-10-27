import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import ZoneScatter from "./ZoneScatter";
import type { Zone } from "../zoneGeometry";

const zone: Zone = { shape: "circle", center: [100, 0], radius: 5, half: [10, 10] };
const points = { "a.png": [100, 1] as [number, number], "b.png": [130, 20] as [number, number], "c.png": null };

function mount(z: Zone, extra: Partial<Parameters<typeof ZoneScatter>[0]> = {}) {
  const onZone = vi.fn();
  const onCentre = vi.fn();
  render(<ZoneScatter points={points} zone={z} onZone={onZone} onCentre={onCentre} {...extra} />);
  const svg = screen.getByTestId("zone-scatter");
  // 520 px wide square: the viewBox is the same shape, so 1 px = view.w / 520 data units
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 520, height: 520, right: 520, bottom: 520, x: 0, y: 0, toJSON() {} });
  return { onZone, onCentre, svg };
}

test("dots are coloured by the zone and a missing point has no dot", () => {
  mount(zone);
  const dots = screen.getAllByTestId("zone-dot");
  expect(dots).toHaveLength(2);
  expect(dots[0].getAttribute("fill")).toBe("#1a7f37");
  expect(dots[1].getAttribute("fill")).toBe("#c62828");
});

test("a zone without a centre shows grey dots and a click on the chart proposes a centre", () => {
  const { onCentre, svg } = mount({ ...zone, center: null });
  expect(screen.getAllByTestId("zone-dot")[0].getAttribute("fill")).toBe("#888");
  expect(screen.queryByTestId("zone-centre")).toBeNull();
  fireEvent.click(svg, { clientX: 260, clientY: 260 });
  expect(onCentre).toHaveBeenCalledTimes(1);
  const [x, y] = onCentre.mock.calls[0][0];
  expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
});

test("clicking a dot puts the centre on it", () => {
  const { onCentre } = mount(zone);
  fireEvent.click(screen.getAllByTestId("zone-dot")[1]);
  expect(onCentre).toHaveBeenCalledWith([130, 20]);
});

test("dragging the edge handle saves the new radius on release", () => {
  const { onZone } = mount(zone);
  fireEvent.pointerDown(screen.getByTestId("zone-edge"), { pointerId: 1 });
  fireEvent(window, Object.assign(new Event("pointermove"), { clientX: 520, clientY: 260 }));
  fireEvent(window, new Event("pointerup"));
  expect(onZone).toHaveBeenCalledTimes(1);
  const saved: Zone = onZone.mock.calls[0][0];
  expect(saved.center).toEqual([100, 0]); // the real nominal, not the origin the chart is centred on
  expect(saved.radius).toBeGreaterThan(5); // the pointer is at the right edge of the view, far from the centre
});

test("with a nominal the chart is centred on it: dots are distances from the nominal", () => {
  mount(zone);
  const dots = screen.getAllByTestId("zone-dot");
  expect(dots[0].getAttribute("cx")).toBe("0"); // (100, 1) from a nominal at (100, 0)
  expect(dots[0].getAttribute("cy")).toBe("1");
  expect(dots[1].getAttribute("cx")).toBe("30");
  expect(screen.getByTestId("zone-shape").getAttribute("cx")).toBe("0");
  expect(screen.queryByTestId("zone-centre")).toBeNull(); // the nominal is set by clicking, typing or a card, not dragged
});

test("heat map: the dots are replaced by a legend (and an image where a canvas exists), the zone stays", () => {
  mount(zone, { heat: { points: [[100, 1], [101, 1], [130, 20]], smoothing: 1 } });
  expect(screen.queryAllByTestId("zone-dot")).toHaveLength(0);
  expect(screen.getByTestId("zone-shape")).toBeTruthy();
  expect(screen.getByTestId("zone-heat-legend").textContent).toContain("3 pictures");
});

test("without heat the dots are drawn and there is no legend", () => {
  mount(zone);
  expect(screen.getAllByTestId("zone-dot")).toHaveLength(2);
  expect(screen.queryByTestId("zone-heat-legend")).toBeNull();
});
