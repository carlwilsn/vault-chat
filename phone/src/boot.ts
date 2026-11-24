// The phone app: a notification center (Alerts: the alerts Notify and the box send; tap one to read it whole, swipe
// it away to archive it) and a notes app (Notes: Carl's notes, Open / Resolved, search, a full-screen editor whose
// body is live markdown), plus Settings (push on this phone, a test push, the box). Everything else — chat, voice,
// viewers, files, pages and plugins — is the laptop's. It drives the shell React renders (App.tsx) through element ids.
import { installMock } from "./mock";
import { createPhoneMarkdown, domToHtml } from "./markdown";
import { startAttentionBeat } from "../../src/attentionBeat";
import type { LogRecord } from "../../src/convlog/protocol";

export function boot(): void {
  const qs = new URLSearchParams(location.search);
  const MOCK = qs.get("mock") === "1";

  let TOKEN = qs.get("token") || "";
  try {
    if (TOKEN) localStorage.setItem("vc_phone_token", TOKEN);
    else TOKEN = localStorage.getItem("vc_phone_token") || "";
  } catch {}
  const $ = (id: string): any => document.getElementById(id);
  const toastEl = $("toast");
  let toastT = 0;
  const toast = (m: string) => { toastEl.textContent = m; toastEl.classList.add("on"); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove("on"), 1800); };
  if (!TOKEN && !MOCK) {
    // No stored/URL token: the box provisions an httpOnly auth cookie when it serves this shell, so proceed and
    // let the cookie authorize the data calls; show the manual-link gate only if the box rejects us.
    fetch("/notifications").then((r) => {
      if (r.status === 401) {
        document.body.innerHTML = '<div class="gate"><b>No access token</b><div>Open the phone link from vault-chat Settings once — it carries the token, which is then remembered on this device.</div></div>';
      }
    }).catch(() => {});
  }
  if (MOCK) installMock();

  const api = (path: string, opts: RequestInit = {}) => fetch(path, { ...opts, headers: { "X-Vault-Token": TOKEN, ...(opts.headers || {}) } });
  const post = (path: string, body: unknown) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  /** A POST whose answer must say ok: throws the box's error otherwise. */
  const postOk = async (path: string, body: unknown) => {
    const r = await post(path, body);
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) throw new Error(d.error || String(r.status));
    return d;
  };
  // A background refresh rebuilds a whole list: while Carl is touching it, the rebuild waits until he is idle.
  let listBusyUntil = 0, softReloadT = 0;
  const markListBusy = (ms = 4000) => { listBusyUntil = Date.now() + ms; };
  function softReload(fn) {
    const wait = listBusyUntil - Date.now();
    if (wait <= 0) { void fn(); return; }
    clearTimeout(softReloadT);
    softReloadT = setTimeout(() => softReload(fn), wait + 60);
  }
  const fileUrl = (p, origin?: string) => "/file?path=" + encodeURIComponent(p) + "&token=" + encodeURIComponent(TOKEN) + (origin ? "&convId=" + encodeURIComponent(origin) : "");

  // ---------- text ----------
  // The desktop's markdown pipeline (./markdown.ts → src/mdPipeline.ts), KaTeX applied: an opened alert's full text.
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const renderMarkdown = createPhoneMarkdown({ toHtml: domToHtml(), fileUrl });
  const md = (text) => renderMarkdown(text, false, undefined);
  /** Markdown as one plain line (a card's preview): markers dropped, lines joined. */
  const plain = (s: string) => String(s || "").split("\n")
    .map((l) => l.replace(/^\s*#{1,6}\s+/, "").replace(/^\s*[-*+] \[[ xX]\]\s*/, "").replace(/^\s*[-*+]\s+/, "").replace(/^\s*>\s?/, "").replace(/[*`~]|\$\$?/g, "").trim())
    .filter(Boolean).join(" · ");
  const age = (ts) => { while (ts >= 1e14) ts = Math.floor(ts / 1000); const m = Math.floor((Date.now() - ts) / 60000); if (m < 1) return "now"; if (m < 60) return m + "m"; const h = Math.floor(m / 60); if (h < 24) return h + "h"; return Math.floor(h / 24) + "d"; };
  // Buttons that must not take the focus (and drop the keyboard) from the field being typed in: the action fires on
  // pointerup, the click that follows is swallowed.
  function wireTap(btn, fn) {
    let tappedAt = 0;
    btn.addEventListener("pointerdown", (e) => e.preventDefault());
    btn.addEventListener("pointerup", (e) => { if (e.button > 0) return; e.preventDefault(); tappedAt = Date.now(); fn(); });
    btn.addEventListener("click", () => { if (Date.now() - tappedAt < 700) return; fn(); });
  }

  // ---------- pages ----------
  let page = "alerts";
  let unreadN = 0, offlineStreak = 0, boxVersion = "";
  function setPage(name) {
    page = name === "notes" ? "notes" : "alerts";
    document.body.classList.remove("page-alerts", "page-notes");
    document.body.classList.add("page-" + page);
    document.querySelectorAll<HTMLElement>(".tab[data-page]").forEach((t) => t.classList.toggle("on", t.dataset.page === page));
    $("title").textContent = page === "notes" ? "Notes" : "Alerts";
    if (page !== "notes") setSearch(false);
    openAlert = null;
    if (page === "alerts") void loadAlerts();
    else void loadNotes();
    // What it shows, for the box (box:links phone view).
    if (!MOCK) void post("/api/v1/phone/view", { page }).catch(() => {});
  }
  document.querySelectorAll<HTMLElement>(".tab[data-page]").forEach((t) => (t.onclick = () => setPage(t.dataset.page)));
  function setBadge() { const b = $("badge"); b.textContent = String(unreadN); b.classList.toggle("zero", unreadN === 0); }
  function setOffline(off) { document.body.classList.toggle("offline", off); showBox(); }
  async function refreshBadge() { try { const d = await (await api("/notifications")).json(); if (typeof d.unread === "number") { unreadN = d.unread; setBadge(); } } catch {} }

  // ---------- alerts ----------
  // One card per alert: its title, one muted line, its age, a dot while unread. A tap opens its full text (and marks
  // it read); a swipe either way archives it (hides it from the list: the alerts noun's hide).
  let alerts: any[] = [];
  let openAlert: string | null = null;
  const alertText = (n) => String(n.body || n.summary || (n.deliberation && (n.deliberation.askLong || n.deliberation.ask)) || "");
  async function loadAlerts() {
    const box = $("alScroll");
    try {
      const d = await (await api("/notifications")).json();
      if (d.error) throw new Error(d.error);
      unreadN = d.unread || 0; setBadge();
      const list = d.notifications || [];
      // Some alerts carry a nanosecond ts: down to ms once, so the sort and the age agree.
      for (const n of list) { if (typeof n.ts === "number") { while (n.ts >= 1e14) n.ts = Math.floor(n.ts / 1000); } }
      list.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      alerts = list;
      renderAlerts();
    } catch (e) { box.innerHTML = '<div class="empty">Alerts unavailable: ' + esc(String((e as Error).message || e)) + "</div>"; }
  }
  function renderAlerts() {
    const box = $("alScroll");
    box.innerHTML = alerts.map((n) => {
      const open = openAlert === n.id;
      const text = alertText(n);
      return '<div class="sw-wrap"><div class="bg">Archive</div><div class="row al' + (open ? " open" : "") + '" role="button" data-id="' + esc(n.id) + '">'
        + '<div class="rt">' + (n.read ? "" : '<span class="dot"></span>') + "<b>" + esc(n.title || "Alert") + "</b><time>" + esc(age(n.ts || 0)) + "</time></div>"
        + (open ? '<div class="rb md">' + md(text || "*(no text)*") + "</div>" : text ? '<div class="rb">' + esc(plain(text)) + "</div>" : "")
        + "</div></div>";
    }).join("") || '<div class="empty">All clear</div>';
  }
  const markRead = (id) => post("/notifications/read", { id }).catch(() => {});
  function openAlertCard(id: string, toggle = true) {
    const n = alerts.find((x) => x.id === id);
    if (!n) return;
    if (!n.read) { n.read = true; unreadN = Math.max(0, unreadN - 1); setBadge(); void markRead(n.id); }
    openAlert = toggle && openAlert === id ? null : id;
    renderAlerts();
  }
  async function archiveAlert(id: string) {
    const n = alerts.find((x) => x.id === id);
    if (!n) return;
    alerts = alerts.filter((x) => x !== n);
    if (openAlert === id) openAlert = null;
    if (!n.read) { unreadN = Math.max(0, unreadN - 1); setBadge(); await markRead(n.id); }
    renderAlerts();
    toast("Archived");
    try { await postOk("/notifications/hide", { id }); } catch { toast("Couldn't archive — try again"); void loadAlerts(); }
  }
  $("alScroll").addEventListener("click", (e) => {
    const sc = $("alScroll");
    if (sc.dataset.swiped) return;
    if ((e.target as HTMLElement).closest("a")) return;
    const row = (e.target as HTMLElement).closest(".row.al") as HTMLElement | null;
    if (row) openAlertCard(row.dataset.id!);
  });
  // Swipe: the card follows the finger once the gesture is clearly sideways (a vertical one scrolls the list);
  // "Archive" shows beneath only while dragging; past the threshold it leaves, short of it it springs back.
  (() => {
    const sc = $("alScroll");
    let sx = 0, sy = 0, dx = 0, el: HTMLElement | null = null, drag = false;
    sc.addEventListener("pointerdown", (e) => {
      const r = (e.target as HTMLElement).closest(".row.al") as HTMLElement | null;
      if (!r || (e.button > 0)) return;
      el = r; sx = e.clientX; sy = e.clientY; dx = 0; drag = false; markListBusy();
    });
    sc.addEventListener("pointermove", (e) => {
      if (!el) return;
      const x = e.clientX - sx, y = e.clientY - sy;
      if (!drag) {
        if (Math.abs(x) > 8 && Math.abs(x) > Math.abs(y)) {
          drag = true; el.parentElement!.classList.add("drag"); el.style.transition = "none";
          try { el.setPointerCapture(e.pointerId); } catch {}
        } else if (Math.abs(y) > 8) { el = null; return; } else return;
      }
      dx = x; el.style.transform = "translateX(" + dx + "px)";
      el.parentElement!.classList.toggle("right", dx > 0);
    });
    const end = () => {
      if (!el) return;
      const r = el; el = null;
      if (!drag) return;
      r.style.transition = "";
      if (Math.abs(dx) > 110) {
        r.style.transform = "translateX(" + (dx > 0 ? 500 : -500) + "px)";
        setTimeout(() => void archiveAlert(r.dataset.id!), 180);
      } else {
        r.style.transform = "";
        setTimeout(() => r.parentElement && r.parentElement.classList.remove("drag", "right"), 200);
      }
      sc.dataset.swiped = "1";
      setTimeout(() => { delete sc.dataset.swiped; }, 50);
    };
    sc.addEventListener("pointerup", end);
    sc.addEventListener("pointercancel", end);
  })();

  // ---------- notes ----------
  // Carl's notes (box:notes: .vault-chat/notes.jsonl, through the box's GET /notes and POST /notes, /notes/edit,
  // /notes/status, /notes/delete). A note is one text: the editor's title is its first line, the body the rest.
  let notes: any[] = [];
  let filter: "open" | "resolved" = "open";
  let q = "";
  /** A note's own text, as the notes noun reads it (server/model/notes.ts noteText). */
  const noteText = (n) => {
    const draft = String(n.user_draft || "").trim();
    if (draft) return draft;
    const turns = Array.isArray(n.turns) ? n.turns.map((t) => String(t?.content || "")).join("\n").trim() : "";
    return turns || String(n.formatted || "").trim();
  };
  /** Title (the first line) and body (the rest), as the editor holds them. */
  const noteParts = (n) => {
    const lines = noteText(n).split("\n");
    while (lines.length && !lines[0].trim()) lines.shift();
    const title = (lines.shift() || "").trim();
    while (lines.length && !lines[0].trim()) lines.shift();
    return { title, body: lines.join("\n").trimEnd() };
  };
  const joinNote = (title: string, body: string) => (title && body ? title + "\n" + body : title || body);
  function noteCardParts(n) {
    const { title, body } = noteParts(n);
    let t = n.title ? String(n.title) : title.replace(/^#{1,6}\s+/, "");
    if (!t && n.anchors && n.anchors[0] && n.anchors[0].source_path) t = String(n.anchors[0].source_path).split("/").pop();
    return { t: t || "Note", b: plain(n.title ? noteText(n) : body) };
  }
  const noteTime = (n) => { const t = Date.parse(n.last_updated || n.timestamp || ""); return isFinite(t) ? age(t) : ""; };
  async function loadNotes() {
    try {
      const d = await (await api("/notes")).json();
      if (d.error) throw new Error(d.error);
      notes = (d.notes || []).filter((n) => n.status === "open" || n.status === "resolved");
      notes.sort((a, b) => (Date.parse(b.timestamp || "") || 0) - (Date.parse(a.timestamp || "") || 0));
      renderNotes();
    } catch (e) { $("nScroll").innerHTML = '<div class="empty">Notes unavailable: ' + esc(String((e as Error).message || e)) + "</div>"; }
  }
  function renderNotes() {
    const list = notes.filter((n) => n.status === filter && (!q || (noteCardParts(n).t + " " + noteText(n)).toLowerCase().includes(q)));
    $("nScroll").innerHTML = list.map((n) => {
      const c = noteCardParts(n);
      return '<button class="row note' + (n.status === "resolved" ? " done" : "") + '" data-id="' + esc(n.id) + '"><div class="rt"><b>' + esc(c.t) + "</b><time>" + esc(noteTime(n)) + "</time></div>" + (c.b ? '<div class="nb">' + esc(c.b) + "</div>" : "") + "</button>";
    }).join("") || '<div class="empty">' + (q ? "No matches" : filter === "resolved" ? "Nothing resolved yet" : "No open notes") + "</div>";
  }
  function setFilter(f) {
    filter = f === "resolved" ? "resolved" : "open";
    document.querySelectorAll<HTMLElement>("#seg button").forEach((x) => x.classList.toggle("on", x.dataset.f === filter));
    renderNotes();
  }
  $("seg").addEventListener("click", (e) => { const b = (e.target as HTMLElement).closest("button") as HTMLElement | null; if (b) setFilter(b.dataset.f); });
  $("nScroll").addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest(".row.note") as HTMLElement | null;
    const n = row && notes.find((x) => x.id === row.dataset.id);
    if (n) openEditor(n);
  });
  ["alScroll", "nScroll"].forEach((id) => $(id).addEventListener("touchstart", () => markListBusy(2500), { passive: true }));
  function setSearch(on: boolean) {
    $("search").classList.toggle("on", on);
    if (on) $("q").focus();
    else if (q || $("q").value) { $("q").value = ""; q = ""; renderNotes(); }
  }
  $("searchBtn").onclick = () => setSearch(!$("search").classList.contains("on"));
  $("q").addEventListener("input", () => { q = String($("q").value || "").trim().toLowerCase(); renderNotes(); });

  // ---------- note editor ----------
  // Full screen: the title, and the body as live markdown — every line drawn except the one being typed in, which
  // is raw text. A checkbox toggles with a tap; Enter carries a list on (and ends it on an empty item); Backspace at
  // a line's start joins it to the line above.
  let cur: any = null;
  let base = ""; // the editor's text as it opened: unchanged, a save writes nothing
  let lines: string[] = [""];
  let act = -1;
  let blurT = 0;
  const edB = $("edB");
  const inl = (s: string) => esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<i>$2</i>")
    .replace(/~~([^~]+)~~/g, "<s>$1</s>");
  function mdLine(l: string, i: number) {
    let m: RegExpMatchArray | null;
    if (!l) return '<div class="ln" data-i="' + i + '">' + (lines.length === 1 ? '<span class="ph">Details</span>' : "&nbsp;") + "</div>";
    if ((m = l.match(/^(#{1,3})\s+(.*)/))) return '<div class="ln h' + m[1].length + '" data-i="' + i + '">' + inl(m[2]) + "</div>";
    if ((m = l.match(/^- \[( |x)\]\s?(.*)/))) return '<div class="ln li" data-i="' + i + '"><span class="cb' + (m[1] === "x" ? " x" : "") + '" data-cb="' + i + '">' + (m[1] === "x" ? "✓" : "") + '</span><span class="' + (m[1] === "x" ? "done-t" : "") + '">' + inl(m[2]) + "</span></div>";
    if ((m = l.match(/^[-*]\s+(.*)/))) return '<div class="ln li" data-i="' + i + '"><span class="m">•</span><span>' + inl(m[1]) + "</span></div>";
    if ((m = l.match(/^(\d+)\.\s+(.*)/))) return '<div class="ln li" data-i="' + i + '"><span class="m">' + m[1] + ".</span><span>" + inl(m[2]) + "</span></div>";
    if ((m = l.match(/^>\s?(.*)/))) return '<div class="ln quote" data-i="' + i + '">' + inl(m[1]) + "</div>";
    return '<div class="ln" data-i="' + i + '">' + inl(l) + "</div>";
  }
  const grow = (t: HTMLTextAreaElement) => { t.style.height = "auto"; t.style.height = t.scrollHeight + "px"; };
  function rBody(caret?: number) {
    edB.innerHTML = lines.map((l, i) => (i === act ? '<textarea class="ln-in" rows="1" data-i="' + i + '" enterkeyhint="enter" autocapitalize="sentences"></textarea>' : mdLine(l, i))).join("");
    const t = edB.querySelector(".ln-in") as HTMLTextAreaElement | null;
    if (t) {
      t.value = lines[act]; grow(t); t.focus();
      const c = caret == null ? t.value.length : caret;
      t.setSelectionRange(c, c);
      setTimeout(() => { try { t.scrollIntoView({ block: "nearest" }); } catch {} }, 60);
    }
    edUpd();
  }
  const go = (i: number, c?: number) => { act = i; rBody(c); };
  const listPrefix = (l: string) => { const m = l.match(/^(- \[[ x]\] |[-*] |(\d+)\. )/); if (!m) return ""; if (m[2]) return +m[2] + 1 + ". "; return m[1].replace("[x]", "[ ]"); };
  // A mouse press would move the focus off the line being typed in before the click lands: keep it (a finger's tap
  // lands its click within the blur's grace below).
  edB.addEventListener("pointerdown", (e) => { if (e.pointerType === "mouse" && !(e.target as HTMLElement).classList.contains("ln-in")) e.preventDefault(); });
  edB.addEventListener("click", (e) => {
    const tg = e.target as HTMLElement;
    if (tg.classList.contains("ln-in")) return;
    clearTimeout(blurT);
    const cb = tg.closest("[data-cb]") as HTMLElement | null;
    if (cb) {
      const i = +cb.dataset.cb!;
      lines[i] = lines[i].replace(/^- \[( |x)\]/, (_, x) => "- [" + (x === "x" ? " " : "x") + "]");
      act = -1; rBody(); return;
    }
    const ln = tg.closest(".ln") as HTMLElement | null;
    if (ln) go(+ln.dataset.i!);
    else { if (lines[lines.length - 1] !== "") lines.push(""); go(lines.length - 1); }
  });
  edB.addEventListener("input", (e) => { const t = e.target as HTMLTextAreaElement; if (!t.classList.contains("ln-in")) return; lines[act] = t.value.replace(/\n/g, ""); grow(t); edUpd(); });
  edB.addEventListener("keydown", (e) => {
    const t = e.target as HTMLTextAreaElement;
    if (!t.classList.contains("ln-in")) return;
    const s = t.selectionStart, v = t.value;
    if (e.key === "Enter") {
      e.preventDefault();
      const pre = listPrefix(v);
      if (pre && v.trim() === pre.trim()) { lines[act] = ""; go(act, 0); return; }
      lines[act] = v.slice(0, s); lines.splice(act + 1, 0, pre + v.slice(s)); go(act + 1, pre.length); return;
    }
    if (e.key === "Backspace" && s === 0 && t.selectionEnd === 0 && act > 0) { e.preventDefault(); const p = lines[act - 1].length; lines[act - 1] += v; lines.splice(act, 1); go(act - 1, p); return; }
    if (e.key === "ArrowUp" && act > 0 && s === 0) { e.preventDefault(); go(act - 1); }
    if (e.key === "ArrowDown" && act < lines.length - 1 && s === v.length) { e.preventDefault(); go(act + 1, 0); }
  });
  edB.addEventListener("focusout", () => {
    clearTimeout(blurT);
    blurT = setTimeout(() => { if (!edB.contains(document.activeElement) && act >= 0) { act = -1; rBody(); } }, 250);
  });
  const edValue = () => {
    let t = String($("edT").value || "").trim(), b = lines.join("\n").trim();
    if (!t && b) { t = b.split("\n")[0].trim(); b = b.slice(b.indexOf("\n") + 1 || b.length).trim(); }
    return joinNote(t, b);
  };
  function edUpd() { $("edSave").disabled = !String($("edT").value || "").trim() && !lines.join("").trim(); }
  function openEditor(n: any) {
    cur = n || null;
    const p = n ? noteParts(n) : { title: "", body: "" };
    $("edHd").textContent = n ? "" : "New note";
    $("edT").value = p.title;
    lines = p.body.split("\n"); act = -1; rBody();
    base = edValue();
    $("edFt").style.display = n ? "" : "none";
    if (n) $("edRes").textContent = n.status === "resolved" ? "Reopen" : "Resolve";
    document.body.classList.add("editing");
    $("ed").classList.add("on");
    if (!n) setTimeout(() => $("edT").focus(), 260);
  }
  function closeEditor() {
    act = -1; clearTimeout(blurT);
    document.body.classList.remove("editing");
    $("ed").classList.remove("on");
    (document.activeElement as HTMLElement | null)?.blur?.();
  }
  $("edT").addEventListener("input", edUpd);
  $("edT").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(lines.length && lines[0] === "" ? 0 : (lines.push(""), lines.length - 1)); } });
  $("newBtn").onclick = () => openEditor(null);
  wireTap($("edCancel"), closeEditor);
  /** Write the editor's text if it changed (a new note: add; a saved one: edit in place). True when it is saved. */
  async function saveEditor(): Promise<boolean> {
    const text = edValue();
    if (!text) return false;
    if (cur) { if (text !== base) await postOk("/notes/edit", { id: cur.id, text }); }
    else await postOk("/notes", { text });
    return true;
  }
  let saving = false;
  wireTap($("edSave"), async () => {
    if (saving || $("edSave").disabled) return;
    saving = true;
    const wasNew = !cur;
    try {
      if (!(await saveEditor())) return;
      closeEditor();
      toast("Saved");
      if (wasNew) { setFilter("open"); $("nScroll").scrollTop = 0; }
      void loadNotes();
    } catch (e) { toast("Couldn't save: " + ((e as Error).message || e)); }
    finally { saving = false; }
  });
  $("edRes").onclick = async () => {
    if (!cur) return;
    const reopen = cur.status === "resolved";
    try {
      await saveEditor();
      await postOk("/notes/status", { id: cur.id, status: reopen ? "open" : "resolved" });
      closeEditor(); toast(reopen ? "Reopened" : "Resolved"); void loadNotes();
    } catch (e) { toast("Couldn't update note: " + ((e as Error).message || e)); }
  };
  $("edDel").onclick = async () => {
    if (!cur) return;
    try { await postOk("/notes/delete", { id: cur.id }); closeEditor(); toast("Deleted"); void loadNotes(); }
    catch (e) { toast("Couldn't delete: " + ((e as Error).message || e)); }
  };

  // ---------- settings ----------
  // A bottom sheet behind the gear: push on this phone, a test push, the box's version and connection.
  function showBox() {
    const off = document.body.classList.contains("offline");
    $("boxVer").textContent = (boxVersion ? "vault-chat " + boxVersion + " · " : "") + (off ? "connecting…" : "connected");
  }
  function openSettings() {
    document.body.classList.add("sh-on");
    refreshPushUi();
    void api("/api/v1/health").then((r) => r.json()).then((d) => { if (d && d.version) boxVersion = String(d.version); showBox(); }).catch(() => showBox());
  }
  const closeSettings = () => document.body.classList.remove("sh-on");
  $("gearBtn").onclick = openSettings;
  $("scrim").onclick = closeSettings;
  $("grab").onclick = closeSettings;

  // ---------- push ----------
  // This phone's own subscription: an existing permission grant never subscribes it; only a tap on the switch (or
  // box:alerts pushOnPhone, after a first grant) does.
  const b64uToBytes = (s) => { const pad = "=".repeat((4 - (s.length % 4)) % 4); const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(raw, (c) => c.charCodeAt(0)); };
  const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window;
  async function currentSub() { if (!pushSupported()) return null; const reg = await navigator.serviceWorker.getRegistration().catch(() => null); return reg ? await reg.pushManager.getSubscription().catch(() => null) : null; }
  let pushOn = false;
  async function refreshPushUi() {
    const sw = $("pushSw");
    if (!pushSupported()) {
      pushOn = false;
      $("pushState").textContent = navigator.standalone === false ? "Add to your Home Screen first — Safari tabs can't receive push" : "Push isn't supported here";
      sw.classList.remove("on"); sw.setAttribute("aria-checked", "false");
      return;
    }
    const sub = await currentSub();
    pushOn = !!sub;
    sw.classList.toggle("on", pushOn); sw.setAttribute("aria-checked", String(pushOn));
    $("pushState").textContent = sub ? "On — you get pushes when you ask for them" : Notification.permission === "denied" ? "Blocked in iOS Settings for this app" : "Off";
  }
  async function pushSubscribe() {
    const perm = await Notification.requestPermission(); if (perm !== "granted") { toast("Notifications not allowed"); return false; }
    const reg = await navigator.serviceWorker.register("/phone-sw.js"); await navigator.serviceWorker.ready;
    const vd = await (await api("/push/vapid")).json(); if (!vd.key) throw new Error(vd.error || "no VAPID key from box");
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(vd.key) });
    const r = await api("/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(subBody(sub)) });
    if (!r.ok) throw new Error("subscribe store failed");
    return true;
  }
  // A subscription carries the VAPID key it was made under: the box drops one made under another
  // key (the push service refuses it with a 400 on every push, server/commands/phone.ts).
  const bytesToB64u = (buf) => { const b = new Uint8Array(buf); let s = ""; for (const c of b) s += String.fromCharCode(c); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
  const subKey = (sub) => { try { const k = sub.options && sub.options.applicationServerKey; return k ? bytesToB64u(k) : ""; } catch { return ""; } };
  const subBody = (sub) => { const k = subKey(sub); return k ? { ...sub.toJSON(), key: k } : sub.toJSON(); };
  async function pushOff(sub) {
    try { localStorage.setItem("vc_push_optout", "1"); } catch {}
    await api("/push/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
    toast("Notifications off");
  }
  // The switch's own flip (box:alerts pushOnPhone runs the same, when Carl asks the agent): on needs this device's
  // notification permission already granted (a first grant is only Carl's tap).
  async function setPush(on) {
    try {
      const sub = await currentSub();
      if (!on && sub) await pushOff(sub);
      else if (on && !sub) {
        if (!pushSupported() || Notification.permission !== "granted") { toast("Turning notifications on needs your tap on the switch here"); return; }
        try { localStorage.removeItem("vc_push_optout"); } catch {}
        if (await pushSubscribe()) toast("Notifications on");
      }
    } catch (e) { toast("Push setup failed: " + (e.message || e)); }
    refreshPushUi();
  }
  $("pushSw").onclick = async () => {
    try {
      const sub = await currentSub();
      if (sub) await pushOff(sub);
      else {
        try { localStorage.removeItem("vc_push_optout"); } catch {}
        if (await pushSubscribe()) toast("Notifications on");
      }
    } catch (e) { toast("Push setup failed: " + (e.message || e)); }
    refreshPushUi();
  };
  $("pushTestBtn").onclick = async () => {
    if (!pushOn) { toast("Turn push on first"); return; }
    const r = await api("/push/test", { method: "POST" }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    toast(d.error ? "Test failed: " + d.error : "Test push sent");
  };

  // ---------- in-app keyboard ----------
  // (None: the phone uses the system keyboard. The marker ends the push section above.)

  // ---------- live: the box's feed ----------
  // /poll?after=<cursor> long-polls the vault's records; the phone only reacts to the signals that move its two
  // lists (a new or changed alert, the notes file) and to the phone app being switched off.
  let pollGen = 0;
  let cursor: number | null = null, epoch: string | null = null;
  async function pollLoop() {
    const gen = ++pollGen;
    while (gen === pollGen) {
      try {
        if (cursor === null) {
          const d = await (await api("/poll?after=latest")).json();
          cursor = Number(d.next) || 0; epoch = d.epoch || null;
        }
        const r = await api("/poll?after=" + cursor + (epoch ? "&epoch=" + encodeURIComponent(epoch) : "") + "&client=phone");
        if (!r.ok) throw new Error("poll " + r.status);
        const d = await r.json(); offlineStreak = 0;
        if (document.body.classList.contains("offline")) setOffline(false);
        if (d.reset) { cursor = null; epoch = null; continue; }
        applyRecords(d.events || []);
        cursor = Math.max(cursor ?? 0, Number(d.next) || 0);
      } catch { offlineStreak++; if (offlineStreak >= 2) setOffline(true); await new Promise((res) => setTimeout(res, 3000)); }
    }
  }
  function applyRecords(recs: LogRecord[]) {
    for (const rec of recs) {
      if (rec.conv !== null) continue;
      const s: any = rec.type === "signal" ? rec.signal : {};
      if (s.type === "notif") { void refreshBadge(); if (page === "alerts") softReload(loadAlerts); }
      else if (s.type === "file_changed" && typeof s.path === "string" && /(^|\/)\.vault-chat\/notes\.jsonl$/.test(s.path)) { if (page === "notes") softReload(loadNotes); }
      // box:links showOnPhone: the agent switched the page, as the tabs do.
      else if (s.type === "phone.page" && (s.page === "alerts" || s.page === "notes")) setPage(s.page);
      else if (s.type === "phone.push" && typeof s.on === "boolean") void setPush(s.on);
      // The phone app itself switched off (server/surfaces.ts): the box's /phone now says so; go there.
      else if (s.type === "plugin.desired" && s.plugin === "app/phone" && s.state === "stopped" && !MOCK) {
        fetch("/phone", { cache: "no-store" }).then((r) => r.text()).then((t) => { if (t.includes('data-el="surface-off"')) location.reload(); }).catch(() => {});
      }
    }
  }

  // ---------- lifecycle ----------
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    void pollLoop(); void refreshBadge();
    if (page === "alerts") softReload(loadAlerts); else softReload(loadNotes);
  });
  // Whether Carl is looking at the phone (the app on screen): the box keeps the phone quiet meanwhile (server/pushGate.ts).
  startAttentionBeat({ device: "phone", convId: () => null, post: (b) => (MOCK ? undefined : api("/api/v1/attention", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b), keepalive: true })) });
  if (window.visualViewport) {
    const vv = window.visualViewport;
    // --kb: the keyboard's height; the editor and the page stop above it (body.kbup). 0 with no keyboard.
    const applyKb = () => {
      const kbRaw = Math.max(0, document.documentElement.clientHeight - vv.height - vv.offsetTop);
      const up = kbRaw > 60;
      document.body.classList.toggle("kbup", up);
      const safeBand = Math.max(0, document.body.offsetHeight - document.documentElement.clientHeight);
      document.documentElement.style.setProperty("--kb", (up ? kbRaw + safeBand : 0) + "px");
    };
    vv.addEventListener("resize", () => { applyKb(); window.scrollTo(0, 0); });
    vv.addEventListener("scroll", () => { window.scrollTo(0, 0); applyKb(); });
    applyKb();
  }
  // A push tapped (the service worker hands its link over, or a cold launch with ?ask= / ?notif= / ?conv=): Alerts,
  // with the alert it is about opened.
  const openFromLink = (link: string) => {
    try {
      const p = new URLSearchParams(String(link).split("?")[1] || "");
      const id = p.get("ask") || p.get("notif");
      const conv = p.get("conv");
      closeEditor(); closeSettings();
      setPage("alerts");
      if (!id && !conv) return;
      void (async () => {
        await loadAlerts();
        const n = (id && alerts.find((x) => x.id === id)) || (conv && alerts.find((x) => x.convId === conv && !x.read)) || null;
        if (!n) return;
        openAlertCard(n.id, false);
        $("alScroll").querySelector('.row.al.open')?.scrollIntoView({ block: "nearest" });
      })();
    } catch {}
  };
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (e) => {
      const d = (e && e.data) || {};
      if (d.type === "deeplink" && d.url) openFromLink(String(d.url));
    });
  }

  // A cold launch from a push opens that alert; the link is for this open only.
  if (qs.get("conv") || qs.get("ask") || qs.get("notif")) {
    openFromLink(location.search);
    try { const u = new URL(location.href); ["conv", "ask", "notif"].forEach((k) => u.searchParams.delete(k)); history.replaceState(history.state, "", u.pathname + u.search + u.hash); } catch {}
  } else setPage(qs.get("page") === "notes" ? "notes" : "alerts");
  void refreshBadge();
  void pollLoop();
  setInterval(() => {
    if (document.visibilityState !== "visible") return;
    void refreshBadge();
    // The ages ("5m") move on: redraw what is not being touched.
    if (Date.now() > listBusyUntil) { if (page === "alerts") renderAlerts(); else renderNotes(); }
  }, 45000);
}
