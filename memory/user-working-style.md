---
name: user-working-style
session_date: 2026-07-08
last_updated: 2026-11-06
description: How the user likes to work — methodology first, concepts before code
metadata:
  type: user
---

The user prefers building theoretical/methodological understanding **before** touching code, and wants concepts broken into basic terms first with the option to go deeper. They are comfortable with Python but relatively new to ML / vision data-curation. They like to iterate and track progress carefully (logs now, possibly a database later).

Practical implication: lead with a written methodology/design (see
[[project-goal-and-path1]]) and explain *why* before *how*. See related
[[sorting-ux-decisions]].

## Working agreements seen 2026-11-06
- **Design in words first, code on his signal.** He answers the open questions, and only "go" starts the code; a question he has not answered is repeated, with a default, rather than assumed.
- **Plain words for unfamiliar terms**, with a small example in his own domain (OK / NG pictures), before asking him to choose (the *positive class* of a confusion matrix: he defined OK as positive).
- **One shared grid, no second card-list code.** A new view of pictures reuses the Classify Grid (Show filter entries) instead of a list of its own.
- **Everything valuable travels in Git** (database and `.gitignore`d files excepted): decisions, open items and session notes go into `docs/` and `memory/`, since his Linux Claude Code reads only the repo.

