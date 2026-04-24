# Tools & Meta-Vault

How the agent acts on the vault. Built-in tools live in TypeScript + Rust; user-defined "meta" tools live in `%APPDATA%/com.vault-chat.app/meta/tools/*/`.

## Files

- [src/tools.ts](../src/tools.ts) — built-in tool definitions (Zod schemas + `invoke()` dispatch)
- [src/meta.ts](../src/meta.ts) — meta-vault path resolution, system prompt loader, meta-tool loader
- [src/skills.ts](../src/skills.ts) — meta-vault skill loader + `/name` expansion (separate track from tools)
- [src-tauri/src/lib.rs](../src-tauri/src/lib.rs) — Rust Tauri commands each tool dispatches to

## Built-in tool catalog

| Tool | Schema | Backend | Truncation |
|---|---|---|---|
| `Read` | `{path}` | `read_text_file` | READ_CAP = 24k chars |
| `Write` | `{path, contents}` | `write_text_file` | — |
| `Delete` | `{path}` | `delete_file` | — |
| `Edit` | `{path, old_string, new_string, replace_all?}` | `edit_text_file` | — |
| `Glob` | `{pattern}` | `glob_files`, cwd = vault | SHORT_CAP = 8k chars |
| `Grep` | `{pattern, path?, glob_filter?, case_insensitive?, max_results?}` | `grep_files` (default 500 results) | SHORT_CAP = 8k |
| `Bash` | `{command, cwd?, timeout_ms?}` | `bash_exec` (default 120s) | Rust 50k → TS 8k (double-truncation) |
| `NotebookEdit` | `{path, action, cell_index, source?, cell_type?}` | **client-side** JSON parse/write | — |
| `PdfExtract` | `{path, pages?}` | **client-side** pdfjs | PDF_CAP = 60k chars |
| `TodoWrite` | `{todos: [{content, status, activeForm?}]}` | **client-side** `store.setAgentTodos` | — |
| `ListDir` | `{path}` | `list_dir` | SHORT_CAP = 8k |
| `WebFetch` | `{url, max_chars?}` | `http_fetch` (default 120k chars) | — |
| `WebSearch` | `{query, max_results?}` — only if `tavilyKey` set | `tavily_search` | — |

## Meta-vault layout

```
%APPDATA%/com.vault-chat.app/meta/
  system.md                 Extra system prompt text (else FALLBACK_SYSTEM is used)
  skills/
    <name>/
      SKILL.md              Front-matter: {name, description}. Body = prompt injection.
  tools/
    <name>/
      TOOL.md               Front-matter: {name, description, input_schema, requires_keys?}
      run.py | run.js | run.mjs | run.ts | run.sh | run.bash
```

All of this is **global** — skills and tools are *not* per-vault. See memory feedback `feedback_skills_global_only.md`.

## Skill loading ([skills.ts:12](../src/skills.ts))

1. List `meta/skills/` directory entries; each directory = one skill.
2. Read `SKILL.md`, parse front-matter via `gray-matter()`.
3. Build `{name, description, path, body}`.
4. Sort alphabetically by name.

Skills are **prompt injection**, not executable. When the user types `/name` anywhere in their message, `expandSkillInvocation()` wraps `body` in `<skill name="...">...</skill>` and prepends it to the message that reaches the model.

## Meta-tool loading ([meta.ts:155](../src/meta.ts))

1. List `meta/tools/` directory entries.
2. For each, read `TOOL.md` and parse front-matter.
3. Convert `input_schema` (JSON Schema or flat `{field: {type, description, default, required}}`) to Zod.
4. Register an `ai.tool()` whose `execute` dispatches `invoke("run_script", {scriptPath, stdinJson, cwd, timeoutMs, env})` to Rust.

**Execution contract**:
- Input args are serialized to JSON on stdin.
- If `TOOL.md` has `requires_keys: ["KEY_A", "KEY_B"]`, those are fetched from the OS keychain (`user.*` namespace) and passed as `env` to the subprocess. Missing keys are silently omitted (the script must handle absence).
- Hard timeout: **60 seconds** (not user-overridable).
- stdout/stderr are each capped at 50k bytes in Rust.

