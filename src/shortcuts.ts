// Every keyboard shortcut of the laptop app, in one place. The handlers read
// their chords from here (`hit(e, id)`, `cmKey(id)`, `monacoKeys(id)`), and
// app/settings' state `shortcuts` lists exactly this table (Carl asks the agent;
// there is no sheet on screen), so the list cannot go stale. test/harness/shortcuts.test.ts greps the key handlers
// in src/ and fails on a key that is handled in code but missing here.
//
// Chord syntax: modifiers then the key, joined by "+". "Mod" is the platform's
// mod key (`isMod`): Ctrl on Windows/Linux (ctrlKey || metaKey, as always), Cmd
// on a Mac (metaKey only: Ctrl+A/E/K/N/B… stay the Mac's own text keys in every
// field). "Ctrl" is the Ctrl key only on Windows/Linux and Cmd on a Mac too:
// every app shortcut that is Ctrl+X there is Cmd+X on a Mac. Labels and hints
// come from `chordText` / `shortcutHint` (⌘ on a Mac, "Ctrl+" elsewhere). A
// shortcut with several chords lists them all.
// `files`: where it is handled (the registry test checks each one).

export type ShortcutGroup =
  | "Chat & composer"
  | "Voice"
  | "Views & windows"
  | "Editing"
  | "Files"
  | "Box & diagnostics";

/** The sheet's order (two balanced columns: Chat and Editing on the left). */
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  "Chat & composer",
  "Editing",
  "Views & windows",
  "Voice",
  "Files",
  "Box & diagnostics",
];

export type Shortcut = {
  id: string;
  /** One or more chords, e.g. ["Mod+Shift+F"]. */
  keys: readonly string[];
  /** 2–4 words: what the sheet shows. */
  label: string;
  group: ShortcutGroup;
  /** Where it applies (anywhere, the composer, an editor, a popover …). */
  where: string;
  files: readonly string[];
};

