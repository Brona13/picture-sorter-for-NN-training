---
name: feedback-agree-before-building
description: For non-trivial UI changes the user wants the idea restated and a few real questions answered before any code; small visual tweaks can just be done
metadata:
  node_type: memory
  type: feedback
  originSessionId: ed77561f-40f9-4b98-84d6-bb654c316f32
  modified: 2026-10-18T19:16:55.340Z
---

When the user says "before you do anything, let me know if this is clear" or "I need to talk about it first", stop: restate the idea in a few bullets, ask only the questions whose answers change the build (3 at most, with my recommendation), and wait. They answered such rounds with short "yes to all three" and then expected the full build in one go.

For small visual tweaks (rename a button, move a line, change a colour) just do it, test, commit and report; do not ask.

**Refinement from 2026-10-18 (long Chain/Classify session):** the user often ends a message with "give me your understanding; if it is clear and nothing contradicts, build". Then answer in plain text: restate in a few bullets, list the **open and contradicting points** (including conflicts with earlier decisions found in the code or docs), give my recommended default for each, and build only when there are none. They also settle things in short rounds ("remove mute", "yes, make that change") and expect the whole build, tests, docs, version bump and commit in one go. **Ask in plain text, not with `AskUserQuestion` pop-ups:** they dismissed such dialogs twice with "I want to clarify" and answered better in prose. If a tool call is rejected with "clicked no by mistake", just repeat it.

**Why:** on 2026-10-16 the one-active-function rule for the Dedup panel and the scatter-as-a-function change were both settled this way and went through without rework. **How to apply:** after the user agrees, build it, update tests, docs and version, commit, and say what to hard-refresh or restart. Do not push until they say "push it".
