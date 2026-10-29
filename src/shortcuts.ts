// Every keyboard shortcut of the laptop app, in one place. The handlers read
// their chords from here (`hit(e, id)`, `cmKey(id)`, `monacoKeys(id)`) and the
// shortcut sheet (Ctrl+/, ShortcutSheet.tsx) lists exactly this table, so the
// sheet cannot go stale. test/harness/shortcuts.test.ts greps the key handlers
// in src/ and fails on a key that is handled in code but missing here.
//
// Chord syntax: modifiers then the key, joined by "+". "Mod" is Ctrl on
// Windows/Linux and Cmd on a Mac (ctrlKey || metaKey); "Ctrl" is the Ctrl key
// only, on every platform. A shortcut with several chords lists them all.
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
  { id: "chat.send", keys: ["Enter"], label: "Send / steer", group: "Chat & composer", where: "the composer, Ctrl+K/L, a note, voice text", files: ["src/ChatPane.tsx", "src/InlineEditPrompt.tsx", "src/NotePopup.tsx", "src/VoiceTextPanel.tsx"] },
  { id: "chat.newline", keys: ["Shift+Enter"], label: "New line", group: "Chat & composer", where: "the composer", files: ["src/ChatPane.tsx"] },
  { id: "chat.queue", keys: ["Tab"], label: "Queue a follow-up", group: "Chat & composer", where: "the composer, while the agent works", files: ["src/ChatPane.tsx"] },
  { id: "chat.stop", keys: ["Esc"], label: "Stop the agent", group: "Chat & composer", where: "the composer, while the agent works", files: ["src/ChatPane.tsx", "src/InlineEditPrompt.tsx"] },
  { id: "chat.menuMove", keys: ["ArrowUp", "ArrowDown"], label: "Move in menus", group: "Chat & composer", where: "@file and /command menus", files: ["src/ChatPane.tsx", "src/InlineEditPrompt.tsx", "src/NotePopup.tsx"] },
  { id: "chat.menuPick", keys: ["Tab", "Enter"], label: "Pick from menu", group: "Chat & composer", where: "@file and /command menus", files: ["src/ChatPane.tsx", "src/InlineEditPrompt.tsx", "src/NotePopup.tsx"] },

  // ---- Voice
  { id: "voice.toggle", keys: ["Ctrl+D"], label: "Voice on / off", group: "Voice", where: "anywhere", files: ["src/App.tsx", "src/ChatWindow.tsx"] },
  { id: "voice.mute", keys: ["Ctrl+Shift+M"], label: "Mute / unmute", group: "Voice", where: "during a call", files: ["src/App.tsx"] },

  // ---- Views & windows
  { id: "view.shortcuts", keys: ["Mod+/"], label: "Keyboard shortcuts", group: "Views & windows", where: "anywhere", files: ["src/ShortcutSheet.tsx"] },
  { id: "view.files", keys: ["Mod+B"], label: "Files / chats panel", group: "Views & windows", where: "anywhere (fullscreen: the chats)", files: ["src/App.tsx", "src/ChatWindow.tsx"] },
  { id: "view.chat", keys: ["Mod+Shift+B"], label: "Chat panel", group: "Views & windows", where: "the main window", files: ["src/App.tsx"] },
  { id: "view.fullscreen", keys: ["Mod+Shift+F"], label: "Fullscreen chat", group: "Views & windows", where: "the main window", files: ["src/App.tsx"] },
  { id: "view.terminal", keys: ["Mod+J"], label: "Terminal", group: "Views & windows", where: "anywhere (the box's, for a box vault)", files: ["src/App.tsx"] },
  { id: "view.terminalOther", keys: ["Mod+Shift+J"], label: "Laptop terminal", group: "Views & windows", where: "anywhere", files: ["src/App.tsx"] },
  { id: "view.theme", keys: ["Alt+L"], label: "Light / dark", group: "Views & windows", where: "anywhere", files: ["src/App.tsx"] },
  {
    id: "view.close",
    keys: ["Esc"],
    label: "Close / cancel",
    group: "Views & windows",
    where: "popovers, panels, dialogs, a capture, the open background-tasks list",
    files: [
      "src/App.tsx",
      "src/ShortcutSheet.tsx",
      "src/ChatsPanel.tsx",
      "src/NewProjectForm.tsx",
      "src/VaultPicker.tsx",
      "src/NotesPanel.tsx",
      "src/NotePopup.tsx",
      "src/Titlebar.tsx",
      "src/FileTree.tsx",
      "src/InlineEditPrompt.tsx",
      "src/VoiceTextPanel.tsx",
      "src/ProjectChip.tsx",
      "src/SettingsPane.tsx",
      "src/AgentModelPicker.tsx",
      "src/ChatPane.tsx",
      "src/PdfView.tsx",
      "src/HtmlView.tsx",
      "src/ImageView.tsx",
      "src/chatExtras.tsx",
      "src/ShipmentProofViewer.tsx",
    ],
  },

  // ---- Editing
  { id: "edit.inline", keys: ["Mod+K"], label: "Edit selection", group: "Editing", where: "an editor", files: ["src/LiveEditor.tsx", "src/MonacoEditor.tsx"] },
  { id: "edit.ask", keys: ["Mod+L"], label: "Ask about it", group: "Editing", where: "a file", files: ["src/LiveEditor.tsx", "src/MonacoEditor.tsx", "src/MarkdownView.tsx"] },
  { id: "edit.mode", keys: ["Mod+E"], label: "Edit / view", group: "Editing", where: "an open file", files: ["src/App.tsx"] },
  { id: "edit.marquee", keys: ["Mod+M"], label: "Capture a region", group: "Editing", where: "a PDF, HTML page or image", files: ["src/MarkdownView.tsx"] },
  { id: "edit.confirm", keys: ["Enter"], label: "Confirm a name", group: "Editing", where: "rename, new project, a key", files: ["src/FileTree.tsx", "src/ChatsPanel.tsx", "src/NewProjectForm.tsx", "src/VaultPicker.tsx", "src/ProjectChip.tsx", "src/SettingsPane.tsx", "src/AgentModelPicker.tsx"] },

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
  if (key.length === 1) return e.key.toLowerCase() === key.toLowerCase();
  return e.key === key;
}

