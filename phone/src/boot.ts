// The phone app: a notification center (Alerts: the alerts Notify and the agent send, read / archive / clear,
// answer an ask, open its chat read-only) and a notes app (Notes: Carl's notes list, add, edit, resolve, delete,
// search), plus Box & settings (push for this device). Everything else — chat, voice, viewers, files, pages and
// plugins — is the laptop's. It drives the shell React renders (App.tsx) through element ids.
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
  const toast = (m: string) => { toastEl.textContent = m; toastEl.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove("show"), 2600); };
  if (!TOKEN && !MOCK) {
    // No stored/URL token: the box provisions an httpOnly auth cookie when it serves this shell, so proceed and
    // let the cookie authorize the data calls; show the manual-link gate only if the box rejects us.
    fetch("/notifications").then((r) => {
      if (r.status === 401) {
        document.body.innerHTML = '<div class="gate"><b style="color:var(--text)">No access token</b><div>Open the phone link from vault-chat Settings once — it carries the token, which is then remembered on this device.</div></div>';
      }
    }).catch(() => {});
  }
  if (MOCK) installMock();

  const api = (path: string, opts: RequestInit = {}) => fetch(path, { ...opts, headers: { "X-Vault-Token": TOKEN, ...(opts.headers || {}) } });
  // A background refresh rebuilds a whole list (scrollTop and a two-tap "armed" clear reset with it): while Carl
  // is touching a list, or has a control armed, the rebuild waits until he is idle.
  let listBusyUntil = 0, softReloadT = 0;
  const markListBusy = (ms = 4000) => { listBusyUntil = Date.now() + ms; };
  function softReload(fn) {
    const wait = listBusyUntil - Date.now();
    if (wait <= 0) { void fn(); return; }
    clearTimeout(softReloadT);
    softReloadT = setTimeout(() => softReload(fn), wait + 60);
  }
  const fileUrl = (p, origin?: string) => "/file?path=" + encodeURIComponent(p) + "&token=" + encodeURIComponent(TOKEN) + (origin ? "&convId=" + encodeURIComponent(origin) : "");

  // ---------- markdown ----------
  // The desktop's pipeline (./markdown.ts → src/mdPipeline.ts), KaTeX applied: an alert's text and a chat read-only.
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const renderMarkdown = createPhoneMarkdown({ toHtml: domToHtml(), fileUrl });
  const md = (text) => renderMarkdown(text, false, undefined);

  // ---------- state ----------
  let page = "alerts";
  let unreadN = 0, offlineStreak = 0;
  // One-tap buttons with the keyboard up: pointerdown keeps focus (and the keyboard); the action fires on pointerup.
  function wireTap(btn, fn) {
    if (!btn) return;
    let tappedAt = 0;
    btn.addEventListener("pointerdown", (e) => e.preventDefault());
    btn.addEventListener("pointerup", (e) => { e.preventDefault(); tappedAt = Date.now(); fn(); });
    btn.addEventListener("click", () => { if (Date.now() - tappedAt < 700) return; fn(); });
  }
  const age = (ts) => { while (ts >= 1e14) ts = Math.floor(ts / 1000); const m = Math.floor((Date.now() - ts) / 60000); if (m < 1) return "now"; if (m < 60) return m + "m"; const h = Math.floor(m / 60); if (h < 24) return h + "h"; return Math.floor(h / 24) + "d"; };

  // ---------- pages ----------
  function setPage(name) {
    page = name === "notes" ? "notes" : "alerts";
    document.body.classList.remove("page-alerts", "page-notes");
    document.body.classList.add("page-" + page);
    document.querySelectorAll<HTMLElement>(".mrow[data-page]").forEach((r) => r.classList.toggle("cur", r.dataset.page === page));
    if (page === "alerts") void loadAlerts();
    else void loadNotes();
    setHeader();
  }
  document.querySelectorAll<HTMLElement>(".mrow[data-page]").forEach((r) => (r.onclick = () => { closeMenu(); closeDrawer(); setPage(r.dataset.page); }));
  function setHeader() {
    $("titleTx").textContent = page === "notes" ? "Notes" : "Alerts";
    $("titleSub").textContent = "";
    const mAl = $("mAl"); mAl.textContent = unreadN; mAl.classList.toggle("zero", unreadN === 0);
    $("menudot").classList.toggle("on", unreadN > 0 && page !== "alerts");
  }
  function setOffline(off) { document.body.classList.toggle("offline", off); setHeader(); }

  // ---------- menu ----------
  const menu = $("menu");
  function closeMenu() { menu.classList.remove("on"); }
  $("menuBtn").onclick = (e) => { e.stopPropagation(); menu.classList.toggle("on"); };
  document.addEventListener("click", closeMenu);
  menu.addEventListener("click", (e) => e.stopPropagation());
  $("settingsRow").onclick = () => { closeMenu(); openDrawer(); };

  async function refreshState() { try { const d = await (await api("/api/v1/health")).json(); return d && typeof d === "object" ? d : null; } catch { return null; } }
  async function refreshBadge() { try { const d = await (await api("/notifications")).json(); if (typeof d.unread === "number") { unreadN = d.unread; setHeader(); } } catch {} }

  function el(html: string): any { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstChild; }

  // ---------- bottom sheet (the detail surface) ----------
  // Measure the top safe-area inset (Dynamic Island / notch) in px — 0 in a browser
  // tab, ~47-59 in an iOS standalone PWA. A full-height sheet must stop BELOW it, or
  // its top slides up under the Island and reads as "too far up" (note 86073ceb).
  // Probed live (offsetHeight resolves env()), so rotation is handled.
  function safeAreaTop() {
    try {
      const p = document.createElement("div");
      p.style.cssText = "position:fixed;top:0;left:0;width:0;height:env(safe-area-inset-top,0px);visibility:hidden;pointer-events:none";
      document.body.appendChild(p);
      const h = p.offsetHeight || 0;
      p.remove();
      return h;
    } catch { return 0; }
  }
  // The height a sheet opens/snaps to at rest. A smidge below the very top so the
  // header still clears the Dynamic Island, but HIGHER than the old
  // full-safe-area gap — the user wanted it "a smidge higher, halfway between all
  // the way up and where it used to default." So we give back half the safe-area
  // band. 0 inset in a browser tab, so this is the near-full height there.
  function sheetRestHeight() { return Math.round(0.96 * window.innerHeight) - Math.round(safeAreaTop() / 2); }
  // Cohesive monochrome line-icon set — replaces the old punctuation glyphs (?, ≡,
  // ✓, $, !, ◎, ✦, ◷) in the .ico / .sheet-ico tiles. Drawn with currentColor so
  // the tile's status class (.a warn · .r err · .g white) tints the icon ONLY, in
  // keeping with the near-monochrome app. Keyed by the same glyph values the
  // producers + alertMeta still emit, so callers are unchanged; an unknown key
  // (e.g. a stray emoji from a producer) falls back to the neutral info icon.
  const ICON_PATHS = {
    "?": '<circle cx="6" cy="6" r="2.7"/><circle cx="18" cy="6" r="2.7"/><circle cx="12" cy="18" r="2.7"/><path d="M6 8.7v.6a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-.6M12 12.6v2.7"/>',
    "!": '<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4"/><circle cx="12" cy="17.3" r=".6" fill="currentColor" stroke="none"/>',
    "✓": '<circle cx="12" cy="12" r="9"/><path d="M8 12.4l2.6 2.6L16 9.6"/>',
    "$": '<circle cx="12" cy="12" r="9"/><path d="M12 7v10M14.5 9.3c-.6-.7-1.6-1.1-2.6-1.1-1.4 0-2.4.8-2.4 1.9 0 2.6 5 1.4 5 4 0 1.2-1 2-2.6 2-1.1 0-2.1-.4-2.7-1.1"/>',
    "≡": '<path d="M4 6h16M4 12h16M4 18h10"/>',
    "•": '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="7.7" r=".6" fill="currentColor" stroke="none"/>',
    "◎": '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.4"/>',
    "✦": '<path d="M4 20l4-1L19 8a2 2 0 0 0-3-3L5 16l-1 4z"/><path d="M14.5 6.5l3 3"/>',
    "◷": '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/>',
    "✕": '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
    // Plain chat bubble — the "dig in / talk it through" affordance on an ask card.
    "chat": '<path d="M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-4 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/>',
  };
  function iconSvg(key) {
    const p = ICON_PATHS[key] || ICON_PATHS["•"];
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + p + "</svg>";
  }
  function openSheet(opts) {
    const sh = $("sheet");
    sh.style.transition = "";
    // Cards open FULL-SCREEN by default (note 7a420a05) — not the old ~64% peek.
    // A sheet→sheet transition (the back ‹, or opening a worker from its mission)
    // instead PRESERVES the current height, so back never "forces me back up"
    // after I've dragged the sheet down.
    sh.style.maxHeight = "none";
    // Open at the resting height (a smidge below the very top — see sheetRestHeight).
    // A sheet→sheet transition (back ‹, or opening a worker from its mission)
    // PRESERVES the current height so back never forces you back up.
    sh.style.height = (sh.classList.contains("on") ? sh.offsetHeight : sheetRestHeight()) + "px";
    $("sheetIco").innerHTML = iconSvg(opts.ico || "•");
    $("sheetIco").className = "sheet-ico" + (opts.cls ? " " + opts.cls : "");
    // A worker thread doesn't need an icon chip — the "Worker · …" intent label
    // already says what it is, and the ● sitting next to the back ‹ just looked
    // cluttered (note 7a420a05). Hide it for those views.
    $("sheetIco").style.display = opts.noIco ? "none" : "";
    $("sheetIntent").textContent = opts.intent || "";
    $("sheetTitle").textContent = opts.title || "";
    $("sheetBody").innerHTML = opts.bodyHtml || "";
    const foot = $("sheetFoot");
    if (opts.footHtml) { foot.style.display = ""; foot.innerHTML = opts.footHtml; } else { foot.style.display = "none"; foot.innerHTML = ""; }
    const act = $("sheetAction");
    if (opts.action) { act.style.display = ""; act.textContent = opts.action.label; act.className = "sheet-action" + (opts.action.danger ? " danger" : ""); act.onclick = opts.action.onClick; }
    else { act.style.display = "none"; act.className = "sheet-action"; act.onclick = null; }
    // Back affordance: when this sheet was reached FROM another (a worker thread
    // opened from its mission), show a ‹ that returns there instead of forcing a
    // full close + re-tap to get back to the supervisor/mission level.
    const back = $("sheetBack");
    if (opts.back) { back.style.display = ""; back.onclick = opts.back; } else { back.style.display = "none"; back.onclick = null; }
    if (opts.wire) opts.wire($("sheetBody"), foot);
    $("sheetScrim").classList.add("on"); $("sheet").classList.add("on");
  }
  function closeSheet() { $("sheetScrim").classList.remove("on"); const sh = $("sheet"); sh.classList.remove("on", "editing"); sh.style.maxHeight = ""; }
  // ONE keyboard contract for EVERY text input inside a sheet — the reply
  // composer, the note editor, any future field (note ba0735c9: "find all of
  // the text box enter use cases and get them straightened out"). On focus the
  // sheet fills exactly the space ABOVE the keyboard:
  //  - never shrink-to-content (the old code cleared the inline height, so a
  //    sheet with a short conversation COLLAPSED the moment you tapped the
  //    composer — "brings the sheet down from being expanded");
  //  - never full-height + lift (an input NOT on this contract kept the sheet
  //    at full height while translateY(-kb) lifted it, pushing the top clean
  //    out of the screen — the note editor "swiping way up out of frame").
  // On blur the resting geometry comes back.
  function sheetEditFocus(el) {
    const sheet = $("sheet");
    // Remember the resting height once (not when hopping between two inputs),
    // so blur can put the sheet back — never the CSS 64% "middle" fallback
    // (notes 7edf4afd / 55ab9006).
    if (!sheet.classList.contains("editing")) sheet.dataset.restH = sheet.style.height || "";
    // Keep the sheet at its RESTING spot on focus — do NOT balloon or lift it. The
    // `.editing` class (CSS) reserves the keyboard height as INSIDE padding, so the
    // top stays fixed and only the pinned composer rises above the keyboard. Was:
    // height:100% + a live maxHeight cap, which grew the sheet to full-screen and
    // let the whole-sheet lift shove its top up into the notch — the on-device
    // report ("the top should not expand because I opened my keyboard; keep it in
    // the same spot") and note 93b609bc. Resting height is an explicit px from
    // openSheet, so not touching it can't collapse a short sheet.
    sheet.classList.add("editing");
    const be = $("sheetBody");
    const wasBottom = be && be.scrollHeight - be.scrollTop - be.clientHeight < 80;
    setTimeout(() => { try { el.scrollIntoView({ block: "nearest" }); } catch {} if (be && wasBottom) be.scrollTop = be.scrollHeight; }, 60);
  }
  function sheetEditBlur() {
    const sh = $("sheet");
    sh.classList.remove("editing");
    // Restore the resting geometry (explicit height + maxHeight:none, like
    // openSheet) so dismissing the keyboard doesn't collapse the sheet, and
    // keep the thread pinned to its latest line across the resize.
    const be = $("sheetBody");
    const wasBottom = be && be.scrollHeight - be.scrollTop - be.clientHeight < 80;
    sh.style.maxHeight = "none";
    sh.style.height = sh.dataset.restH || (sheetRestHeight() + "px");
    if (be && wasBottom) {
      requestAnimationFrame(() => { be.scrollTop = be.scrollHeight; });
      setTimeout(() => { if (be.scrollHeight - be.scrollTop - be.clientHeight < 220) be.scrollTop = be.scrollHeight; }, 300);
    }
  }
  // Wire a sheet's reply textarea: auto-grows vertically as you type (like the
  // chat composer), Enter inserts a newline, the ↑ button sends. The pinned
  // footer + the visualViewport lift keep it above the keyboard.
  function wireReply(foot, onSend) {
    if (!foot) return;
    const ta = foot.querySelector(".rinp"); if (!ta) return;
    ta.setAttribute("enterkeyhint", "enter");
    const autosize = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 120) + "px"; };
    ta.addEventListener("input", autosize);
    ta.addEventListener("focus", () => sheetEditFocus(ta));
    ta.addEventListener("blur", sheetEditBlur);
    // onSend returning false = blocked (lane busy) — keep the typed text so
    // nothing is lost; anything else counts as accepted and clears the box.
    const go = () => { const v = ta.value.trim(); if (!v) return; if (onSend(v) === false) return; ta.value = ""; autosize(); };
    wireTap(foot.querySelector(".rsend"), go);
    // Enter inserts a newline; sending is via the send button.
    setTimeout(autosize, 0);
  }
  $("sheetScrim").onclick = closeSheet; $("sheetX").onclick = closeSheet;
  // Tool-call "N steps" chips expand inside the sheet too. The chat has its own
  // handler on msgsEl; the sheet's thread (worker / mission / alert detail) is a
  // separate container, so it needs its own delegated toggle — without this,
  // tapping the steps chip in a thread did nothing.
  $("sheetBody").addEventListener("click", (e) => {
    const sh = e.target.closest(".steps-h");
    if (sh) sh.closest(".steps").classList.toggle("open");
  });
  // Drag the grab/header: pull up to fill the screen for a long thread, pull
  // down past the threshold to dismiss. Snaps to peek / full / closed.
  (function sheetDrag() {
    const sheet = $("sheet"); let startY = 0, startH = 0, dragging = false, H = 0, bodyBottom = false;
    // Growing the sheet must NOT reveal the top of the thread: if the body was at
    // the bottom (latest line in view), keep it there as the frame resizes — the
    // "drag back up and it scrolls the conversation to the top" bug (note this
    // session). Captured at drag-start, re-applied through the move + snap.
    const be = () => $("sheetBody");
    const atBot = () => { const b = be(); return !!b && b.scrollHeight - b.scrollTop - b.clientHeight < 80; };
    const pin = () => { const b = be(); if (b && bodyBottom) b.scrollTop = b.scrollHeight; };
    const down = (y) => { dragging = true; startY = y; startH = sheet.offsetHeight; H = window.innerHeight; bodyBottom = atBot(); sheet.style.transition = "none"; sheet.style.maxHeight = "none"; };
    const move = (y) => { if (!dragging) return; const h = Math.max(80, Math.min(startH - (y - startY), Math.round(0.97 * H))); sheet.style.height = h + "px"; pin(); };
    const up = () => { if (!dragging) return; dragging = false; sheet.style.transition = ""; const h = sheet.offsetHeight; if (h < 0.30 * H) { closeSheet(); return; } if (h > 0.55 * H) sheet.style.height = sheetRestHeight() + "px"; else sheet.style.height = Math.min(sheet.scrollHeight, Math.round(0.62 * H)) + "px"; setTimeout(pin, 300); };
    for (const elx of [$("sheetGrab"), $("sheetHead")]) {
      elx.addEventListener("touchstart", (e) => { if (e.target.closest(".sheet-x,.sheet-action")) return; down(e.touches[0].clientY); }, { passive: true });
      elx.addEventListener("mousedown", (e) => { if (e.target.closest(".sheet-x,.sheet-action")) return; e.preventDefault(); down(e.clientY); });
    }
    window.addEventListener("touchmove", (e) => { if (dragging) move(e.touches[0].clientY); }, { passive: true });
    window.addEventListener("touchend", up); window.addEventListener("touchcancel", up);
    window.addEventListener("mousemove", (e) => { if (dragging) move(e.clientY); });
    window.addEventListener("mouseup", up);
  })();

  // structured-first alert metadata; falls back to derivation (no longer a
  // pure keyword sniff once the producer ships intention/summary/icon).
  function alertMeta(n) {
    if (n.intention || n.icon) return { intention: n.intention || "Update", icon: n.icon || "•", cls: n.cls || "" };
    if (n.kind === "ask") return { intention: "Needs your call", icon: "?", cls: "a" };
    if (/^blocked\b|fail|error|diverg|crash|wedge|❌|⚠/i.test(n.title)) return { intention: "Something failed", icon: "!", cls: "r" };
    if (/complete|done|finished/i.test(n.title)) return { intention: "Finished", icon: "✓", cls: "g" };
    if (/stopped|idle|cost|\$/i.test(n.title)) return { intention: "Cost / cleanup", icon: "$", cls: "r" };
    if (/brief|coach|morning|daily|check-?in/i.test(n.title)) return { intention: "Briefing", icon: "≡", cls: "" };
    return { intention: "Update", icon: "•", cls: "" };
  }

  // ---------- alerts ----------
  // Two classes, by design. ACTION (kind "ask") — something needs a decision;
  // reply inline. INFO (everything else) — a heads-up. Archiving is the ONE
  // explicit acknowledge gesture: swipe a card right-to-left and it's read.
  // Archived items live behind the Archive toggle at the bottom.
  let alertArchiveOpen = false;
  // ---------- notes ----------
  // Carl's notes (.vault-chat/notes.jsonl, through the box: GET /notes and the note tools behind
  // POST /notes, /notes/edit, /notes/status, /notes/delete, /notes/clear-resolved): list, add,
  // edit (swipe right), resolve / reopen (swipe left), delete (in the edit sheet), search.
  let notesResolvedOpen = false;
  const noteFirstLine = (s) => String(s || "").split("\n").map((x) => x.trim()).find(Boolean) || "";
  // A short, scannable header. The AI headline (Note.title) is already short, but
  // the FALLBACKS — raw draft/turn text shown until the box has titled the note —
  // are often one long paragraph with no early newline, so noteFirstLine returned
  // the WHOLE paragraph and it rendered as a giant header (the "summary header is
  // way too long" complaint, note 8da0e8bc; the lag before the AI title lands is
  // note 7e432831). Clip the fallback to its first sentence / ~64 chars so even
  // the pre-title state reads as a header, not a wall of text.
  function clipHeadline(s) {
    const t = noteFirstLine(s);
    if (t.length <= 64) return t;
    const cut = t.slice(0, 64);
    const sentEnd = cut.search(/[.!?](\s|$)/);
    if (sentEnd >= 24) return cut.slice(0, sentEnd + 1);
    const sp = cut.lastIndexOf(" ");
    return (sp >= 24 ? cut.slice(0, sp) : cut) + "…";
  }
  function noteTitle(n) {
    // Prefer the AI headline (Note.title) — a short topic line distinct from the
    // body, so the list is scannable instead of every row repeating its first
    // line. Falls back to a CLIPPED first line of the content until titled.
    if (n.title) return noteFirstLine(n.title);
    if (n.formatted) return clipHeadline(n.formatted);
    if (n.user_draft) return clipHeadline(n.user_draft);
    if (n.turns && n.turns.length) return clipHeadline(n.turns[0].content);
    if (n.anchors && n.anchors.length && n.anchors[0].source_path) return String(n.anchors[0].source_path).split("/").pop();
    return "Note";
  }
  function noteWhen(n) { const t = Date.parse(n.last_updated || n.timestamp || ""); return isFinite(t) ? age(t) : ""; }
  function buildNoteDetail(box, n) {
    if (n.anchors && n.anchors.length) {
      for (const a of n.anchors) {
        const name = a.source_path ? String(a.source_path).split("/").pop() : "source";
        const anchor = a.source_anchor ? " · " + a.source_anchor : "";
        const chip = el('<div class="nanchor"></div>'); chip.textContent = "↳ " + name + anchor; box.appendChild(chip);
        if (a.source_selection) { const q = el('<div class="nquote"></div>'); q.textContent = a.source_selection; box.appendChild(q); }
      }
    }
    if (n.user_draft) { const d = el('<div class="ndraft"></div>'); d.textContent = n.user_draft; box.appendChild(d); }
    if (n.turns && n.turns.length) {
      for (const t of n.turns) {
        const turn = el('<div class="nturn"><span class="nrole"></span><div class="ntext"></div></div>');
        turn.querySelector(".nrole").textContent = t.role === "user" ? "you" : "assistant";
        turn.querySelector(".ntext").textContent = t.content;
        box.appendChild(turn);
      }
    } else if (n.formatted) {
      const f = el('<div class="ntext"></div>'); f.textContent = n.formatted; box.appendChild(f);
    }
  }
  // Which notes are expanded — held OUTSIDE the cards so a list rebuild
  // (loadNotes after a save/status change) puts every card back in the state
  // you left it, instead of collapsing what you were reading (note ba0735c9).
  const expandedNotes = new Set();
  function noteCard(n) {
    const card = el('<div class="card"><div class="crow"><div class="ico">' + iconSvg("✦") + '</div><div class="cb"><div class="ct"><b></b><span class="t"></span></div><p class="cs"></p></div></div><div class="ndetail" style="display:none"></div></div>');
    card.querySelector("b").textContent = noteTitle(n);
    card.querySelector(".t").textContent = noteWhen(n);
    const cs = card.querySelector(".cs");
    cs.textContent = n.formatted || n.user_draft || (n.turns && n.turns.length ? n.turns[n.turns.length - 1].content : "") || "";
    const detail = card.querySelector(".ndetail");
    let built = false;
    const show = () => {
      if (!built) { buildNoteDetail(detail, n); built = true; }
      detail.style.display = ""; cs.style.display = "none";
    };
    if (expandedNotes.has(n.id)) show();
    card.addEventListener("click", () => {
      // A swipe fires a trailing click on mouseup — swallow that one so the
      // resolve gesture doesn't also toggle the detail open.
      if (card.dataset.swiped === "1") { card.dataset.swiped = ""; return; }
      const showing = detail.style.display !== "none";
      if (showing) { detail.style.display = "none"; cs.style.display = ""; expandedNotes.delete(n.id); return; }
      show(); expandedNotes.add(n.id);
    });
    // Swipe left to resolve an open note (or reopen a resolved one) — the same
    // acknowledge gesture as alerts. This now writes through to notes.jsonl on
    // the box, so resolving from the phone sticks across devices.
    // Swipe RIGHT to edit (note 002c8029): opens a sheet with the note's text
    // in a textarea; Save writes through /notes/edit (freshest-on-disk on the
    // box, headline regenerated).
    const resolved = n.status === "resolved";
    attachSwipeArchive(
      card,
      () =>
        api("/notes/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: n.id, status: resolved ? "open" : "resolved" }) })
          .then((r) => { if (!r.ok) throw new Error(); toast(resolved ? "Reopened" : "Resolved"); })
          .catch(() => toast("Couldn't update note — try again")),
      loadNotes,
      () => openNoteEditSheet(n),
    );
    return card;
  }
  // The note edit sheet: the note's text, editable, with one Save action. Only
  // the user's own text (user_draft) is editable — captured turns/anchors are a
  // record, not a draft.
  function openNoteEditSheet(n) {
    openSheet({
      intent: "Note · edit", title: noteTitle(n), ico: "✦", cls: "",
      action: { label: "Delete", danger: true, onClick: () => void deleteNote(n) },
      bodyHtml: '<textarea class="note-edit" id="noteEditTa"></textarea>'
        + '<div class="wbtns"><button class="wbtn" id="noteEditSave">Save</button></div>',
      wire: (body) => {
        const ta = body.querySelector("#noteEditTa");
        ta.value = n.user_draft || "";
        // Same keyboard contract as every other sheet input — without it the
        // full-height sheet got LIFTED by the keyboard transform and its top
        // flew out of the screen (note ba0735c9).
        ta.addEventListener("focus", () => sheetEditFocus(ta));
        ta.addEventListener("blur", sheetEditBlur);
        const save = body.querySelector("#noteEditSave");
        save.onclick = async () => {
          const t = ta.value.trim();
          if (!t) { toast("Note text can't be empty"); return; }
          save.disabled = true;
          try {
            const r = await api("/notes/edit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: n.id, text: t }) });
            const d = await r.json().catch(() => ({}));
            if (!r.ok || d.error) throw new Error(d.error || r.status);
            // Save COLLAPSES (note 122ec04d, superseding ba0735c9's stay-open):
            // the sheet closes and the inline card folds shut — the saved note
            // reads from the refreshed list, not a lingering editor.
            n.user_draft = t;
            toast("Saved.");
            expandedNotes.delete(n.id);
            closeSheet();
            void loadNotes();
            // The box re-headlines the edited note off the response path — refetch
            // once more so the new title lands without leaving the page.
            setTimeout(() => { if (page === "notes") void loadNotes(); }, 3500);
          } catch (e) { toast("Couldn't save: " + (e.message || e)); save.disabled = false; }
        };
      },
    });
  }
  // The notes as last fetched; the search box filters them here (no refetch per keystroke).
  let lastNotes: any[] | null = null;
  const noteText = (n) => [noteTitle(n), n.user_draft, n.formatted, ...((n.turns || []).map((t) => t.content)), ...((n.anchors || []).map((a) => [a.source_path, a.source_selection].join(" ")))].filter(Boolean).join(" ").toLowerCase();
  // Delete a note for good (the DeleteNote tool: its line leaves notes.jsonl; git history keeps it). Two taps.
  let deleteArmed = "";
  async function deleteNote(n) {
    const act = $("sheetAction");
    if (deleteArmed !== n.id) {
      deleteArmed = n.id; act.textContent = "Tap again to delete";
      setTimeout(() => { if (deleteArmed === n.id) { deleteArmed = ""; act.textContent = "Delete"; } }, 3000);
      return;
    }
    deleteArmed = "";
    try {
      const r = await api("/notes/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: n.id }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) throw new Error(d.error || r.status);
      toast("Deleted.");
      expandedNotes.delete(n.id);
      closeSheet();
      void loadNotes();
    } catch (e) { toast("Couldn't delete: " + (e.message || e)); }
  }
  async function loadNotes() {
    const box = $("notesScroll");
    try {
      const d = await (await api("/notes")).json();
      if (d.error) throw new Error(d.error);
      lastNotes = d.notes || [];
      renderNotes();
    } catch (e) { box.innerHTML = '<div class="empty">Notes unavailable: ' + esc(String(e.message || e)) + "</div>"; }
  }
  function renderNotes() {
    const box = $("notesScroll");
    const all = lastNotes || [];
    const q = String($("noteSearch")?.value || "").trim().toLowerCase();
    const list = q ? all.filter((n) => noteText(n).includes(q)) : all;
    {
      box.innerHTML = "";
      if (!all.length) { box.appendChild(el('<div class="empty">No notes yet. Jot one above, or capture them on the laptop — they all show up here.</div>')); return; }
      if (!list.length) { box.appendChild(el('<div class="empty">No note matches “' + esc(q) + '”.</div>')); return; }
      // "cleared" notes are terminal (emptied resolved pile) — the box already
      // drops them from /notes, but filter explicitly so open never catches them.
      const open = list.filter((n) => n.status === "open");
      const resolved = list.filter((n) => n.status === "resolved");
      if (open.length) box.appendChild(el('<div class="sec">Open · ' + open.length + "</div>"));
      for (const n of open) box.appendChild(noteCard(n));
      if (!open.length) box.appendChild(el('<div class="empty">Nothing open — every note is resolved.</div>'));
      if (resolved.length) {
        const holder = el('<div style="margin-top:8px"></div>'); holder.style.display = notesResolvedOpen ? "" : "none";
        // Clear-all empties the resolved pile durably (POST /notes/clear-resolved →
        // the box flips them to the terminal `cleared` status, union-merge-safe).
        // Two-tap confirm so a stray tap can't wipe the list.
        const clr = el('<button class="earlier clearall">Clear all resolved</button>');
        let armed = false, armTimer = 0;
        clr.onclick = async () => {
          if (!armed) { armed = true; clr.textContent = "Tap again to clear " + resolved.length; clr.classList.add("danger"); clearTimeout(armTimer); armTimer = setTimeout(() => { armed = false; clr.textContent = "Clear all resolved"; clr.classList.remove("danger"); }, 3000); markListBusy(3500); return; }
          clr.disabled = true;
          try {
            const r = await api("/notes/clear-resolved", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
            if (!r.ok) throw new Error();
            toast("Cleared.");
            notesResolvedOpen = false;
            void loadNotes();
          } catch { toast("Couldn't clear — try again"); clr.disabled = false; clr.classList.remove("danger"); clr.textContent = "Clear all resolved"; armed = false; }
        };
        holder.appendChild(clr);
        for (const n of resolved) holder.appendChild(noteCard(n));
        const t = el('<button class="earlier"></button>');
        const label = () => { t.textContent = (notesResolvedOpen ? "Hide resolved · " : "Resolved · ") + resolved.length; };
        label();
        t.onclick = () => { notesResolvedOpen = !notesResolvedOpen; holder.style.display = notesResolvedOpen ? "" : "none"; label(); };
        box.appendChild(t); box.appendChild(holder);
      }
      box.appendChild(el('<div style="height:18px"></div>'));
    }
  }
  $("noteSearch")?.addEventListener("input", () => renderNotes());
  // New-note composer (POST /notes → app buildNote/addNote). Save button submits;
  // Return inserts a newline (matches the per-device Enter preference).
  (() => {
    const ta = $("noteInput"), btn = $("noteAddBtn");
    if (!ta || !btn) return;
    const autosize = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 120) + "px"; };
    ta.addEventListener("input", autosize);
    wireTap(btn, async () => {
      const text = ta.value.trim();
      if (!text) return;
      btn.disabled = true;
      try {
        const r = await api("/notes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.error) throw new Error(d.error || r.status);
        ta.value = ""; autosize();
        toast("Note saved.");
        void loadNotes();
        // The box generates the AI headline right after the note lands (a quick
        // model call), so refetch once more a few seconds later to swap the
        // clipped fallback header for the real short title — without making the
        // user leave and come back to see it (note 7e432831).
        setTimeout(() => { if (page === "notes") void loadNotes(); }, 3500);
      } catch (e) { toast("Couldn't save: " + (e.message || e)); }
      finally { btn.disabled = false; }
    });
  })();

  async function loadAlerts() {
    const box = $("alScroll");
    try {
      const d = await (await api("/notifications")).json();
      if (d.error) throw new Error(d.error);
      unreadN = d.unread || 0; setHeader();
      const list = d.notifications || [];
      // Some fixer-written notifications land with a NANOSECOND ts (the box's
      // `date +%s%3N` emits ns, not ms — 19 digits, ~1e18). The age() label
      // already guards against that, but the SORT below and the archive sort
      // read `ts` RAW, so those cards — actually hours old — pin themselves to
      // the TOP as if they were the newest alerts ("auto fixes always say now /
      // as if they're super recent", report 381be0e1→558c993a). Normalize the
      // stamp down to ms ONCE here so every consumer (sort, label, archive) agrees.
      for (const n of list) { if (typeof n.ts === "number") { while (n.ts >= 1e14) n.ts = Math.floor(n.ts / 1000); } }
      lastNotifList = list;
      box.innerHTML = "";
      if (!list.length) { box.appendChild(el('<div class="empty">Nothing yet. Questions, finished work and failures land here — with a push if notifications are on and the app isn’t already open.</div>')); return; }
      // Strictly chronological (note 56e57731): the server sorts by ts, but the
      // local "Updated to vX" card was unshifted ABOVE the list — an old unread
      // update pinned itself over today's alerts. Re-sort so nothing jumps line.
      list.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      const unread = list.filter((n) => !n.read);
      // The Archive orders by WHEN YOU ARCHIVED (answered/read time — readAt is
      // the read-marker ts the server now folds in), not by when the alert
      // originally fired (note 56e57731): the pile reads as "what I put away,
      // most recently first".
      const archived = list.filter((n) => n.read)
        .sort((a, b) => (b.answeredAt || b.readAt || b.ts || 0) - (a.answeredAt || a.readAt || a.ts || 0));
      const actions = unread.filter((n) => n.kind === "ask");
      const infos = unread.filter((n) => n.kind !== "ask");

      if (actions.length) box.appendChild(el('<div class="sec">Needs a reply</div>'));
      for (const n of actions) box.appendChild(alertCard(n, true));
      if (infos.length) box.appendChild(el('<div class="sec">Heads-up</div>'));
      for (const n of infos) box.appendChild(alertCard(n, false));
      if (!unread.length) box.appendChild(el('<div class="empty">All caught up — swipe a card left to archive it.</div>'));
      if (archived.length) {
        const holder = el('<div style="margin-top:8px"></div>'); holder.style.display = alertArchiveOpen ? "" : "none";
        // Clear the whole read/archived pile in one shot (POST /notifications/clear
        // writes a single clear-before marker) instead of swiping each — the 80-item
        // cap means swiping never actually empties it. Two-tap confirm; pending
        // unread asks are kept.
        const clrN = el('<button class="earlier clearall">Clear archive · ' + archived.length + "</button>");
        let armedN = false, armNT = 0;
        clrN.onclick = async () => {
          if (!armedN) { armedN = true; clrN.textContent = "Tap again to clear " + archived.length; clrN.classList.add("danger"); clearTimeout(armNT); armNT = setTimeout(() => { armedN = false; clrN.textContent = "Clear archive · " + archived.length; clrN.classList.remove("danger"); }, 3000); markListBusy(3500); return; }
          clrN.disabled = true;
          try {
            const r = await api("/notifications/clear", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
            if (!r.ok) throw new Error();
            toast("Notifications cleared."); alertArchiveOpen = false; void loadAlerts();
          } catch { toast("Couldn't clear — try again"); clrN.disabled = false; clrN.classList.remove("danger"); clrN.textContent = "Clear archive · " + archived.length; armedN = false; }
        };
        holder.appendChild(clrN);
        for (const n of archived) holder.appendChild(alertCard(n, false));
        const t = el('<button class="earlier"></button>');
        const label = () => { t.textContent = (alertArchiveOpen ? "Hide archive · " : "Archive · ") + archived.length; };
        label();
        t.onclick = () => { alertArchiveOpen = !alertArchiveOpen; holder.style.display = alertArchiveOpen ? "" : "none"; label(); };
        box.appendChild(t); box.appendChild(holder);
      } else { alertArchiveOpen = false; }
      box.appendChild(el('<div style="height:18px"></div>'));
    } catch (e) { box.innerHTML = '<div class="empty">Alerts unavailable: ' + esc(String(e.message || e)) + "</div>"; }
  }
  const markRead = (id) => api("/notifications/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) }).catch(() => {});

  // The feed as last fetched — so an action on one card (answering an ask) can
  // reason about its siblings (other pending asks on the same conversation).
  let lastNotifList = [];
  // ---- unified AskUser ----
  // EVERY kind:"ask" notification — a real AskUser fork AND the parked-mission
  // escalation — renders in the ONE "needs you" style: a neutral card with the
  // near-white status dot, the question, the agent's option buttons (when it gave
  // any), and ALWAYS a freeform answer + a top-right chat icon to dig in. There
  // is no separate "summary ask" card anymore. The structured `deliberation`
  // payload (from the AskUser tool's `options`) is optional — an ask without it
  // still renders here, just with no option buttons.
  function deliberationFromNotif(n) {
    const d = n.deliberation || {};
    const ask = d.ask || n.summary || n.body || "";
    return {
      mission: d.mission || n.title || "",
      ask,
      askLong: d.askLong || d.ask || n.body || n.summary || ask,
      // [ask-object] The declared fallback + stakes, so every ask surface can
      // show "if you don't answer, X" and the defer relay can feed X back.
      stakes: d.stakes || "",
      onDefer: d.onDefer || "",
      options: Array.isArray(d.options) ? d.options : [],
    };
  }
  // The card is a SUMMARY (icon + title + intention + 2-line summary) built from
  // the producer's structured deliverable, falling back to a derived category.
  // Tap opens the bottom sheet with the full report; swipe left archives.
  function alertCard(n, isAction) {
    // EVERY ask (a decision the agent needs from you) is the unified "needs you"
    // card — whether or not it carries structured options. isAction (unread ask)
    // and any kind:"ask" both route here. So does ANY alert that carries a
    // recorded decision (answeredWith) — e.g. an info alert whose follow-up
    // relayed your call to the mission: one visual language for every decision
    // you made, whatever surface it was made on (note ff31231e).
    if (isAction || n.kind === "ask" || n.answeredWith) return needsYouCard(n);
    const meta = alertMeta(n);
    const card = el('<div class="card' + (isAction ? " ask" : n.read ? "" : " unread") + '"><div class="crow"><div class="ico"></div><div class="cb"><div class="ct"><b></b><span class="t"></span></div><div class="metabar"></div><p class="cs"></p></div></div></div>');
    const ico = card.querySelector(".ico");
    const cls = n.cls || meta.cls;
    ico.innerHTML = iconSvg(n.icon || meta.icon); if (cls) ico.classList.add(cls);
    card.querySelector("b").textContent = n.title;
    card.querySelector(".t").textContent = age(n.ts);
    card.querySelector(".metabar").textContent = n.intention || meta.intention;
    card.querySelector(".cs").textContent = n.summary || n.body || "";
    card.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("a")) return;
      if (card.dataset.swiped === "1") { card.dataset.swiped = ""; return; }
      openNotif(n);
    });
    attachSwipeArchive(card, n.read
      ? () => api("/notifications/hide", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: n.id }) }).catch(() => {})
      : () => markRead(n.id));
    return card;
  }
  // Tap -> the alert's text in the sheet and, when it came from a chat, that chat's last messages, read-only
  // (GET /conversation: the box's existing window of a conversation). Chatting happens on the laptop.
  function openNotif(n) {
    if (!n.read) { n.read = true; void markRead(n.id); }
    void openConvView(n);
  }
  async function openConvView(n) {
    const meta = alertMeta(n);
    const text = n.body || n.summary || (n.deliberation && n.deliberation.askLong) || "";
    const head = '<div class="md">' + md(text || "*(no summary)*") + "</div>";
    openSheet({ intent: n.intention || meta.intention, title: n.title, ico: n.icon || meta.icon, cls: n.cls || meta.cls, bodyHtml: head + (n.convId ? '<div class="convro" data-el="conv-readonly"><div class="sec">The chat · read-only</div><div class="empty">Loading…</div></div>' : "") });
    if (!n.convId) return;
    const holder = $("sheetBody").querySelector('[data-el="conv-readonly"]');
    try {
      const d = await (await api("/conversation?id=" + encodeURIComponent(n.convId) + "&n=20")).json();
      if (!holder || !holder.isConnected) return;
      if (d.error) throw new Error(d.error);
      const msgs = (d.messages || []).filter((m) => (m.role === "user" || m.role === "assistant") && String(m.content || "").trim());
      holder.innerHTML = '<div class="sec">' + esc(d.title || "The chat") + " · read-only</div>" + (msgs.length
        ? msgs.map((m) => '<div class="ro ' + (m.role === "user" ? "u" : "a") + '"><span class="nrole">' + (m.role === "user" ? "you" : "agent") + '</span><div class="md">' + md(String(m.content)) + "</div></div>").join("")
        : '<div class="empty">No messages.</div>');
    } catch (e) {
      if (holder) holder.innerHTML = '<div class="empty">The chat could not be loaded: ' + esc(String(e.message || e)) + "</div>";
    }
  }
  // The feed card for an ask. A neutral card: a subtle near-white "Needs you" dot
  // + label, a top-right chat icon that opens the deliberation sheet ("dig in"),
  // the question, the agent's option buttons (only when it supplied options — one
  // may be the near-white primary), and ALWAYS a freeform answer field with the
  // send arrow inset. An option-tap or a committed freeform answer resolves the
  // ask via /answer; the chat icon (or tapping the body) opens the sheet.
  function needsYouCard(n) {
    const del = deliberationFromNotif(n);
    // A read/answered ask is DECIDED — its card shows the recorded decision, not
    // live buttons. (Archived asks used to re-render tappable options; tapping a
    // stale one fired /answer into a long-resolved thread.)
    const decided = !!n.answeredWith || !!n.read;
    const card = el('<div class="card needsyou' + (decided ? " decided" : "") + '"></div>');
    const lbl = el('<div class="needs-lbl"><span class="d"></span><span class="t"></span><span class="digin" title="Talk it through"></span></div>');
    lbl.querySelector(".t").textContent = decided ? "Your call · decided" : "Needs you";
    const digin = lbl.querySelector(".digin"); digin.innerHTML = iconSvg("chat");
    digin.onclick = (e) => { e.stopPropagation(); if (n.convId) void openConvView(n); };
    card.appendChild(lbl);
    const q = el('<div class="needs-q"></div>'); q.textContent = del.ask; card.appendChild(q);
    if (decided) {
      // The decision that settled it, on the card itself (note d4db3542) — or an
      // honest "no decision recorded" for an ask that was swiped away/superseded.
      card.appendChild(el('<div class="needs-decided">' + (n.answeredWith ? "✓ <b>" + esc(n.answeredWith) + "</b>" : "dismissed — no decision recorded") + "</div>"));
    } else if (del.options.length) {
      const qa = el('<div class="needs-qa"></div>');
      for (const opt of del.options) {
        const b = el('<button></button>');
        b.textContent = opt.answer;
        // Lock every option the instant one is tapped — an accidental double-tap
        // must not fire a second answer (note 6693e931). The backend collapses
        // repeats too (deterministic clientMsgId), this just makes it visible.
        b.onclick = (e) => { e.stopPropagation(); qa.querySelectorAll("button").forEach((x) => { x.disabled = true; }); resolveDeliberation(n, opt.answer); };
        qa.appendChild(b);
      }
      card.appendChild(qa);
    }
    // [ask-object] "Not now" — the formal defer terminal, on every live ask card.
    // It ends the ask AND resumes the parked mission (unlike swipe-archive, which
    // only hid the card and left the mission stranded AWAITING_USER).
    if (!decided) {
      if (del.onDefer) card.appendChild(el('<div class="supask-hint" style="margin-top:8px">If you don’t answer: ' + esc(del.onDefer) + (del.stakes === "high" ? " · high-stakes, so I’ll hold" : "") + "</div>"));
      const df = el('<button class="needs-defer">Not now</button>');
      df.onclick = (e) => { e.stopPropagation(); (df as HTMLButtonElement).disabled = true; deferAsk(n); };
      card.appendChild(df);
    }
    // Freeform answer lives in the dig-in sheet now, not inline on every feed card —
    // the always-present input made each card ~50px taller so only ~2 fit on screen
    // (user: cards spill over, can't see the recent needs-you). Tap the card / chat
    // icon to answer in your words; options stay tappable inline.
    card.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button,input,.rsend,.digin")) return;
      if (card.dataset.swiped === "1") { card.dataset.swiped = ""; return; }
      if (n.convId) void openConvView(n);
    });
    attachSwipeArchive(card, n.read
      ? () => api("/notifications/hide", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: n.id }) }).catch(() => {})
      : () => markRead(n.id));
    return card;
  }
  const resolvingAsks = new Set();
  function resolveDeliberation(n, answer) {
    // One decision per (ask, answer), deterministically: repeat taps of the
    // SAME option are locked out here, and the clientMsgId is DERIVED from the
    // ask id + answer (not minted fresh per tap), so even a repeat that slips
    // through — a double-fired handler, a PWA retry — collapses to ONE answer
    // turn on the box (note 6693e931). Keyed per ANSWER, not per ask: a
    // decided-but-open conversation can send a REVISED call later.
    const rkey = n.id + "\u0000" + answer;
    if (resolvingAsks.has(rkey)) return;
    resolvingAsks.add(rkey);
    setTimeout(() => resolvingAsks.delete(rkey), 60_000);
    const clientMsgId = "answer-" + n.id + "-" + encodeURIComponent(answer).slice(0, 32);
    if (n.convId) {
      // notifId lets the box durably stamp WHICH answer settled this ask
      // (answeredWith), so the Archive shows the decision that was made.
      // askConvId pins the decision receipt into the ask's own thread (the
      // thread stays TALKABLE after — deciding records, it doesn't close).
      api("/answer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ convId: n.convId, text: answer, clientMsgId, notifId: n.id, ...(n.kind === "ask" && n.askConvId ? { askConvId: n.askConvId } : {}) }) }).catch(() => {});
    }
    // One answer settles the DECISION, not just this card: retire every live ask
    // card pointing at the same conversation. The deadlocked self-test stacked 3
    // cards for one fork; tapping the stale leftovers fed duplicate replies into
    // the thread ("Force-close it" landed twice as separate turns).
    for (const s of lastNotifList) {
      if (s.kind === "ask" && !s.read && s.id !== n.id && s.convId && n.convId && s.convId === n.convId) markRead(s.id);
    }
    markRead(n.id);
    // [unified ask] Deciding does NOT slam the sheet shut — the conversation
    // keeps going (keep-talking). Re-render the ask sheet in its decided-but-
    // live form; an info sheet just stays as it is (its tapped card is already
    // marked by the sheet's own wiring).
    n.answeredWith = answer; n.answeredAt = Date.now(); n.read = true;
    void loadAlerts();
  }
  // [ask-object] "Not now" — the ask's terminal that ends it WITHOUT choosing an
  // option and RESUMES the parked mission (the box injects the fallback
  // instruction and clears AWAITING_USER; a swiped-away card used to strand the
  // mission forever). Mirrors resolveDeliberation's /answer relay but tags
  // defer:true and records "Not now" as the decision on the card + archive.
  function deferAsk(n) {
    const rkey = n.id + " __defer__";
    if (resolvingAsks.has(rkey)) return;
    resolvingAsks.add(rkey);
    setTimeout(() => resolvingAsks.delete(rkey), 60_000);
    const del = deliberationFromNotif(n);
    if (n.convId) {
      api("/answer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ convId: n.convId, text: "Not now", clientMsgId: "defer-" + n.id, notifId: n.id, defer: true, ...(del.onDefer ? { onDefer: del.onDefer } : {}), ...(n.kind === "ask" && n.askConvId ? { askConvId: n.askConvId } : {}) }) }).catch(() => {});
    }
    // One terminal settles the DECISION: retire every live ask card for the same
    // conversation, same as answering (a mission has ONE open ask).
    for (const s of lastNotifList) {
      if (s.kind === "ask" && !s.read && s.id !== n.id && s.convId && n.convId && s.convId === n.convId) markRead(s.id);
    }
    markRead(n.id);
    n.answeredWith = "Not now"; n.answeredAt = Date.now(); n.read = true;
    void loadAlerts();
  }
  function attachSwipeArchive(card: any, action: any, reload?: any, rightAction?: any) {
    reload = reload || loadAlerts;
    let x0 = 0, y0 = 0, dx = 0, mode = null;
    const start = (x, y) => { x0 = x; y0 = y; dx = 0; mode = null; markListBusy(); card.style.transition = "none"; };
    const move = (x, y) => {
      if (mode === "v") return false;
      const ndx = x - x0, ndy = y - y0;
      if (mode === null) {
        if (Math.abs(ndx) < 9 && Math.abs(ndy) < 9) return false;
        mode = Math.abs(ndx) > Math.abs(ndy) ? "h" : "v";
        if (mode === "v") return false;
      }
      // Right-swipe only tracks when a rightAction exists (notes: swipe right to
      // edit, note 002c8029); everywhere else the card stays pinned at 0 so the
      // gesture keeps meaning exactly one thing (left = archive/resolve).
      dx = rightAction ? Math.max(-innerWidth, Math.min(ndx, 90)) : Math.min(0, ndx);
      card.style.transform = "translateX(" + dx + "px)";
      return true;
    };
    const end = async () => {
      if (mode !== "h") { mode = null; return; }
      // A mouse drag fires a click on mouseup — flag it so the card's
      // tap-for-summary handler swallows that one click. TIMED, not
      // consume-on-next-click: touch swipes fire no click at all, and a
      // lingering flag would eat the next real tap (the "tap does nothing"
      // bug).
      card.dataset.swiped = "1";
      setTimeout(() => { card.dataset.swiped = ""; }, 400);
      mode = null;
      card.style.transition = "transform .18s ease, opacity .18s ease";
      if (rightAction && dx > 60) {
        // Right-swipe: snap back and hand off (an edit opens a sheet — the card
        // itself stays in place).
        card.style.transform = "";
        rightAction();
      } else if (dx < -70) {
        // Remember WHERE in the list you were, so the reload below doesn't yank you
        // to the top. loadAlerts/loadNotes rebuild innerHTML (scrollTop
        // → 0), so swiping a card DOWN in the archive scrolled you back up to the
        // unread section — making it look like the swipe hit the wrong card and a
        // "normal" alert reappeared. It didn't; the view just jumped.
        const scroller = card.closest("#alScroll,#notesScroll");
        const prevTop = scroller ? scroller.scrollTop : 0;
        card.style.transform = "translateX(-110%)"; card.style.opacity = "0";
        // Collapse the card's vertical space as it leaves so the list closes the
        // gap smoothly. A translateX alone leaves the card's HEIGHT in the layout,
        // so a hole sat where it was until the reload landed (the swipe-gap /
        // orphaned-section-header jank in the recording). Animate height + margins
        // + padding to 0, then reload to reconcile the count and headers.
        const h = card.offsetHeight;
        card.style.height = h + "px"; card.style.overflow = "hidden"; card.style.boxSizing = "border-box";
        requestAnimationFrame(() => {
          card.style.transition = "transform .18s ease, opacity .18s ease, height .2s ease, margin .2s ease, padding .2s ease";
          card.style.height = "0px"; card.style.marginTop = "0px"; card.style.marginBottom = "0px"; card.style.paddingTop = "0px"; card.style.paddingBottom = "0px";
        });
        await action();
        setTimeout(async () => {
          await Promise.resolve(reload());
          // Put the scroll back where it was (clamped to the now-shorter list) so the
          // removed card just closes up in place instead of the view jumping to top.
          if (scroller) scroller.scrollTop = Math.min(prevTop, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
        }, 240);
      } else {
        // Started a horizontal drag but released short of the archive threshold
        // — snaps back. Logged so a run of these reads as "I kept trying to
        // swipe and nothing happened".
        card.style.transform = "";
      }
    };
    card.addEventListener("touchstart", (e) => start(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
    // [axis-lock] touchmove is NON-passive so that once the gesture is locked
    // horizontal (move() returns true) we preventDefault and the list stops
    // scrolling underneath the finger. Without this the card followed the
    // finger while the scroller ALSO scrolled — the two fought, the swipe
    // distance never reached threshold, and archiving felt "state-dependent"
    // and "all over the place". Mirrors the drawer swipe-open handler, which
    // has always locked its axis this way.
    card.addEventListener("touchmove", (e) => { if (move(e.touches[0].clientX, e.touches[0].clientY)) e.preventDefault(); }, { passive: false });
    card.addEventListener("touchend", end);
    card.addEventListener("touchcancel", end);
    let mouseDown = false;
    card.addEventListener("mousedown", (e) => { if (e.target.closest(".rinp,.rsend")) return; mouseDown = true; start(e.clientX, e.clientY); });
    window.addEventListener("mousemove", (e) => { if (mouseDown) move(e.clientX, e.clientY); });
    window.addEventListener("mouseup", () => { if (mouseDown) { mouseDown = false; end(); } });
  }

  // ---------- settings drawer ----------
  // Box & settings: notifications on/off, a test push, the box's version.
  // (The Claude/feedback screen that shared this drawer is gone.)
  function openDrawer() {
    $("drawer").classList.add("open");
    refreshPushUi(); void refreshPushPreference();
    void refreshState().then((d) => {
      $("boxVer").textContent = d && d.version ? "vault-chat v" + d.version : "";
    });
  }
  function closeDrawer() { $("drawer").classList.remove("open"); }
  $("drawerMenuBtn").onclick = (e) => { e.stopPropagation(); menu.classList.toggle("on"); };
  // (Composer Enter-key toggle removed — the phone Return key always inserts a
  // newline; sending is via the send button. enterkeyhint="enter" is set in the
  // static markup and on the sheet reply input.)

  // ---------- push ----------
  // Server user preference only. Existing device subscription/OS permission is not consent
  // to automatic pushes, and changing this toggle never prompts or unsubscribes a device.
  function showPushPreference(enabled) {
    $("pushLegacySw").classList.toggle("on", enabled);
    $("pushLegacySw").setAttribute("aria-checked", String(enabled));
    $("pushLegacyState").textContent = enabled ? "On — automatic questions, failures and finishes while away." : "Off — push only when you ask for that work.";
  }
  async function refreshPushPreference() {
    $("pushLegacySw").disabled = true;
    try {
      const r = await api("/push/preferences");
      if (!r.ok) throw new Error("preference unavailable");
      showPushPreference((await r.json()).legacyAutomatic === true);
      $("pushLegacySw").disabled = false;
    } catch { $("pushLegacyState").textContent = "Could not load automatic-push setting. Reopen Settings to retry."; }
  }
  $("pushLegacySw").onclick = async () => {
    const enabled = $("pushLegacySw").getAttribute("aria-checked") !== "true";
    $("pushLegacySw").disabled = true;
    try {
      const r = await api("/push/preferences", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ legacyAutomatic: enabled }) });
      if (!r.ok) throw new Error("preference not saved");
      showPushPreference((await r.json()).legacyAutomatic === true);
    } catch { toast("Automatic-push setting was not saved."); }
    finally { $("pushLegacySw").disabled = false; }
  };
  const b64uToBytes = (s) => { const pad = "=".repeat((4 - (s.length % 4)) % 4); const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(raw, (c) => c.charCodeAt(0)); };
  const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window;
  async function currentSub() { if (!pushSupported()) return null; const reg = await navigator.serviceWorker.getRegistration().catch(() => null); return reg ? await reg.pushManager.getSubscription().catch(() => null) : null; }
  // Device capability is separate from server consent. Only a tap subscribes;
  // an existing permission grant never opts Carl into automatic phone pushes.
  async function refreshPushUi() {
    if (!pushSupported()) { $("pushState").textContent = navigator.standalone === false ? "Add to your Home Screen first — Safari tabs can't receive push." : "Push not supported here."; $("pushSw").classList.remove("on"); $("pushTestBtn").style.display = "none"; return; }
    const sub = await currentSub();
    $("pushSw").classList.toggle("on", !!sub);
    $("pushState").textContent = sub ? "On for this device." : (Notification.permission === "denied" ? "Blocked in iOS Settings for this app." : "Off — flip the switch once.");
    $("pushTestBtn").style.display = sub ? "" : "none";
  }
  async function pushSubscribe() {
    const perm = await Notification.requestPermission(); if (perm !== "granted") { toast("Notifications not allowed."); return false; }
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
  $("pushSw").onclick = async () => {
    try {
      const sub = await currentSub();
      if (sub) {
        try { localStorage.setItem("vc_push_optout", "1"); } catch {}
        await api("/push/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
        await sub.unsubscribe().catch(() => {});
        toast("Notifications off.");
      } else {
        try { localStorage.removeItem("vc_push_optout"); } catch {}
        if (await pushSubscribe()) toast("Notifications on.");
      }
    } catch (e) { toast("Push setup failed: " + (e.message || e)); }
    refreshPushUi();
  };
  $("pushTestBtn").onclick = async () => { const r = await api("/push/test", { method: "POST" }).catch(() => null); const d = r ? await r.json().catch(() => ({})) : {}; toast(d.error ? "Test failed: " + d.error : "Test sent — should arrive in seconds."); };

  // ---------- in-app keyboard ----------
  // (None: the phone uses the system keyboard. The marker ends the push section above.)

  // ---------- live: the box's feed ----------
  // /poll?after=<cursor> long-polls the vault's records; the phone only reacts to the signals that move its two
  // lists (a new or changed alert, the notes file, the push setting) and to the phone app being switched off.
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
      else if (s.type === "setting" && s.key === "pushAutomatic") showPushPreference(s.value === true);
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
  // Touching a list marks it briefly busy, so a background tick can't rebuild it while Carl reads it.
  ["alScroll", "notesScroll"].forEach((id) => { const s = $(id); if (s) s.addEventListener("touchstart", () => markListBusy(2500), { passive: true }); });
  if (window.visualViewport) {
    const vv = window.visualViewport;
    // --kb: the keyboard's height, which a sheet's input reserves (`.sheet.editing`); 0 with no keyboard.
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
  // A push tapped while the app is open: the service worker hands its link over; it opens the alert it is about.
  const openFromLink = (link: string) => {
    try {
      const p = new URLSearchParams(String(link).split("?")[1] || "");
      const id = p.get("ask") || p.get("notif");
      const conv = p.get("conv");
      setPage("alerts");
      if (!id && !conv) return;
      void (async () => {
        const d = await (await api("/notifications")).json().catch(() => ({}));
        const list = d.notifications || [];
        const n = (id && list.find((x) => x.id === id)) || (conv && list.find((x) => x.convId === conv && !x.read)) || null;
        if (n) openNotif(n);
        else if (conv) void openConvView({ title: "Chat", convId: conv, intention: "From a push" });
      })();
    } catch {}
  };
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (e) => {
      const d = (e && e.data) || {};
      if (d.type === "deeplink" && d.url) openFromLink(String(d.url));
    });
  }

  // The scroll fade: per edge, only when content is cut off on that edge.
  const fadeWatch = () => {
    document.querySelectorAll(".scroll,.sheet-body").forEach((sc) => {
      const can = sc.scrollHeight > sc.clientHeight + 4;
      sc.classList.toggle("fade-top", can && sc.scrollTop > 4);
      sc.classList.toggle("fade-bot", can && sc.scrollTop + sc.clientHeight < sc.scrollHeight - 4);
    });
  };
  new MutationObserver(fadeWatch).observe(document.body, { childList: true, subtree: true });
  window.addEventListener("resize", fadeWatch);
  document.addEventListener("scroll", fadeWatch, true);
  fadeWatch();

  // A cold launch from a push (?conv= / ?ask=) opens that alert; the link is for this open only.
  if (qs.get("conv") || qs.get("ask")) {
    openFromLink(location.search);
    try { const u = new URL(location.href); u.searchParams.delete("conv"); u.searchParams.delete("ask"); history.replaceState(history.state, "", u.pathname + u.search + u.hash); } catch {}
  } else setPage(qs.get("page") === "notes" ? "notes" : "alerts");
  void refreshBadge();
  void pollLoop();
  setInterval(() => { if (document.visibilityState === "visible") void refreshBadge(); }, 45000);
}
