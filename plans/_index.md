---
name: plans-index
description: Auto-generated index of plan files in this folder
status: current
document_type: index
last_updated: 2026-07-30
---

# Plans index

Auto-generated via Dataview from the frontmatter of each plan file in this folder.

## All plans

```dataview
TABLE
  last_updated AS "Updated",
  status AS "Status",
  description AS "Description"
FROM "plans"
WHERE document_type = "plan"
SORT last_updated DESC, file.name ASC
```

## Grouped by status

```dataview
TABLE WITHOUT ID
  status AS "Status",
  rows.file.link AS "Plans",
  rows.last_updated AS "Updated"
FROM "plans"
WHERE document_type = "plan"
GROUP BY status
SORT status ASC
```
