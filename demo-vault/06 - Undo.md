# Undo: full git history of the vault

Every agent turn that touches files auto-commits. Every Ctrl+K accept auto-commits. The vault is a real git repo and the app drives it for you.

Press **Ctrl+H** — a history modal opens. You'll see one row per turn, with a description of what changed. Click any row, then **Restore** — the vault snaps back to that exact state. Drill into a single file (the per-file tab) to see just that file's timeline.

Translation: the agent literally can't lose your work. Mistake? One click back. Aggressive refactor that didn't pan out? One click back. This is why it's safe to let the agent be bold.

Try it: from the previous note you should have an `ideas/` folder with a few notes in it. Open Ctrl+H, find the turn that created it, restore to *before* that turn. The folder vanishes. Move forward again to bring it back. Time travel for your notes.

Next: **07 - Make a skill.md**.
