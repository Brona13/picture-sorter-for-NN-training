---
name: stay-within-project-folder
description: Do not inspect paths outside the project folder without asking first
metadata: 
  node_type: memory
  type: feedback
  originSessionId: c53b4052-5233-4c8a-8b98-4f61eadfbd2f
  modified: 2026-08-06T13:30:21.305Z
---

Work only inside the project directory. On 2026-08-06 a command that listed
`~/.ssh` and searched the wider Obsidian vault for other git repositories was
rejected, with the instruction: "I want you to stay in this folder. Don't go
anywhere else unless agreed upon."

**Why:** the vault holds unrelated personal projects — finance, legal, health,
job search. Browsing it is unwanted even when a command is read-only and even
when it would help diagnose the task at hand.

**How to apply:** keep file reads, searches, and listings within the project
root. Diagnostic commands that report on the machine rather than browse it
(`git ls-remote`, `nvidia-smi`, `ss -ltnp`, `df`) have been fine in practice.
When something genuinely needs a path outside the folder, ask first and say what
it would reveal — or state plainly that the answer can't be checked from here,
as with SSH key setup and firewall state in that session.
