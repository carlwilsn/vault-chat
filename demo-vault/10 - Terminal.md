# Terminal at the vault (Ctrl+J)

Press **Ctrl+J** — or click the terminal icon in the titlebar.

A real shell window opens in the current vault's directory. Windows: `cmd`. Mac: Terminal.app. Linux: your `$TERMINAL`. Detached from vault-chat, so you can close the app and the shell stays.

Why it's useful:

- `git log`, `git diff`, `git status` — when you want to see what the auto-commit machinery has been doing without opening Ctrl+H.
- Run a Python script that lives in your vault. Pipe a note through `pandoc`. Whatever shell glue you reach for.
- The agent's `Bash` tool already runs in this same directory, so anything you do here is the same environment the agent sees.

Try it now: Ctrl+J, then in the shell that opens:

```
git log --oneline -5
```

You'll see the auto-commits the agent and inline-edit have been making — every accepted Ctrl+K, every "create the ideas folder" turn, every undo. The vault is a real git repo and the terminal is your direct line to it.

Next: **11 - Notes.md**.
