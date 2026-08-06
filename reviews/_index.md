---
name: reviews-index
description: Live index of recurring code reviews and technical audit reports
status: current
document_type: index
last_updated: 2026-08-03
---

# Reviews index

This folder contains point-in-time reviews of the current codebase. Reports document findings and recommendations before implementation work begins, so later reviews can compare how performance, architecture, reliability, and maintainability change over time.

## All reviews

```dataview
TABLE
  review_date AS "Review date",
  review_type AS "Type",
  status AS "Status",
  overall_risk AS "Overall risk",
  description AS "Description"
FROM "reviews"
WHERE document_type = "code-review"
SORT review_date DESC, file.name ASC
```

## Findings by review

```dataview
TABLE
  critical_findings AS "Critical",
  high_findings AS "High",
  medium_findings AS "Medium",
  low_findings AS "Low"
FROM "reviews"
WHERE document_type = "code-review"
SORT review_date DESC, file.name ASC
```
