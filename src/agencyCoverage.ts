// The agent's map of what Carl can see (Native agency: "nothing you see exists only on screen"). Every UI file of the
// laptop app (src/*.tsx, each src/plugins/<part>) and of the phone app (phone/src/*.tsx) has one line here: the state
// the agent reads, changes and watches it through (a plugin's offers: PluginRead / PluginAct {plugin}, a vault page's
// records, the box's own state box:*), or why it is still screen-only (a gap, said plainly), or that it draws nothing
// of its own. server/test/agencyCoverage.test.ts fails when a UI file has no line, or a line names state nobody
// offers: so a change that adds something visible also says how the agent reaches it, and the gaps stay counted.
//
// This is the smallest complete representation's index: one row per thing on screen, pointing at its state.

export type Coverage =
  /** Read / change / watch through these offers (ids as PluginRead names them). `gap`: a part of it that is not yet. */
  | { state: string[]; gap?: string }
  /** Exists only on screen today: what is missing. */
  | { screenOnly: string }
  /** Draws nothing of its own (an entry point, primitives, a host for something listed elsewhere). */
  | { none: string };

/** Every UI file, by path from the repo root. */
export const COVERAGE: Record<string, Coverage> = {
  // ---------------------------------------------------------------- laptop: app parts (src/plugins)
  "src/plugins/ask": { state: ["app/ask"] },
  "src/plugins/chat": { state: ["app/chat"] },
  "src/plugins/chat-rows": { state: ["app/chat-rows"] },
  "src/plugins/chats": { state: ["app/chats"] },
  "src/plugins/composer": { state: ["app/composer"] },
  "src/plugins/context": { state: ["app/context"] },
  "src/plugins/elevenlabs-voice": { none: "draws nothing: its voice is box:settings' voice (and app/elevenlabs-voice's offers)" },
  "src/plugins/filetree": { state: ["app/filetree"] },
  "src/plugins/notes": { state: ["app/notes", "box:notes"] },
  "src/plugins/settings": { state: ["app/settings", "box:settings", "app/titlebar"] },
  "src/plugins/titlebar": { state: ["app/titlebar", "box:workspace"] },
  "src/plugins/vaults": { state: ["app/vaults", "box:links"] },
  "src/plugins/viewer": { state: ["app/viewer"] },
  "src/plugins/voice": { state: ["app/voice"] },

  // ---------------------------------------------------------------- laptop: components (src/*.tsx)
  "src/App.tsx": { state: ["app/titlebar"] },
  // the auto-hidden title bar: box:workspace's layout.titleBarAutoHide, set by its autoHideTitleBar.
  "src/AutoHideTitlebar.tsx": { state: ["box:workspace"] },
  "src/ChangeKeeper.tsx": { state: ["app/changes"] },
  "src/ChangeLine.tsx": { state: ["app/changes"] },
  "src/fileChip.tsx": { state: ["app/composer", "box:workspace"] },
  "src/chatExtras.tsx": { state: ["app/chat"] },
  "src/ChatFooter.tsx": { state: ["app/composer"] },
  "src/ChatHeader.tsx": { state: ["app/chat"] },
  "src/ChatModelPicker.tsx": { state: ["app/composer", "box:settings"] },
  "src/ChatPane.tsx": { state: ["app/chat"] },
  "src/ChatsPanel.tsx": { state: ["app/chats"] },
  "src/ChatWindow.tsx": { state: ["app/chat"] },
  "src/ClaudeCodeSignIn.tsx": { none: "the Claude sign-in flow: it handles a credential, kept out of the agent's reach on purpose (its controls are exempt with that reason)" },
  "src/CodeView.tsx": { state: ["app/viewer"] },
  "src/ComposerPanel.tsx": { state: ["app/composer"] },
  "src/FileTree.tsx": { state: ["app/filetree"] },
  "src/FullscreenChat.tsx": { state: ["app/chat"] },
  "src/HtmlView.tsx": { state: ["app/viewer", "page"] },
  "src/ImageView.tsx": { state: ["app/viewer"] },
  "src/InlineEditPrompt.tsx": { state: ["app/ask"] },
  "src/InlineHtmlFrame.tsx": { state: ["page", "app/chat-rows"] },
  "src/InlineWebPage.tsx": { state: ["app/chat-rows"] },
  "src/laptopReleaseHealth.tsx": { none: "draws nothing (the release probe returns null; LaptopBuild reads the build)" },
  "src/LiveEditor.tsx": { state: ["app/viewer"] },
  "src/main.tsx": { none: "the entry point" },
  "src/MarkdownArea.tsx": { state: ["app/viewer"] },
  "src/Markdown.tsx": { none: "renders markdown for the viewer and the chat rows" },
  "src/MarkdownView.tsx": { state: ["app/viewer"] },
  "src/MasterSection.tsx": { state: ["app/settings"] },
  "src/MonacoEditor.tsx": { state: ["app/viewer"] },
  "src/NewProjectForm.tsx": { state: ["app/vaults"] },
  "src/NotebookView.tsx": { state: ["app/viewer"] },
  "src/NotePopup.tsx": { state: ["app/notes"] },
  "src/NoteWidget.tsx": { state: ["app/notes"] },
  "src/OngoingLine.tsx": { state: ["app/chat"] },
  "src/PdfView.tsx": { state: ["app/viewer"] },
  "src/PluginMount.tsx": { none: "hosts a plugin or page listed elsewhere" },
  "src/PluginOff.tsx": { state: ["app/changes"] },
  "src/ProjectChip.tsx": { none: "the chat list's project hooks; its chip is not mounted" },
  "src/SearchPicker.tsx": { none: "the picker primitive (Settings): each use names its own offer" },
  "src/SettingsPane.tsx": { state: ["app/settings", "box:settings"] },
  "src/TexView.tsx": { state: ["app/viewer"] },
  "src/TileArea.tsx": { state: ["box:workspace"] },
  "src/TileComposer.tsx": { state: ["box:chats"] },
  "src/TileTitle.tsx": { state: ["box:workspace"] },
  "src/Titlebar.tsx": { state: ["app/titlebar"] },
  "src/ui.tsx": { none: "UI primitives" },
  "src/UnsupportedView.tsx": { state: ["app/viewer"] },
  "src/UpdateBanner.tsx": { state: ["app/titlebar"] },
  "src/UsagePopover.tsx": { state: ["app/composer"] },
  "src/VaultPicker.tsx": { state: ["app/vaults"] },
  "src/VideoPlayer.tsx": { state: ["app/viewer"] },
  "src/VideoView.tsx": { state: ["app/viewer"] },
  "src/voiceParts.tsx": { state: ["app/voice"] },
  "src/VoiceSlot.tsx": { state: ["app/voice"] },
  "src/WindowControls.tsx": { state: ["app/titlebar"] },

  // ---------------------------------------------------------------- the box: things Carl sees that no UI file owns
  "box/alerts": { state: ["box:alerts"] },
  "box/queue": { state: ["box:queue"] },
  "box/history": { state: ["box:history"] },
  "box/notes-to-agent": { state: ["box:notes"] },

  // ---------------------------------------------------------------- phone
  "phone/src/App.tsx": { state: ["box:notes", "box:alerts", "box:links"] },
  "phone/src/main.tsx": { none: "the entry point" },
};

