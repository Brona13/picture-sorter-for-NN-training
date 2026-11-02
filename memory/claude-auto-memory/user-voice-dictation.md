---
name: user-voice-dictation
description: "The user dictates messages by voice, so words are often misheard; glossary of the ones seen and how to resolve them"
metadata:
  node_type: memory
  type: user
  originSessionId: ed77561f-40f9-4b98-84d6-bb654c316f32
  modified: 2026-10-18T19:16:57.212Z
---

The user's messages are voice-dictated and contain speech-to-text errors. Resolve them from context instead of asking, and say which reading you took only when the guess changes what you build.

Seen so far: "data page" / "duplication page" = the Dedup page; "cutter tool" = the Scatter tool; "MD GPU" = AMD GPU; "bin icon" = the trash/delete button; "Okay, not good" = OK / NG; "zooming glass" = the magnifier icon; "texture page" / "Detect to page" = the Detector page; "Roy Editor" = ROI editor; "inside" = Insights; "listening buttons" = the card buttons; "course" = colours ("use the same course"); "nose cutter outliers" = the Scatter and Outliers views; "star okay" = the ⭐ OK button; "minus plus reset one to one and percentage" = the zoom line of the picture viewer; "bucket" = the group of pictures a view shows (e.g. deleted ones leave the bucket); "ROI for product / for feature" = the product-sorting ROI / a feature ROI; "uh" / repeated words are filler. They also correct themselves mid-message ("No, once again."): the last version wins.

**Why:** misreading "cutter tool" or "data page" would send work to the wrong page. **How to apply:** map by context (the page being worked on, the buttons named), and add new entries to `memory/dedup-redesign-panel.md` (section *Working with this user*) when a new one shows up.

**Seen 2026-10-19:** "in just page" = the Ingest page; "the small, the whole picture, meaning the previous box" = the whole found box; "whole right/left" = hole right/left; "preservicing" = pre-processing. Dots on a detector box are the per-target handles.

**Seen 2026-10-20:** "ROY" = ROI; "anchor points" = the handles / dots on a box; "classify goes with it" = the Classify box follows its ROI; "module" = a chain box.

**Seen 2026-11-02:** "in just okay / in just not good" = Ingest OK / Ingest NG ("in just" = Ingest again); "guldens" = goldens; "detector" said about the module that chooses goldens = the Classifier; "the okay not good pictures" = the OK and NG pictures; "freeze. in just okay, in just not good." was a list of module names; "tab one / step one" = the Step 1 tab.
