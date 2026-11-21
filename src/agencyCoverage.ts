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
  "src/plugins/elevenlabs-voice": { state: ["app/elevenlabs-voice"] },
  "src/plugins/filetree": { state: ["app/filetree"] },
  "src/plugins/notes": { state: ["app/notes", "box:notes"] },
  "src/plugins/settings": { state: ["app/settings", "box:settings"] },
  "src/plugins/titlebar": { state: ["app/titlebar"], gap: "the sync chip is read-only (no action on a conflict)" },
  "src/plugins/vaults": { state: ["app/vaults", "box:links"] },
  "src/plugins/viewer": { state: ["app/viewer"], gap: "an editor's unsaved text and its caret" },
  "src/plugins/voice": { state: ["app/voice"] },

  // ---------------------------------------------------------------- laptop: components (src/*.tsx)
  "src/App.tsx": { state: ["app/titlebar"] },
  "src/ChangeKeeper.tsx": { state: ["app/changes"] },
  "src/ChangeLine.tsx": { state: ["app/changes"] },
  "src/chatExtras.tsx": { state: ["app/chat"] },
  "src/ChatFooter.tsx": { state: ["app/composer"] },
  "src/ChatHeader.tsx": { state: ["app/chat"] },
  "src/ChatModelPicker.tsx": { state: ["app/composer", "box:settings"] },
  "src/ChatPane.tsx": { state: ["app/chat"] },
  "src/ChatsPanel.tsx": { state: ["app/chats"] },
  "src/ChatWindow.tsx": { state: ["app/chat"] },
  "src/ClaudeCodeSignIn.tsx": { screenOnly: "the sign-in flow (it handles a credential, so it stays out of the state on purpose)" },
  "src/CodeView.tsx": { state: ["app/viewer"], gap: "unsaved text, caret" },
  "src/ComposerPanel.tsx": { state: ["app/composer"] },
  "src/FileTree.tsx": { state: ["app/filetree"] },
  "src/FullscreenChat.tsx": { state: ["app/chat"] },
  "src/HtmlView.tsx": { state: ["app/viewer", "page"] },
  "src/ImageView.tsx": { state: ["app/viewer"] },
  "src/InlineEditPrompt.tsx": { state: ["app/ask"] },
  "src/InlineHtmlFrame.tsx": { state: ["page"], gap: "drawn as a labelled box by Screen" },
  "src/InlineWebPage.tsx": { screenOnly: "a web page shown inline in the chat: no state, no picture" },
  "src/laptopReleaseHealth.tsx": { screenOnly: "the release health line (LaptopBuild reads the build, not this line)" },
  "src/LiveEditor.tsx": { state: ["app/viewer"], gap: "unsaved text, caret" },
  "src/main.tsx": { none: "the entry point" },
  "src/MarkdownArea.tsx": { state: ["app/viewer"], gap: "unsaved text, caret" },
  "src/Markdown.tsx": { none: "renders markdown for the viewer and the chat rows" },
  "src/MarkdownView.tsx": { state: ["app/viewer"] },
  "src/MasterSection.tsx": { state: ["app/settings"] },
  "src/MonacoEditor.tsx": { state: ["app/viewer"], gap: "unsaved text, caret" },
  "src/NewProjectForm.tsx": { state: ["app/vaults"] },
  "src/NotebookView.tsx": { state: ["app/viewer"] },
  "src/NotePopup.tsx": { state: ["app/notes"] },
  "src/NoteWidget.tsx": { state: ["app/notes"] },
  "src/OngoingLine.tsx": { state: ["app/chat"] },
  "src/PdfView.tsx": { state: ["app/viewer"] },
  "src/PluginMount.tsx": { none: "hosts a plugin or page listed elsewhere" },
  "src/PluginOff.tsx": { state: ["app/changes"] },
  "src/ProjectChip.tsx": { state: ["app/chats"] },
  "src/SearchPicker.tsx": { screenOnly: "the quick file picker: its query and matches" },
  "src/SettingsPane.tsx": { state: ["app/settings", "box:settings"] },
  "src/ShortcutSheet.tsx": { screenOnly: "the shortcut sheet: whether it is open" },
  "src/TexView.tsx": { state: ["app/viewer"] },
  "src/Titlebar.tsx": { state: ["app/titlebar"] },
  "src/ui.tsx": { none: "UI primitives" },
  "src/UnsupportedView.tsx": { state: ["app/viewer"] },
  "src/UpdateBanner.tsx": { screenOnly: "the update banner and its Install & restart (LaptopBuild reads versions only)" },
  "src/UsagePopover.tsx": { screenOnly: "the plan usage popover (Cost reads spend, not this)" },
  "src/VaultPicker.tsx": { state: ["app/vaults"] },
  "src/VaultPluginHost.tsx": { state: ["page"] },
  "src/VideoPlayer.tsx": { state: ["app/viewer"], gap: "playback position" },
  "src/VideoView.tsx": { state: ["app/viewer"], gap: "playback position" },
  "src/voiceParts.tsx": { state: ["app/voice"] },
  "src/VoiceSlot.tsx": { state: ["app/voice"] },
  "src/WindowControls.tsx": { state: ["app/titlebar"] },

  // ---------------------------------------------------------------- phone
  "phone/src/App.tsx": { state: ["app/phone", "box:notes"], gap: "the drawer, the open file and its scroll" },
  "phone/src/main.tsx": { none: "the entry point" },
};

/** State ids that are not app plugins: the change lines, the preset, the phone app, vault pages' records, the box's own offers. */
export const OTHER_STATE = ["app/changes", "app/preset", "app/phone", "page", "box:settings", "box:notes", "box:jobs", "box:links", "box:logs"];

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
