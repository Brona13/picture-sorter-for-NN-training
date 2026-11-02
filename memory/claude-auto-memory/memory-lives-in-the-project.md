---
name: memory-lives-in-the-project
description: "Claude's own auto-memory is stored inside the project (memory/claude-auto-memory/) and ~/.claude/.../memory is a symlink to it, so it travels with the project; how to set the link up on another machine"
metadata:
  node_type: memory
  type: project
  originSessionId: 7e7cb698-8e4a-45cb-ab47-8cb13b057e70
  modified: 2026-11-02T21:21:31.677Z
---

The user wants Claude's own memory to be **their** memory too and to travel with the project. Since 2026-11-02 the real files live in the project at `memory/claude-auto-memory/` (next to the project's own `memory/*.md` notes and its index `memory/MEMORY.md`), and `~/.claude/projects/-home-brona-Documents-Obsidian-Vault-Picture-Sorter-for-NN-Training/memory` is a **symlink** to that folder. Everything written to Claude's memory therefore lands in the project (and in git once committed).

**Why:** the Obsidian vault folder is moved between machines (Windows work laptop, Linux workstation); a memory kept only under `~/.claude` stays behind. See [[migration-push-state]] for the two-machine workflow.

**How to apply:**
- Write memory as usual; do not "copy" it anywhere. After changing it, tell the user the files under `memory/claude-auto-memory/` are changed and need a commit (they are tracked, not ignored).
- The old folder was kept as `~/.claude/projects/-home-brona-Documents-Obsidian-Vault-Picture-Sorter-for-NN-Training/memory.backup-2026-11-02` (identical copy at the time); the user may delete it.
- **On another machine** the link is not created by git. Move or clone the project, then replace Claude's memory folder for that project by a link to `<project>/memory/claude-auto-memory`: `ln -s <project>/memory/claude-auto-memory ~/.claude/projects/<project path with / and _ written as ->/memory` (on Windows an NTFS junction: `mklink /J`). Claude Code derives the folder name from the project's path, so it differs per machine; if unsure, start Claude Code once in the project, note the folder it creates, delete its empty `memory`, and make the link.
- Memories describing the Linux machine's paths (`/home/brona/...`) are only true there.