## Permission model

Minimal. The agent is trusted the same way a user is.

- **No vault-boundary enforcement** on most tools. `Read`, `Bash`, `Glob`, `Grep`, `ListDir` accept absolute paths — they can reach anywhere the Tauri process can. Write/Edit/Delete/Rename paths aren't boundary-checked either.
- `.git/` **write** guard in Rust ([lib.rs:1252](../src-tauri/src/lib.rs) `path_touches_dot_git`) blocks `Write`, `Edit`, `Delete`, `Rename`, `CreateDir` against `.git/`. **Read** is NOT blocked — the agent can `cat .git/config`, enumerate `.git/objects`, etc.
- **Bash `cwd`** is user-settable; defaults to vault root. No boundary check.
- **Symlinks**: `walkdir` and `std::fs` follow symlinks by default. A symlink inside the vault pointing to `/etc/passwd` would let `Read` reach it.

The threat model is: **the user owns the agent**. If the user trusts the model, the model gets full OS access via Bash. If the user doesn't trust a model, they shouldn't chat with it in this app.

## Bash specifics ([lib.rs:554](../src-tauri/src/lib.rs))

- **Windows**: `cmd /C <command>`. Use PowerShell via `powershell -NoProfile -Command "..."` for Unix-y pipes.
- **macOS**: `bash -lc <command>` (sources `.bash_profile`).
- **Linux**: `bash -lc <command>`.

- Stdin is piped (never interactive). Scripts that `read` or `pause` hang until timeout.
- Output is captured with a 50k-byte cap per stream (stdout and stderr independently). The TS tool wrapper then truncates to 8k for the agent, so the agent sees the "…[truncated N bytes]" marker referencing the final 8k, not the 50k.
- **No shell escaping** on the agent side. The agent must quote its own arguments. With internal code only, this is safe because we don't interpolate user input into tool calls.

## Meta-tool vs. skill

| | Skill | Meta-tool |
|---|---|---|
| Lives in | `meta/skills/<n>/SKILL.md` | `meta/tools/<n>/TOOL.md` + `run.*` |
| User triggers via | `/name` in message | model decides to call (native tool) |
| Does it execute | No (prompt injection only) | Yes (subprocess) |
| Can read keychain | No | Yes, via `requires_keys` → env |
| Visible to model | Listed in system prompt; body injected only on invocation | Listed as `ai.tool()` with schema |

Name collision between a skill and a tool is legal but confusing. The tool would be auto-callable by the model; the skill would require a `/` token in user text.

## Schema notes

- Zod schemas in [tools.ts](../src/tools.ts) describe *input*, not output. Tool output is always a string (stringified JSON for Grep, plain text for others).
- JSON Schema → Zod conversion ([meta.ts:65](../src/meta.ts)) supports `string / integer / number / boolean`. No enum support: `type: ["foo", "bar"]` becomes `z.string()` silently.
- `required: [...]` and per-field `required: true` both work. Missing → field becomes `z.optional()`.
- Defaults are applied in the tool wrapper, not enforced in schema — the agent can omit values and the JS side fills in defaults.

## Failure modes

- **Output truncation is silent**. `Read` caps at 24k chars; bigger files are sliced. The tool returns `…[truncated]` but doesn't say how many bytes total. Same for Glob/Grep/Bash/PdfExtract.
- **Meta-tool with missing key** runs anyway with `env = {}`. If the script's HTTP auth silently falls back to unauthenticated, the agent has no signal it ran degraded. Put an explicit check in the script.
- **Bash timeout** returns `(timed out after Ns)` + stderr; the agent may re-attempt.
- **Rust panics** surface as rejected `invoke` promises → tool errors like `Error: ...`. Most file ops are `Result<_, String>` so panics are rare.
