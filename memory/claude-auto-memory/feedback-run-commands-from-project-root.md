---
name: feedback-run-commands-from-project-root
description: "Start every chained shell command with an absolute cd to the project root; a stray `cd ..` once skipped the version bump and docs silently"
metadata:
  node_type: memory
  type: feedback
  originSessionId: ed77561f-40f9-4b98-84d6-bb654c316f32
  modified: 2026-10-18T19:17:00.106Z
---

The Bash tool keeps the working directory between calls, and a `cd ..` or `cd app/frontend` inside one call changes where the next call starts. On 2026-10-18 a `cd ..` inside a chained command made the following `sed`, `python3` doc edit and `npx tsc` run from `app/`: the version bump and the docs edit silently did nothing and `npx tsc` tried to install a package.

**Why:** edits that "succeed" in the wrong folder look like success. **How to apply:** begin every multi-step command with `cd /home/brona/Documents/Obsidian_Vault/Picture_Sorter_for_NN_Training && ...`, use `(cd app/frontend && ...)` in a subshell for frontend work, and after a chained edit check `git status` or grep for the new text before committing. Related: [[feedback-test-gate-commit]].