/** State ids that are not app plugins: the change lines, vault pages' records, the box's own offers. */
export const OTHER_STATE = ["app/changes", "page", "box:settings", "box:notes", "box:alerts", "box:pages", "box:workspace", "box:jobs", "box:chats", "box:links", "box:logs", "box:perf", "box:history", "box:queue"];

/** The share of rows whose thing on screen is state (a row with a gap counts half), of the rows that draw something. */
export function coveragePercent(rows: Record<string, Coverage> = COVERAGE, prefix = ""): number {
  let n = 0;
  let got = 0;
  for (const [k, c] of Object.entries(rows)) {
    if (!k.startsWith(prefix) || "none" in c) continue;
    n++;
    if ("state" in c) got += c.gap ? 0.5 : 1;
  }
  return n ? Math.round((got / n) * 100) : 100;
}

/**
 * Why a control on screen may have no offer (data-offer-exempt="<one of these>"): the only reasons there are. Every
 * other button, input, select, textarea and clickable element names the model action it runs (data-offer=
 * "app/<part>.<action>" or "box:<noun>.<action>"), and server/test/agencyCoverage.test.ts fails on one that names
 * neither (report 28: no control may bypass the model). Add a reason only with Carl's word.
 */
export const EXEMPT_REASONS: readonly string[] = [
  "the Claude sign-in: it handles a credential, kept out of the agent's reach on purpose",
  "Keys: a key is a secret, never state the agent reads or sets",
  "pushes this laptop's keys to the box again: keys are secrets",
  "a UI primitive: each use names its own offer",
  "ProjectChip's chip is not mounted anywhere (only its hooks are used)",
  "an AskUser answer card (left out of report 28: the agent's own question back to Carl)",
  "Undo of a change line (left out of report 28: Undo is the change flow's own)",
  "a markdown checkbox's rendering (a GFM task box): ticking writes the file, which the agent edits as a file",
  "a markdown checkbox (a GFM task box): ticking writes the file, which the agent edits as a file",
  "a menu's container: it only keeps a click from reaching the tree (its items name their offers)",
  "Copy path: puts a path on Carl's clipboard; the agent reads the path from the chat itself",
];
