# Frontend Layout

Three-pane Allotment layout. Left = file tree, center = viewer/editor, right = chat. Chat can pop out into a separate window.

## Files

- [src/App.tsx](../src/App.tsx) — three-pane Allotment layout + global shortcuts
- [src/Titlebar.tsx](../src/Titlebar.tsx) — custom Tauri title bar: vault open, hidden/history, popout, settings, window controls
- [src/FileTree.tsx](../src/FileTree.tsx) — file tree with drag-drop, multi-select, context menus
- [src/MarkdownArea.tsx](../src/MarkdownArea.tsx) — split-pane wrapper around `MarkdownView`
- [src/MarkdownView.tsx](../src/MarkdownView.tsx) — the actual per-file viewer/editor; routes by `fileKind`
- [src/PdfView.tsx](../src/PdfView.tsx) — PDF render + marquee ask
- [src/HtmlView.tsx](../src/HtmlView.tsx) — HTML iframe + marquee ask
- [src/ImageView.tsx](../src/ImageView.tsx) — image viewer + marquee ask
- [src/NotebookView.tsx](../src/NotebookView.tsx) — read-only Jupyter viewer
- [src/InlineEditPrompt.tsx](../src/InlineEditPrompt.tsx) — Ctrl+K (edit) / Ctrl+L (ask) / marquee-ask popover
- [src/inlineEdit.ts](../src/inlineEdit.ts) — agent call for inline edits and asks
- [src/sync.ts](../src/sync.ts) — main ↔ popout state sync
- [src/dnd.ts](../src/dnd.ts) — DataTransfer MIME constants + external-drop helper
- [src/fileKind.ts](../src/fileKind.ts) — file-type detection

## Layout

```
┌── Titlebar ────────────────────────────────────────┐
├─ FileTree ─┬───── MarkdownArea (split) ──────┬ Chat ┤
│            │                                  │      │
│            │  ┌ MarkdownView A ┬ MarkdownView │      │
│            │  │                │                │      │
│            │                                    │      │
└────────────┴──────────────────────────────────┴──────┘
```

- **Left pane** (FileTree): `preferredSize=fitWidth` (computed from file names), `minSize=160`, `maxSize=600`, `snap`. Hide with Ctrl+B.
- **Center pane** (MarkdownArea/SettingsPane): `minSize=340`, `priority=High`. Gets all the leftover room.
- **Right pane** (ChatPane): `preferredSize=440`, `minSize=320`, `snap`. **Unmounted entirely when popped out** ([App.tsx:233](../src/App.tsx)) — `visible=false` alone leaves a grabbable sash at the screen edge.

Layout key remounts Allotment when the vault path changes ([App.tsx:59](../src/App.tsx)), so split state doesn't leak between vaults.

## Global keyboard shortcuts ([App.tsx:72](../src/App.tsx))

| Shortcut | Action |
|---|---|
| Ctrl+E | Toggle view ↔ edit mode (if a file is open) |
| Ctrl+B | Toggle left pane |
| Ctrl+Shift+B | Toggle right pane (no-op when popped out) |
| Alt+L | Toggle light / graphite theme |
| Ctrl+K | Inline edit (in MarkdownView) |
| Ctrl+L | Inline ask (in any viewer) |
| Ctrl+M | Toggle marquee mode (PDF/HTML/Image views) |
| Enter | Send chat (Shift+Enter for newline) |
| Tab / Enter | Pick from @file or /skill autocomplete |
| Escape | Close any autocomplete/modal |

**Browser defaults suppressed** ([App.tsx:99](../src/App.tsx)): Ctrl+F, Ctrl+G, Ctrl+R, F5, Ctrl+P, Ctrl+S. Right-click contextmenu is blocked globally; each custom menu re-enables it locally via `preventDefault`.

**Safe anchor links** ([App.tsx:147](../src/App.tsx)): a global click handler plus MutationObserver strips `<a href>` attributes on every new DOM node, moving the URL to `data-href`. External `http(s)`/`mailto` links keep the visible URL for hover tooltips but open via the handler, not the webview. Prevents markdown in chat or viewers from navigating the app away.

