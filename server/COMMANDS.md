# `invoke` commands implemented in node

The headless server aliases `@tauri-apps/api/core` to `server/shims/core.ts`, whose `invoke` dispatches to
the table in `server/commands/`. This is every command the bundled modules can reach (found by bundling
`server/main.ts` with a metafile and listing the literal `invoke("…")` names in the reachable `src/`
modules, plus the dynamic `default_*_prompt` names in `meta.ts`). An **unknown command throws** with
`unknown invoke command "<name>" — not implemented headless`, and the error is logged.

Reachable modules: store, phoneApp, schedulerLoop, offVaultRun, agent, tools, chat-controller, conversations,
notes, schedules, runWatcher, runHeartbeat, missionHost, meta, skills, context, git, keychain, debugLog,
autosave, commit-controller, alert-summary, compactor, providers, modelCatalog (+ small helpers).

| Command | Mirrors (src-tauri/src/lib.rs) | Node file | Notes |
|---|---|---|---|
| `read_text_file` | 1559 (+ `decode_text` 1568) | commands/fs.ts | BOM-aware UTF-8/16 |
| `write_text_file` | 1591 | commands/fs.ts | `.git` guard (6483); emits `file-changed` on the bus |
| `read_binary_file` | 1465 | commands/fs.ts | returns a number array, like Tauri's `Vec<u8>` |
| `edit_text_file` | 1915 | commands/fs.ts | CRLF-preserving; same error strings |
| `delete_file` | 1900 | commands/fs.ts | `.git` guard |
| `glob_files` | 1964 | commands/fs.ts + glob.ts | files only, newest first; Rust `glob` crate semantics |
| `grep_files` | 1999 / 2013 | commands/fs.ts | skips dot dirs, node_modules, target; JS regex syntax (Rust `regex` differs on exotic syntax) |
| `list_dir` | 2400 | commands/fs.ts | |
| `list_markdown_files` | 307 / 313 | commands/fs.ts | the UI-only git badge fields are omitted |
| `append_debug_log` | 1617 | commands/fs.ts | |
| `client_event_append` | 893 | commands/fs.ts | |
| `notes_read` / `notes_append` / `notes_write_all` | 846 / 864 / 917 | commands/fs.ts | |
| `conversations_read` | 1110 (`reconstruct_conversation` 1026, `is_terminal_meta` 1101) | commands/conversations.ts | per-conversation jsonl, tombstones, legacy fallback |
| `conversations_write_all` | 1225 (`deduped_line_count` 1188) | commands/conversations.ts | sorted keys like serde_json, never-shrink, twin collapse, temp+rename, follower skip |
| `conversation_delete` | 986 | commands/conversations.ts | tombstone first |
| `schedules_read` / `schedules_write_all` | 1413 / 1444 | commands/conversations.ts | tombstoned rows dropped |
| `schedule_tombstone_add` | 1386 | commands/conversations.ts | |
| `vault_sync_role` | 5525 (`is_sync_follower` 5513) | commands/conversations.ts | the box is always `writer` unless the git-dir marker says otherwise |
| `bash_exec` | 2111 / 2125 | commands/proc.ts | own process group; timeout and cancel kill the whole tree (3503); agent git identity (2488); env strip (6600) |
| `bash_cancel` | 2102 | commands/proc.ts | kills the tree immediately |
| `bash_shell_kind` | 86 | commands/proc.ts | |
| `run_script` | 6606 / 6620 (`interpreter_for` 6562) | commands/proc.ts | |
| `git_commit_all` | 4016 | commands/gitcmds.ts | shared per-repo lock (2599) with the sync loop; **never stages a file over 50 MB** (server rule) |
| `git_log_subdir` | 3841 | commands/gitcmds.ts | confined to the vault |
| `git_repo_root_for_file` | 4126 | commands/gitcmds.ts | |
| `http_fetch` | 2299 (`html_to_text` 2275) | commands/net.ts | |
| `tavily_search` | 2339 | commands/net.ts | |
| `push_post` | 6845 | commands/net.ts | raw Web Push POST |
| `keychain_get` | 5883 (fallback store 5942–6121) | keys.ts | decrypted once at boot from `secrets.age` + `fallback.key` (age scrypt, base64, JSON map) |
| `keychain_set` / `keychain_delete` | 5903 / 5927 | keys.ts | **refused**: the server's key store is read-only |
| `voice_tool_respond` | 6760 → voice_server.rs:1370 | commands/phone.ts | resolves a relayed request (bus.ts) |
| `phone_broadcast` | 6812 → voice_server.rs:1394 | commands/phone.ts | into the `/poll` ring (ring.ts) |
| `phone_set_vapid` | 6819 | commands/phone.ts | |
| `phone_push_subs` / `phone_push_unsub` | 6825 / 6831 → voice_server.rs:1435–1470 | commands/phone.ts | file `VC_PUSH_SUBS` (default `~/.config/com.vault-chat.app/phone-push-subs.json`, the desktop's `app_config_dir`); absent file = no subscriptions |
| `notification_add` | 6838 → voice_server.rs:1937 | commands/phone.ts | |
| `default_system_prompt` … `default_assistant_prompt` | 6511–6546 | commands/index.ts | the bundled `src-tauri/defaults/*.md` |

Desktop-only commands (file tree, history modal, vault sync, voice, TeX, window/app lifecycle) are not
reachable from the server's modules and are deliberately not implemented.
