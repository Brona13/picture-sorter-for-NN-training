import { InputHTMLAttributes, useEffect, useRef } from "react";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange" | "min" | "max" | "step"> & {
  value: number;
  min: number;
  max: number;
  step?: number;
  onValue: (value: number) => void;
};

const decimals = (step: number) => (String(step).split(".")[1] ?? "").length;

/**
 * A range slider that also moves with the mouse wheel while the pointer is over it: wheel up = more,
 * wheel down = less, one step per notch. The page does not scroll meanwhile.
 */
export default function WheelRange({ value, min, max, step = 1, onValue, ...rest }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const latest = useRef({ value, min, max, step, onValue });
  latest.current = { value, min, max, step, onValue };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      e.preventDefault(); // React's own wheel handlers are passive, so this must be a native listener
      const { value, min, max, step, onValue } = latest.current;
      const next = Math.min(max, Math.max(min, value + (e.deltaY < 0 ? step : -step)));
      const rounded = Number(next.toFixed(decimals(step)));
      if (rounded !== value) onValue(rounded);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  return <input {...rest} ref={ref} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onValue(Number(e.target.value))} />;
}
