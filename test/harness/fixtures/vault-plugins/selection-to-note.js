// An example vault plugin (put it in <vault>/.vault-chat/plugins/): plugins composing through the shared context and
// the notes model. Each new selection Carl makes (a file's text, a chat message, a note) becomes a note through the
// notes noun's add (api.host.notes.add: the box's box:notes add, what the Notes panel uses), with no change to either.
export const meta = { name: "Selection to note", description: "Keeps each new selection as a note, through the notes noun's add." };

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
    const r = await api.host.notes.add(`"${text.slice(0, 200)}"${where ? ` (${where})` : ""}`, s.kind === "file" ? s.path : undefined);
    if (r.ok) {
      kept++;
      offers.emit("kept", { id: r.id, from: s.kind });
    } else {
      api.host.notify(`Selection to note: ${r.error}`, "error");
    }
  });
}
