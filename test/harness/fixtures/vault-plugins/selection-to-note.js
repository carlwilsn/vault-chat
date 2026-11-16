// An example vault plugin (put it in <vault>/.vault-chat/plugins/): plugins composing through the shared context and
// each other's offers. Each new selection Carl makes (a file's text, a chat message, a note) becomes a note through
// the Notes plugin's own `add` action (app/notes), with no change to either: the shared context in, app/notes out.
export const meta = { name: "Selection to note", description: "Keeps each new selection as a note, through app/notes' add." };

export function mount(_el, api) {
  let kept = 0;
  let last = "";
  const offers = api.offer({
    state: { kept: { description: "notes made from selections", read: () => kept } },
    events: { kept: { description: "a note was made from a selection ({id, from})" } },
  });
  api.context.on(async (ctx, changed) => {
    const s = ctx.selection;
    if (!changed.includes("selection") || !s) return;
    const text = s.text.trim();
    if (!text || text === last) return;
    last = text;
    const where =
      s.kind === "file" ? `${s.path}${s.lineStart ? `:${s.lineStart}` : ""}` :
      s.kind === "message" ? `chat message ${s.messageId}` :
      s.kind === "note" ? `note ${s.noteId}` : s.path || "";
    const r = await api.plugins.act("app/notes", "add", {
      text: `"${text.slice(0, 200)}"${where ? ` (${where})` : ""}`,
      ...(s.kind === "file" ? { source_path: s.path } : {}),
    });
    if (r.ok) {
      kept++;
      offers.emit("kept", { id: r.result && r.result.added, from: s.kind });
    } else {
      api.host.notify(`Selection to note: ${r.error}`, "error");
    }
  });
}
