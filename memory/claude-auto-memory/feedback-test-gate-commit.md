---
name: feedback-test-gate-commit
description: Commit only after the tests pass; gate on the test exit code, not on a grep pipe
metadata:
  type: feedback
---

Run the frontend checks as `cd app/frontend && npm test && npx tsc --noEmit` and gate the commit on that result. Piping `npm test` through `grep` hides its exit code, so a chain `... | grep ...; ... && git commit` committed with one failing test on 2026-10-16 (fixed in the next commit, but it should not happen).

**Why:** a failing commit can get pushed by the "push it" shortcut. **How to apply:** run the tests, read the count, and only then commit; if any test fails, fix it first. Bump `VERSION`/`RELEASED` and update docs and tests in the same commit, as the project's `CLAUDE.md` demands.
