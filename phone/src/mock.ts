// The phone app against a fixture box (?mock=1, the dev server and the preview harness): alerts and notes, in
// memory. No network.
export function installMock() {
  const now = Date.now();
  const M = 60_000, H = 60 * M, D = 24 * H;
  const iso = (t: number) => new Date(t).toISOString();
  const note = (id: string, text: string, at: number, status = "open"): NoteItem => ({ id, status, timestamp: iso(at), last_updated: iso(at), user_draft: text, title: null });
  // The preview harness (preview/phone.mjs) hands in a scenario DB here.
  const DB: MockDB = window.__VC_PREVIEW_DB__ || {
    vault: "school2",
    model: "claude-opus-5-5",
    notifs: [
      { id: "a1", ts: now - 18 * M, kind: "info", title: "Update ready: Grey theme", body: "Graphite theme is live on main; your laptop picks it up on next launch.", read: false },
      { id: "a2", ts: now - 2 * H, kind: "info", title: "Reminder: air fryer", body: "You asked to be reminded: should you get an air fryer? I left a **chicken-and-rice** plan in your notes.", read: false },
      { id: "a3", ts: now - 5 * H, kind: "info", title: "221 practice set graded", body: "84/100 on the practice final. Weakest: memory & attention chapters (6 misses).\n\n- Memory: 4 misses\n- Attention: 2 misses\n\nReview sheet in `221/review.md`.", read: true },
      { id: "a4", ts: now - 26 * H, kind: "info", title: "Done: 336 DP worksheet", body: "Worked solutions for problems 1–6 (LIS, edit distance, knapsack) are in 336/dp-worksheet.md.", read: true },
    ],
    notes: [
      note("n1", "336 NP-completeness\nSometimes they only ask parts 1–3 of the proof. Practice the reduction step most.", now - 30 * M),
      note("n2", "Air fryer?\nHow to make **chicken and rice** at home that actually tastes like the place.\n## Shopping\n- [x] jasmine rice\n- [ ] chicken thighs\n- [ ] garlic, lemon\n- [ ] the white sauce: mayo, yogurt, `vinegar`", now - 2 * H),
      note("n3", "Email about BSMS\nBefore Friday.", now - 20 * H),
      note("n4", "221 final\n100 questions. Make flashcards from the chapter summaries.", now - 3 * D, "resolved"),
      note("n5", "325 presentation\n8 min max, rehearse twice.", now - 4 * D, "resolved"),
    ],
  };
  const reply = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { "Content-Type": "application/json" } });
  window.fetch = async (url, opts) => {
    const u = String(url).split("?")[0];
    const q = new URLSearchParams(String(url).split("?")[1] || "");
    const body = opts && opts.body ? JSON.parse(opts.body as string) : {};
    // The feed: nothing new (a long poll that answers after a while, as the box's does).
    if (u === "/poll") { if (q.get("after") !== "latest") await new Promise((r) => setTimeout(r, 2500)); return reply({ events: [], next: 1, epoch: "mock" }); }
    if (u === "/api/v1/health") return reply({ version: "0.7.31-mock" });
    if (u === "/api/v1/attention") return reply({ ok: true });
    if (u === "/notifications") { const ct = DB.notifClearTs || 0; const ns = DB.notifs.filter((n) => !(n.read && (n.ts || 0) <= ct)); return reply({ unread: ns.filter((n) => !n.read).length, notifications: ns }); }
    if (u === "/notifications/read") { const n = DB.notifs.find((x) => x.id === body.id); if (n) n.read = true; return reply({ ok: true }); }
    if (u === "/notifications/hide") { DB.notifs = DB.notifs.filter((x) => x.id !== body.id); return reply({ ok: true }); }
    if (u === "/notes" && (opts?.method || "GET") === "POST") {
      const id = "nt" + Date.now().toString(36);
      DB.notes.unshift(note(id, String(body.text || ""), Date.now()));
      return reply({ ok: true, id });
    }
    if (u === "/notes") { const ns = DB.notes.filter((n) => n.status !== "cleared"); return reply({ open: ns.filter((n) => n.status === "open").length, notes: ns }); }
    if (u === "/notes/status") { const n = DB.notes.find((x) => x.id === body.id); if (n) { n.status = body.status === "open" ? "open" : "resolved"; n.last_updated = iso(Date.now()); } return reply({ ok: true }); }
    if (u === "/notes/edit") { const n = DB.notes.find((x) => x.id === body.id); if (!n) return reply({ error: "note not found" }); n.user_draft = body.text; n.title = null; n.last_updated = iso(Date.now()); return reply({ ok: true }); }
    if (u === "/notes/delete") { const before = DB.notes.length; DB.notes = DB.notes.filter((x) => x.id !== body.id); return reply(DB.notes.length < before ? { ok: true } : { error: "note not found" }); }
    if (u === "/push/vapid") return reply({ key: "" });
    if (u === "/push/subscribe" || u === "/push/test") return reply({ ok: true });
    if (u === "/file") return new Response("(mock file)", { status: 200 });
    return reply({});
  };
}
