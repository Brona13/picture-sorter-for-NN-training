import { useState } from "react";

/** A remembered picture size in px (per page, kept in this browser only). */
export function usePictureSize(key: string, fallback: number, min: number, max: number): [number, (v: number) => void] {
  const [size, setSize] = useState(() => {
    try {
      const v = Number(localStorage.getItem(key));
      if (v >= min && v <= max) return v;
    } catch {
      /* storage unavailable */
    }
    return fallback;
  });
  const update = (v: number) => {
    setSize(v);
    try {
      localStorage.setItem(key, String(v));
    } catch {
      /* storage unavailable */
    }
  };
  return [size, update];
}

export default function PictureSizeSlider({
  value,
  onChange,
  min,
  max,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
}) {
  return (
    <label style={{ display: "inline-flex", flexDirection: "column" }}>
      <span style={{ fontSize: 11, color: "var(--muted)" }}>Picture size · {value} px</span>
      <input
        type="range"
        aria-label="Picture size"
        min={min}
        max={max}
        step={10}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}
