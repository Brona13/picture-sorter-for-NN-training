# Memory — Index (Dataview)

A live table of this project's memory files, rendered by the **Dataview** community plugin (Obsidian → Settings → Community plugins → *Dataview*). Each row links to a memory note with its session date, one-line summary, and type.

> The plain-text index the assistant loads each session is [[MEMORY]]. This `_index` note is the human-friendly, always-current view. Files are listed automatically once they carry a `session_date` in their frontmatter, so new memories appear here with no manual edit.

```dataview
TABLE session_date AS "Session date", description AS "Summary", metadata.type AS "Type"
WHERE file.folder = this.file.folder AND session_date
SORT session_date ASC, file.name ASC
```

*(If the table above shows as code rather than a table, the Dataview plugin isn't enabled.)*
