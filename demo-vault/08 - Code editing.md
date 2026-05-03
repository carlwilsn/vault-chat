# Code editing — Ctrl+K and Ctrl+L work everywhere

Inline edit and ask mode aren't just for prose. They work on any selection in any file — Python, TypeScript, SQL, YAML, whatever. Open **code/log_parser.py** in the file tree.

## Try inline edit on the function

Select the entire `parse_logs` function — click on the `def` line, then shift-click after the `return` statement. Press **Ctrl+K**. Try:

> add type hints

You'll see the parameters and return value annotated in place. **Ctrl+Enter** to accept. Now select it again and try:

> rewrite using a defaultdict and list comprehension to make it more idiomatic

Watch the verbose loop collapse into a few clean lines.

## Try ask mode on a tricky bit

Select the line with `if endpoint in results:` plus the next four lines (the manual dict-increment pattern). Press **Ctrl+L**:

> what's a more pythonic way to do this?

The popover answers without changing the file. Use this when you want a second opinion before committing to the rewrite.

## Hand the whole file to the agent

In the chat pane:

> read code/log_parser.py and refactor it: type hints, defaultdict, pathlib instead of open(), and add a `--threshold` CLI flag that filters endpoints with fewer than N errors.

The agent reads the file, plans the changes, and writes the new version. Open it back up and you'll see all the requested changes applied in one shot. (Open Ctrl+H to compare against the original — it's still there in git history.)

The keybinds are universal: Ctrl+K to rewrite, Ctrl+L to ask, chat to delegate larger work. Same flow you've used on prose for the last few notes.

Next: **09 - HTML rendering.md**.