/** Whether the event is exactly this chord (modifiers included). */
export function chordMatches(e: KeyLike, chord: string): boolean {
  const c = parseChord(chord);
  if (c.mod) {
    if (!e.ctrlKey && !e.metaKey) return false;
  } else if (e.ctrlKey !== c.ctrl || e.metaKey) return false;
  if (e.shiftKey !== c.shift || e.altKey !== c.alt) return false;
  return keyIs(e, c.key);
}

/** Whether the event is one of the shortcut's chords. */
export function hit(e: KeyLike, id: ShortcutId): boolean {
  return shortcut(id).keys.some((k) => chordMatches(e, k));
}

/** The shortcut's first chord as CodeMirror writes it ("Mod-k"). */
export function cmKey(id: ShortcutId): string {
  const c = parseChord(shortcut(id).keys[0]!);
  return [c.mod && "Mod", c.ctrl && "Ctrl", c.alt && "Alt", c.shift && "Shift", c.key.toLowerCase()].filter(Boolean).join("-");
}

/** The shortcut's first chord as Monaco's keybinding number. Letters only. */
export function monacoKeys(id: ShortcutId, m: { KeyMod: { CtrlCmd: number; WinCtrl: number; Shift: number; Alt: number }; KeyCode: Record<string, unknown> }): number {
  const c = parseChord(shortcut(id).keys[0]!);
  const code = m.KeyCode[`Key${c.key.toUpperCase()}`] as number;
  return (c.mod ? m.KeyMod.CtrlCmd : 0) | (c.ctrl ? m.KeyMod.WinCtrl : 0) | (c.shift ? m.KeyMod.Shift : 0) | (c.alt ? m.KeyMod.Alt : 0) | code;
}

export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

const KEY_NAMES: Record<string, string> = { ArrowUp: "↑", ArrowDown: "↓", Enter: "Enter", Esc: "Esc", Tab: "Tab" };

/** A chord as key caps for this platform: ["Ctrl", "Shift", "F"] or ["⌘", "⇧", "F"]. */
export function chordLabel(chord: string, mac = IS_MAC): string[] {
  const c = parseChord(chord);
  const caps: string[] = [];
  if (c.ctrl) caps.push(mac ? "⌃" : "Ctrl");
  if (c.mod) caps.push(mac ? "⌘" : "Ctrl");
  if (c.alt) caps.push(mac ? "⌥" : "Alt");
  if (c.shift) caps.push(mac ? "⇧" : "Shift");
  caps.push(KEY_NAMES[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key));
  return caps;
}

/** The chord as one string, for tooltips: "Ctrl+Shift+F" / "⌘⇧F". */
export function chordText(chord: string, mac = IS_MAC): string {
  return chordLabel(chord, mac).join(mac ? "" : "+");
}
