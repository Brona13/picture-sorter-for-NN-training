---
name: todo-golden-invariant-enforcement
session_date: 2026-07-29
last_updated: 2026-07-29
description: Add tests and domain-level enforcement for label and golden consistency
status: pending
document_type: todo
metadata:
  type: project
---

# TODO — Golden invariant enforcement

## Context

The current domain rule is:

> A golden is always a labeled frame and inherits that label.

Related invariants are defined in [[data-model]]:

- An unlabeled frame cannot be golden.
- A frame can be golden for at most one class within a feature.
- Relabeling a golden moves its reference class to the new label.
- Clearing the label of a golden removes its golden status.

The Streamlit Classify interface currently coordinates these behaviors.

The low-level functions in `scripts/labels.py` remain persistence primitives and can be called in ways that create inconsistent label/golden state. Automated tests do not yet protect every path.

## Proposed work

1. Create a focused test structure using temporary camera and database roots.
2. Add behavior tests for:
   - Rejecting or safely handling an attempt to star an unlabeled frame
   - Marking a labeled frame golden for its current class
   - Preventing more than one active golden class for one frame and feature
   - Moving golden status when a golden frame is relabeled
   - Removing golden status when its label is cleared
   - Preserving append-only label and golden history
   - Reverting a version without violating the invariant
3. Decide where domain enforcement belongs:
   - Strengthen the public functions in `scripts/labels.py`, or
   - Introduce higher-level atomic domain operations above the persistence primitives.
1. Update Streamlit callers to use the enforced domain API.
2. Check existing SQLite data for inconsistent historical records.
3. Preserve compatibility handling until existing data has been verified or migrated.
4. Update [[current-project]] after implementation and verification.

## Safety requirements

- Never run tests against the real `cameras/` directory.
- Never run tests against `data/picture_sorter.db`.
- Set `CURATION_CAMERAS_ROOT` and `CURATION_DATA_DIR` to temporary directories.
- Back up the real database before any future migration or repair.
- Do not silently rewrite historical append-only records.

## Acceptance criteria

- Every active golden has exactly one current label in the same class.
- Relabel and clear operations update golden state atomically.
- Non-UI callers cannot create inconsistent current state through the supported domain API.
- Append-only history remains intact.
- Version freeze and revert preserve the invariant.
- Tests run entirely against temporary data.
- Existing real data is audited before removing compatibility fallbacks.

## Related documents

- [[data-model|Canonical data model]]
- [[current-project|Current project]]
- [[flow-v3-classify-and-versioning|Classification and versioning history]]
- [[multi-product-hierarchy|Multi-product hierarchy history]]
