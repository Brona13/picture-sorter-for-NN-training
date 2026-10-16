import { KeyboardEvent, useId, useState } from "react";

const chip = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "0 4px 0 8px",
  borderRadius: 9,
  fontSize: 12,
  background: "var(--hover)",
  color: "var(--fg)",
} as const;

/**
 * Tag chips with an input that suggests tags already used anywhere. Enter or comma adds; × removes the tag
 * from this camera only. Case-insensitive repeats are ignored.
 */
export default function TagEditor({
  tags,
  suggestions,
  onChange,
  disabled = false,
  label = "Add tag",
}: {
  tags: string[];
  suggestions: string[];
  onChange: (tags: string[]) => void;
  disabled?: boolean;
  label?: string;
}) {
  const [text, setText] = useState("");
  const listId = useId();

  function add(raw: string) {
    const tag = raw.replace(/\s+/g, " ").trim();
    setText("");
    if (!tag || tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return;
    onChange([...tags, tag]);
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add(text);
    } else if (e.key === "Backspace" && !text && tags.length) {
      onChange(tags.slice(0, -1));
    }
  }

  const unused = suggestions.filter((s) => !tags.some((t) => t.toLowerCase() === s.toLowerCase()));
  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
      {tags.map((t) => (
        <span key={t} style={chip} data-testid={`tag-${t}`}>
          {t}
          <button
            type="button"
            aria-label={`Remove tag ${t}`}
            title="Remove from this camera"
            disabled={disabled}
            onClick={() => onChange(tags.filter((x) => x !== t))}
            style={{ border: 0, background: "transparent", cursor: "pointer", padding: "0 4px", color: "inherit" }}
          >
            ×
          </button>
        </span>
      ))}
      <input
        aria-label={label}
        placeholder="tag…"
        list={listId}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        onBlur={() => add(text)}
        style={{ width: 110 }}
      />
      <datalist id={listId}>
        {unused.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </span>
  );
}