## Titlebar ([Titlebar.tsx](../src/Titlebar.tsx))

Custom title bar (Tauri `decorations: false`). Left cluster, centered drag region, right cluster.

**Left cluster:**
- **Toggle left pane** — PanelLeft icon (Ctrl+B).
- **Open vault** — folder icon. Picks a directory, calls `setVault`, `list_markdown_files`, initializes git if needed. Shows the vault's basename; adds a `meta` badge if the current vault *is* the meta vault.
- **Refresh file tree** — RefreshCw icon (minimum 250 ms spin for feedback). Re-runs `list_markdown_files`.
- **Hidden files modal** — Eye icon. Lists entries from `.vault-chat-ignore`; checkbox-select to unhide.
- **History modal** — History icon. See "History & rewind" below.

**Right cluster:**
- **Toggle right pane** — PanelRight icon (Ctrl+Shift+B). Disabled when chat is popped out.
- **Popout chat** — ExternalLink icon. Spawns a separate webview; disabled while one is open.
- **Open terminal** — Terminal icon. Invokes `open_terminal` which spawns an OS-native shell rooted at the vault (`cmd` on Windows, `open -a Terminal` on macOS, `x-terminal-emulator`/`gnome-terminal`/`konsole`/`xterm` on Linux).
- **Settings** — Settings icon. Routes the center pane to `SettingsPane`.
- **Window controls** — Minimize / Maximize / Close (hidden on macOS which uses native traffic lights).

### History & rewind

Opens a git log of the vault. Left list: recent commits (30 by default, toggle "show earlier history" for 100 including pre-vault-chat commits). Click a commit → right side shows the diff. "Show file contents" toggles between a file + line-count summary and the full unified diff.

**"Go back to this commit"** runs `git reset --hard <hash>` on the vault. Destructive; the click is the confirmation. After restore, the file tree is refreshed, the current file closes if it was deleted, and the history re-fetches.

### Hidden files modal

`.vault-chat-ignore` is a plain text file in the vault root listing files or patterns the tree shouldn't show. The agent still sees hidden files (they're only hidden from the UI). The modal renders the current lines as checkboxes — selecting any and clicking Unhide removes those lines. To add entries, right-click in the tree → Hide. Or edit `.vault-chat-ignore` by hand — it's a convention, not a walled garden.

## File tree ([FileTree.tsx](../src/FileTree.tsx))

### Features
- **Create** file/folder (icon in tree header or right-click → New file/folder). Creates inline pending row with an input.
- **Rename**: double-click or right-click → Rename. Inline input preselects the stem (not the extension).
- **Delete**: right-click → Delete. Confirmation modal lists file + warns for folders.
- **Multi-delete/hide**: Shift+click rows to toggle selection; right-click empty space or a selected row → Hide N / Delete N (list + confirm).
- **Hide**: right-click → Hide. Adds to `<vault>/.vault-chat-ignore`. Agent still sees hidden files.
- **Refresh tree**: button in Titlebar (spinning icon, 250ms min spin).
- **Reveal in File Explorer**: right-click → File Explorer. OS-native reveal.

### Selection model
- **Single click**: resets `selected` to `{path}`, sets `anchor = path`. Files open; folders toggle collapse.
- **Shift+click**: `toggleSelection(path)` — adds the anchor into `selected` if not present, then toggles the clicked path. *One-at-a-time toggle*, not a range.
- Multi-select gates the context menu: when `selected.size > 1`, only Hide/Delete appear.
- Visual: open-file highlight and folder-context highlight are suppressed while multi-selecting so only the clicked set reads as selected.

### Drag-and-drop
- **Drag source**: every row (files AND folders) is `draggable`. `onDragStart` sets `VAULT_PATH_MIME` (source path) and, if the row is part of a multi-selection, `VAULT_PATHS_MIME` (JSON array of all selected paths). `effectAllowed = "copyMove"`.
- **Drop targets**:
  - Folders → internal move (rename). Rejects self-drop and into-descendant.
  - Tree root container → internal move to vault root OR external file drop (OS files).
  - ChatPane (file attach) and MarkdownArea (open in pane) are separate drop targets elsewhere.
