---
name: feedback-one-question-simple-terms
description: In a design discussion the user wants one open question at a time, in simple terms with examples from their own chain, and will say when to build; do not jump ahead
metadata:
  node_type: memory
  type: feedback
---

When the user says "let's discuss first", "go through the questions step by step" or "use simple terms because I like to decide correctly", ask **one** question per message, explain it with a concrete example from their own chain (the numbers, the box names), give my recommendation, and wait. Do not move to the next question until they have answered the current one ("Don't move to another question until we make this one clear"). They may answer a question indirectly or point to an earlier decision in the docs (for example the Verdict rules): then search `docs/` for it and report what is decided before asking again.

Mistakes to avoid: asking several numbered questions at once; asking something already settled earlier in the same discussion; proposing a new module when they prefer extending an existing one ("I wouldn't create a new module, that would be too complex for a user", they put Verdict into Freeze); letting a dictation slip ("pictures" for "questions") derail the answer.

**Why:** on 2026-11-16 the Dedup / Calculate / Muted dot / Freeze design went through one question at a time with no rework, then three versions were built and pushed. Related: [[feedback-agree-before-building]], [[user-voice-dictation]].
**How to apply:** after the last answer, restate the settled design in one block, write a plan file in `plans/` if asked, then build in separate versions, each tested and committed, and wait for "push".
