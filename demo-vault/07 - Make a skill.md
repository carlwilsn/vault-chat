# Build your own skill

The agent can write its own skills and tools. Skills are markdown prompts; tools are little Python scripts. They live in the **meta vault** — a separate vault at `%APPDATA%/com.vault-chat.app/meta/` (Windows) — and they're invokable as slash-commands in chat.

In the chat pane, ask:

> make me a skill called `review-prose` that critiques the current note for clarity, jargon, run-on sentences, and weak verbs. it should give a numbered list of specific issues with line references.

The agent will switch to the meta vault, write `skills/review-prose/SKILL.md` with YAML front-matter, and switch back. From your next message onward, type `/review-prose` in chat — it's invokable.

Try it on this very note: open the chat, send `/review-prose`. You'll get back a critique of what you're reading.

You can do the same with tools (Python scripts the agent calls):

> build me a tool that fetches the current weather for a city and returns it as JSON.

The agent writes `tools/weather/TOOL.md` (input schema) + `run.py` (the script). Available on the next turn.

---

That's the tour. Now open a folder you *actually* use — your real notes, your research, a project directory — and start chatting. Titlebar → folder icon → pick a directory.

Found a bug or have an idea? carlwilson2027@u.northwestern.edu.