- **External drops** (from OS file manager): detected via `isExternalFileDrop(dt)` when `Files` is in `dt.types`. Copied into the target dir via `write_binary_file_unique` (which suffixes ` (1)` on collision).
- **Post-move** ([FileTree.tsx:146](../src/FileTree.tsx)): for each moved entry, rewrite `currentFile` if it moved, rewrite the `collapsed` Set so expanded folders stay expanded under their new parent.

## Viewers (MarkdownArea → MarkdownView)

`MarkdownView` routes by [fileKind.ts](../src/fileKind.ts) detection:

| Extension | Routes to |
|---|---|
| `.md`, `.markdown` | Markdown editor/viewer |
| `.ipynb` | `NotebookView` (read-only) |
| `.pdf` | `PdfView` |
| `.html`, `.htm` | `HtmlView` |
| image exts | `ImageView` |
| `.xlsx/.docx/.mp4/.mp3/...` | `UnsupportedView` + "open with default app" |
| anything else | Code view (Monaco for edit, highlight.js for view) |

Split-pane inside `MarkdownArea`: drop a file on one of the four edges of an open pane to split horizontally or vertically. Drag a pane handle to rearrange. Allotment handles the geometry.

**Markdown-specific behaviors:**
- **Task checkbox toggle** — clicking a rendered `- [ ]` / `- [x]` checkbox in view mode flips the source. Done by DOM-counting the Nth checkbox, then a regex pass (`flipNthTaskCheckbox`) on the raw file text.
- **Scroll restoration** — when toggling view ↔ edit, the previous scroll position is saved as a ratio of scroll height and re-applied after the layout lands. Keeps your place when switching modes mid-read.
- **Markdown anchor nav** — intra-document links (`[foo](#heading)`) scroll the target into view within the viewer's scroll container, not the document body.

## Marquee ask (PdfView / HtmlView / ImageView)

- **Ctrl+M** toggles marquee mode. Mouse-drag draws a rect.
- **PDF** ([PdfView.tsx](../src/PdfView.tsx)): crop rect → canvas `toDataURL()` for the image, plus extract text from the PDF text layer within the rect.
- **HTML** ([HtmlView.tsx](../src/HtmlView.tsx)): iframe injects a bridge script. `postMessage` sends the rect to the iframe, which uses DOM Range APIs to extract text.
- **Image** ([ImageView.tsx](../src/ImageView.tsx)): crop via canvas `drawImage` mapped to natural pixel coords.
- **Release** pops up `InlineEditPrompt` with `imageDataUrl` + before/after text slices. User types a question; `runInlineAsk()` ([inlineEdit.ts](../src/inlineEdit.ts)) calls a read-only agent (tools limited to Read/Glob/Grep/ListDir/WebFetch/WebSearch) with the image attached.
- **Send to chat**: "MessageSquare" button transplants the ask turns into the main chat pane. Marquee turns get the image in the visible bubble via `![captured region](data:image/...)`; text-selection asks get the quoted selection.

## Inline edit / ask ([InlineEditPrompt.tsx](../src/InlineEditPrompt.tsx))

- Two modes: `edit` (Ctrl+K — rewrites selected text) and `ask` (Ctrl+L — read-only Q&A).
- Positioning: computed rect-aware. Drag the popover 6+ pixels to detach it from the source anchor; after that, its position is sticky.
- Prior turns feed into the next request as conversational history so refinement works.

### Accept / Send-to-chat from an ask