export const SHORTCUTS = [
  // ---- Chat & composer
  { id: "chat.new", keys: ["Mod+T"], label: "Go to Main", group: "Chat & composer", where: "anywhere", files: ["src/App.tsx", "src/ChatWindow.tsx"] },
  { id: "chat.send", keys: ["Enter"], label: "Send / steer", group: "Chat & composer", where: "the composer, Ctrl+K/L, a note, voice text", files: ["src/plugins/composer/Composer.tsx", "src/ComposerPanel.tsx", "src/plugins/ask/Prompt.tsx", "src/NotePopup.tsx", "src/plugins/voice/TextPanel.tsx"] },
  { id: "chat.newline", keys: ["Shift+Enter"], label: "New line", group: "Chat & composer", where: "the composer", files: ["src/plugins/composer/Composer.tsx"] },
  { id: "chat.queue", keys: ["Tab"], label: "Queue a follow-up", group: "Chat & composer", where: "the composer, while the agent works", files: ["src/plugins/composer/Composer.tsx"] },
  { id: "chat.stop", keys: ["Esc"], label: "Stop the agent", group: "Chat & composer", where: "the composer, while the agent works", files: ["src/plugins/composer/Composer.tsx", "src/ComposerPanel.tsx", "src/plugins/ask/Prompt.tsx"] },
  { id: "chat.menuMove", keys: ["ArrowUp", "ArrowDown"], label: "Move in menus", group: "Chat & composer", where: "@file and /command menus", files: ["src/plugins/composer/Composer.tsx", "src/plugins/ask/Prompt.tsx", "src/NotePopup.tsx"] },
  { id: "chat.menuPick", keys: ["Tab", "Enter"], label: "Pick from menu", group: "Chat & composer", where: "@file and /command menus", files: ["src/plugins/composer/Composer.tsx", "src/plugins/ask/Prompt.tsx", "src/NotePopup.tsx"] },
  { id: "chat.chipDelete", keys: ["Backspace", "Delete"], label: "Delete file chip", group: "Chat & composer", where: "next to a file chip in the composer (it goes whole)", files: ["src/plugins/composer/chips.ts"] },
  { id: "chat.chipStep", keys: ["ArrowLeft", "ArrowRight"], label: "Skip a file chip", group: "Chat & composer", where: "next to a file chip in the composer", files: ["src/plugins/composer/chips.ts"] },
  { id: "chat.chipOpen", keys: ["Enter"], label: "Open a file chip", group: "Chat & composer", where: "a file chip in a message, focused", files: ["src/fileChip.tsx"] },

  // ---- Voice
  { id: "voice.toggle", keys: ["Ctrl+D"], label: "Voice on / off", group: "Voice", where: "anywhere", files: ["src/App.tsx", "src/ChatWindow.tsx"] },
  { id: "voice.mute", keys: ["Ctrl+Shift+M"], label: "Mute / unmute", group: "Voice", where: "during a call", files: ["src/App.tsx"] },

  // ---- Views & windows
  { id: "view.files", keys: ["Mod+B"], label: "Files / chats panel", group: "Views & windows", where: "anywhere (fullscreen: the chats)", files: ["src/App.tsx", "src/ChatWindow.tsx"] },
  { id: "view.chat", keys: ["Mod+Shift+B"], label: "Chat panel", group: "Views & windows", where: "the main window", files: ["src/App.tsx"] },
  { id: "view.fullscreen", keys: ["Mod+Shift+F"], label: "Fullscreen chat", group: "Views & windows", where: "the main window", files: ["src/App.tsx"] },
  { id: "view.terminal", keys: ["Mod+J"], label: "Terminal", group: "Views & windows", where: "anywhere (the box's, for a box vault)", files: ["src/App.tsx"] },
  { id: "view.terminalOther", keys: ["Mod+Shift+J"], label: "Laptop terminal", group: "Views & windows", where: "anywhere", files: ["src/App.tsx"] },
  { id: "view.theme", keys: ["Alt+L"], label: "Light / dark", group: "Views & windows", where: "anywhere", files: ["src/App.tsx"] },
  { id: "view.vaultActionMove", keys: ["ArrowDown", "ArrowUp", "Home", "End"], label: "Move between actions", group: "Views & windows", where: "the vault picker's folder-action menu", files: ["src/plugins/vaults/Picker.tsx"] },
  { id: "view.vaultActionLeave", keys: ["Tab", "Shift+Tab"], label: "Leave folder actions", group: "Views & windows", where: "the vault picker's folder-action menu; normal tabbing continues", files: ["src/plugins/vaults/Picker.tsx"] },
  {
    id: "view.close",
    keys: ["Esc"],
    label: "Close / cancel",
    group: "Views & windows",
    where: "popovers, panels, dialogs, a capture, the open background-tasks list, a web page shown full window",
    files: [
      "src/fileChip.tsx",
      "src/App.tsx",
      "src/InlineWebPage.tsx",
      "src/ChatsPanel.tsx",
      "src/plugins/chats/ChatsList.tsx",
      "src/NewProjectForm.tsx",
      "src/plugins/vaults/Picker.tsx",
      "src/plugins/notes/NotesPanel.tsx",
      "src/NotePopup.tsx",
      "src/plugins/titlebar/Bar.tsx",
      "src/plugins/chat/Header.tsx",
      "src/plugins/filetree/Tree.tsx",
      "src/plugins/ask/Prompt.tsx",
      "src/plugins/voice/TextPanel.tsx",
      "src/ProjectChip.tsx",
      "src/plugins/settings/Pane.tsx",
      "src/SearchPicker.tsx",
      "src/ChatModelPicker.tsx",
      "src/UsagePopover.tsx",
      "src/plugins/composer/Composer.tsx",
      "src/PdfView.tsx",
      "src/HtmlView.tsx",
      "src/ImageView.tsx",
      "src/chatExtras.tsx",
    ],
  },

  // ---- Editing
  { id: "web.address", keys: ["Enter", "Esc"], label: "Go / revert address", group: "Editing", where: "a web pane's address bar", files: ["src/plugins/viewer/WebPane.tsx"] },
  { id: "edit.inline", keys: ["Mod+K"], label: "Ask or edit", group: "Editing", where: "an editor", files: ["src/LiveEditor.tsx", "src/MonacoEditor.tsx"] },
  { id: "edit.ask", keys: ["Mod+L"], label: "Ask or edit", group: "Editing", where: "a file", files: ["src/LiveEditor.tsx", "src/MonacoEditor.tsx", "src/plugins/viewer/Pane.tsx"] },
  { id: "edit.mode", keys: ["Mod+E"], label: "Edit / view", group: "Editing", where: "an open file", files: ["src/App.tsx"] },
  { id: "edit.marquee", keys: ["Mod+M"], label: "Capture a region", group: "Editing", where: "a PDF, HTML page or image", files: ["src/plugins/viewer/Pane.tsx"] },
  { id: "edit.confirm", keys: ["Enter"], label: "Confirm a name", group: "Editing", where: "rename, new project, a key", files: ["src/plugins/filetree/Tree.tsx", "src/plugins/chats/ChatsList.tsx", "src/NewProjectForm.tsx", "src/plugins/vaults/Picker.tsx", "src/ProjectChip.tsx", "src/plugins/settings/Pane.tsx", "src/SearchPicker.tsx", "src/ClaudeCodeSignIn.tsx"] },

  // ---- A video (the app's own player, src/VideoPlayer.tsx)
  { id: "video.play", keys: [" "], label: "Play / pause", group: "Views & windows", where: "a video with focus", files: ["src/VideoPlayer.tsx"] },
  { id: "video.back", keys: ["ArrowLeft"], label: "Back 5 seconds", group: "Views & windows", where: "a video with focus", files: ["src/VideoPlayer.tsx"] },
  { id: "video.forward", keys: ["ArrowRight"], label: "Forward 5 seconds", group: "Views & windows", where: "a video with focus", files: ["src/VideoPlayer.tsx"] },
  { id: "video.mute", keys: ["M"], label: "Mute video", group: "Views & windows", where: "a video with focus", files: ["src/VideoPlayer.tsx"] },
  { id: "video.full", keys: ["F"], label: "Video full screen", group: "Views & windows", where: "a video with focus", files: ["src/VideoPlayer.tsx"] },
  { id: "change.undo", keys: ["Mod+Alt+Z"], label: "Undo last change", group: "Views & windows", where: "anywhere: the app's shell undoes it, even when a change broke the screen", files: ["src/changeSafety.ts", "src-tauri/src/safety.rs"] },

  // ---- Files
  { id: "files.note", keys: ["Mod+N"], label: "New note", group: "Files", where: "anywhere, with a vault", files: ["src/App.tsx"] },

  // ---- Box & diagnostics
  { id: "box.diag", keys: ["Mod+Shift+D"], label: "Diagnostics bundle", group: "Box & diagnostics", where: "the main window", files: ["src/diag.ts"] },
] as const satisfies readonly Shortcut[];

