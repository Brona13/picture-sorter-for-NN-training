---
name: discussions-index
description: Auto-generated index of discussion notes in this folder
status: current
document_type: index
last_updated: 2026-10-14
---

# Discussions index

Auto-generated via Dataview from the frontmatter of each discussion note in this folder.

## All discussions

```dataview
TABLE
  last_updated AS "Updated",
  status AS "Status",
  document_type AS "Type",
  description AS "Description"
FROM "discussions"
WHERE document_type != "index"
SORT last_updated DESC, file.name ASC
```

## Grouped by status

```dataview
TABLE WITHOUT ID
  status AS "Status",
  rows.file.link AS "Discussions",
  rows.last_updated AS "Updated"
FROM "discussions"
WHERE document_type != "index"
GROUP BY status
SORT status ASC
```