At the bottom of an `ask` result, two buttons:
- **Accept** — for `edit` mode only, replaces the source selection with the result (via the file's underlying `onAccept` callback).
- **Send to chat** (MessageSquare icon) — transplants the ask's entire turn history into the main chat pane. What shows in each user bubble depends on what triggered the ask:
  - **Marquee ask** — visible bubble gets `![captured region](data:image/...)` (the image only; any scraped text is incidental). Surrounding file excerpts ride in a hidden preamble so the model sees context without cluttering the bubble.
  - **Text-selection ask** — visible bubble gets the selection as a `>` blockquote; before/after file slices go in a hidden preamble.
  - **Freeform ask** (no selection, no marquee) — no visible prefix; hidden preamble still carries before/after slices for context.
  - The right chat pane opens automatically if it was collapsed.

## Chat popout ([sync.ts](../src/sync.ts))

- **Spawn**: Titlebar button creates a `WebviewWindow` with label `chat-popout`, URL `index.html?view=chat`. The popout reads its URL param at module load.
- **State sync**: two broadcast channels:
  - `chat:state` — messages, modelId, tokenUsage, lastContext, compactionSummary, compacting, vaultPath. Fires on reference change, not per token.
  - `chat:stream` — busy, streamingText, streamingReasoning, liveTools, agentTodos. Fires at ~5 Hz during streaming.
- **Handshake**: popout sends `chat:ready` on mount with a retry backoff `[0, 150, 400, 900, 1800, 3000]`ms. Main broadcasts current state in response.
- **Action dispatch**: popout-side `send` / `stop` / `clear` / `setModel` are emitted as events back to main, which applies them locally.
- **The docked pane is hidden** when `popoutOpen` by unmounting it (not `visible=false`) so the sash disappears.
- `toggleRight` is a no-op when `popoutOpen` is true — prevents flipping the collapsed flag invisibly and the chat jumping back in after closing the popout.

## Drag / drop MIME registry ([dnd.ts](../src/dnd.ts))

| MIME | Payload | Consumers |
|---|---|---|
| `application/x-vault-path` | single absolute path | FileTree move, MarkdownArea open, ChatPane attach |
| `application/x-vault-paths` | JSON array of paths (multi-drag) | FileTree move |
| `application/x-vault-pane` | pane ID | MarkdownArea rearrange |
| (external) `Files` | browser File list | FileTree external import |

## Rendering conventions

- **User bubble**: markdown via `remark-gfm + remark-breaks + remark-math + rehype-katex`. Math inside `$...$` / `$$...$$` renders as KaTeX (added recently in `b4ac95a` — users asking questions about equations can paste LaTeX and have it render in their own bubble). Data-URL images allowed via `allowImageDataUrls`. The `[attached: ...]` footer is stripped before render.
- **Assistant bubble**: markdown via `remark-gfm + remark-math + rehype-katex + rehype-highlight`. Syntax-highlighted code fences and rendered math by default.
- **Tool calls** under a `<details>` element inside each assistant turn: name + JSON input + optional result preview (capped at 1200 chars). Collapsed by default.

## Live feedback while streaming

- **ThinkingIndicator** — pulsing dot, elapsed-time counter (`1s`, `2s`, …, `mm:ss`), and a live approximate token count (characters ÷ 4 during stream). Anchors at the top of the in-progress assistant bubble.
- **AgentTodoList** — when the agent calls `TodoWrite`, this card appears in the bubble with one row per todo. Glyphs per status: `○` pending / `◐` in_progress (pulsing) / `✓` completed. Counter `done / total` at the top.
- **Jump-to-latest button** — ChatPane watches scroll position. If the user scrolls up during a stream, auto-scroll pauses and a "new messages" pill appears at the bottom right; clicking re-pins and scrolls to the latest. Re-pins automatically when the user scrolls back to the bottom.
- **Context usage ring** — small SVG ring near the model picker showing `lastContext / MODEL_CONTEXT_LIMIT`. Color transitions at 50 % (gray → amber) and 80 % (amber → red) so the user sees compaction coming.

## Chat actions

- **Clear conversation** — trash/Reset button in the chat footer. Wipes `messages`, `tokenUsage`, `lastContext`, `compactionSummary`, and the streaming buffers for the current vault. Does **not** touch `.vault-chat-history` localStorage immediately — it's rewritten on the next debounce cycle (~500 ms later).
- **Stop** — interrupts an in-flight stream via `AbortController` on `abortRef`.
- **Model switcher** — searchable popover; see `docs/chat-pipeline.md` for what changes per provider.