export type ShortcutId = (typeof SHORTCUTS)[number]["id"];

/** Keys the webview would act on that the app turns off (find bar, reload,
 *  print, save page). Not shortcuts: the sheet does not list them. */
export const SUPPRESSED_KEYS = { keys: ["Mod+F", "Mod+G", "Mod+R", "Mod+P", "Mod+S", "F5"], files: ["src/App.tsx", "src/ChatWindow.tsx"] } as const;

export function shortcut(id: ShortcutId): Shortcut {
  return SHORTCUTS.find((s) => s.id === id)!;
}

type KeyLike = { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean };

/** The chord's modifiers and key. */
export function parseChord(chord: string): { mod: boolean; ctrl: boolean; shift: boolean; alt: boolean; key: string } {
  const parts = chord.split("+");
  const key = parts.pop()!;
  return { mod: parts.includes("Mod"), ctrl: parts.includes("Ctrl"), shift: parts.includes("Shift"), alt: parts.includes("Alt"), key };
}

function keyIs(e: KeyLike, key: string): boolean {
  if (key === "Esc") return e.key === "Escape";
  if (key === "/") return e.key === "/" || e.code === "Slash";
  if (key.length === 1) {
    if (e.key.toLowerCase() === key.toLowerCase()) return true;
    // Option+L on a Mac types "¬": the physical key decides there.
    return e.altKey && /^[a-z]$/i.test(key) && e.code === `Key${key.toUpperCase()}`;
  }
  return e.key === key;
}

