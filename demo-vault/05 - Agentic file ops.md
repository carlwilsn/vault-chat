# Agentic file ops

The chat agent has the same tools you'd find in Claude Code: **Read**, **Write**, **Edit**, **Bash**, **Glob**, **Grep**. It can do multi-step work without asking permission for each step. In the chat pane, send:

> create a folder called `ideas` with three notes brainstorming side projects for someone learning data engineering. each note should be 3-4 sentences and have a clear title.

Watch the tool calls stream in — `Bash mkdir`, then three `Write` calls, then a summary. When it's done, you'll see `ideas/` in the file tree on the left with three new notes inside.

Try follow-ups in the same chat:

> add a fourth idea focused on streaming pipelines

> rename the second note to something punchier

> delete the third one

It just does it. No "are you sure?" prompts, no copy-pasting, no leaving the app. This is the part that feels different from Obsidian + a chatbot in a separate tab.

Don't worry about the agent breaking things — the next note shows the safety net.

Next: **06 - Undo.md**.
