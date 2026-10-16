---
name: methods-config
description: Configuration page for choosing active scoring methods (CPU/ResNet18/ResNet50), v1.24.0; design choices and what is unverified
session_date: 2026-10-16
last_updated: 2026-10-16
status: current
document_type: session-note
---

# Methods configuration, v1.24.0

- Request: the user finds CPU unreliable and ResNet18 weaker than ResNet50, wants to switch methods off for speed.
- Global setting `methods.active` in `settings` under pseudo-camera `_global`; `methods_config.py` is the single source, `classify.methods_available()` follows it.
- Off = not computed in `refresh()`, filtered at read time (nothing deleted). On again = one Refresh scores; classify state returns top-level `missing_methods`.
- At least one installed method stays active; unusable saved choice falls back to all installed.
- Dedup/Outliers/Find similar/golden diversity use only active ResNet backbones; Dedup reason `methods_off`.
- Cards: flag = method tag (CPU/R18/R50) inside a chip coloured by leaning class; grey chip = no leaning; no OK/NG text. Bars unchanged.
- Sidebar: emoji per item, Configuration pinned at the bottom.
- Unverified in a browser or on real data. "Methods disagree" hidden with fewer than two methods.