export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

/** Whether the platform's mod key is down: Cmd on a Mac, Ctrl (or the Windows/Super key, as always) elsewhere. */
export function isMod(e: { ctrlKey: boolean; metaKey: boolean }, mac = IS_MAC): boolean {
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey || e.metaKey;
}

/** Whether the event is exactly this chord (modifiers included). On a Mac both Mod and Ctrl are Cmd. */
export function chordMatches(e: KeyLike, chord: string, mac = IS_MAC): boolean {
  const c = parseChord(chord);
  if (mac) {
    if ((c.mod || c.ctrl) !== (e.metaKey && !e.ctrlKey) || (!c.mod && !c.ctrl && e.ctrlKey)) return false;
  } else if (c.mod) {
    if (!e.ctrlKey && !e.metaKey) return false;
  } else if (e.ctrlKey !== c.ctrl || e.metaKey) return false;
  if (e.shiftKey !== c.shift || e.altKey !== c.alt) return false;
  return keyIs(e, c.key);
}

/** Whether the event is one of the shortcut's chords. */
export function hit(e: KeyLike, id: ShortcutId, mac = IS_MAC): boolean {
  return shortcut(id).keys.some((k) => chordMatches(e, k, mac));
}

/** The shortcut's first chord as CodeMirror writes it ("Mod-k"; CodeMirror's Mod is Cmd on a Mac). */
export function cmKey(id: ShortcutId, mac = IS_MAC): string {
  const c = parseChord(shortcut(id).keys[0]!);
  return [(c.mod || (mac && c.ctrl)) && "Mod", !mac && c.ctrl && "Ctrl", c.alt && "Alt", c.shift && "Shift", c.key.toLowerCase()].filter(Boolean).join("-");
}

/** The shortcut's first chord as Monaco's keybinding number. Letters only. */
export function monacoKeys(id: ShortcutId, m: { KeyMod: { CtrlCmd: number; WinCtrl: number; Shift: number; Alt: number }; KeyCode: Record<string, unknown> }, mac = IS_MAC): number {
  const c = parseChord(shortcut(id).keys[0]!);
  const code = m.KeyCode[`Key${c.key.toUpperCase()}`] as number;
  return (c.mod || (mac && c.ctrl) ? m.KeyMod.CtrlCmd : 0) | (c.ctrl && !mac ? m.KeyMod.WinCtrl : 0) | (c.shift ? m.KeyMod.Shift : 0) | (c.alt ? m.KeyMod.Alt : 0) | code;
}

const KEY_NAMES: Record<string, string> = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", " ": "Space", Enter: "Enter", Esc: "Esc", Tab: "Tab" };

/** A chord as key caps for this platform: ["Ctrl", "Shift", "F"] or ["⌘", "⇧", "F"]. */
export function chordLabel(chord: string, mac = IS_MAC): string[] {
  const c = parseChord(chord);
  const caps: string[] = [];
  if (c.ctrl || c.mod) caps.push(mac ? "⌘" : "Ctrl");
  if (c.alt) caps.push(mac ? "⌥" : "Alt");
  if (c.shift) caps.push(mac ? "⇧" : "Shift");
  caps.push(KEY_NAMES[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key));
  return caps;
}

/** The chord as one string, for tooltips and hints: "Ctrl+Shift+F" / "⌘⇧F". */
export function chordText(chord: string, mac = IS_MAC): string {
  return chordLabel(chord, mac).join(mac ? "" : "+");
}

/** A shortcut's first chord as a hint for this platform: shortcutHint("view.files") is "Ctrl+B" / "⌘B". */
export function shortcutHint(id: ShortcutId, mac = IS_MAC): string {
  return chordText(shortcut(id).keys[0]!, mac);
}
