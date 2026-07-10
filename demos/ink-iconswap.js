/* Full icon-set swap. Reads window.INK_ICONS (slot -> inline SVG string, set
   by an icons-<set>.js loaded before this) and replaces every app icon with
   that set's version. Sizes come from CSS (the injected SVGs have no width/
   height), so one set swaps cleanly. Resilient to async boot + re-renders. */
(function () {
  var ICONS = window.INK_ICONS || {};
  // [selector, slot]. Elements with a label (rows, New) keep their text —
  // we replace the <svg> in place. Glyph buttons (send, close) get an svg.
  var MAP = [
    ["#convBtn", "chat"],
    ["#menuBtn", "menu"],
    ['.mrow[data-page="chat"]', "chat"],
    ['.mrow[data-page="activity"]', "activity"],
    ['.mrow[data-page="alerts"]', "bell"],
    ['.mrow[data-page="notes"]', "notes"],
    ["#voiceRow", "mic"],
    ["#settingsRow", "settings"],
    ["#newBtn", "plus"],
    [".sheet-back", "back"],
    [".send", "send"],
    [".sheet-x", "close"],
    ["#vMuteBtn", "mic"],
    ["#vEndBtn", "close"],
  ];
  var GLYPHS = { send: "↑", close: "✕" }; // dual-state buttons: only swap the glyph
  function nodeFor(markup) {
    var t = document.createElement("template");
    t.innerHTML = (markup || "").trim();
    return t.content.firstChild;
  }
  function swapOne(el, slot) {
    var markup = ICONS[slot];
    if (!el || !markup) return;
    var cur = el.querySelector("svg");
    if (cur && cur.getAttribute("data-ink")) return; // already ours
    var node = nodeFor(markup);
    if (!node) return;
    node.setAttribute("data-ink", "1");
    if (cur) { cur.replaceWith(node); return; }      // replace the app's own svg
    var g = GLYPHS[slot];                            // glyph button (send/close)
    if (g && el.textContent.trim() !== g) return;    // leave a non-glyph (e.g. stop) state
    el.textContent = "";
    el.appendChild(node);
  }
  function apply() {
    for (var i = 0; i < MAP.length; i++) {
      var sel = MAP[i][0], slot = MAP[i][1];
      var list = document.querySelectorAll(sel);
      for (var j = 0; j < list.length; j++) swapOne(list[j], slot);
    }
  }
  function boot() {
    if (!document.body) return setTimeout(boot, 40);
    new MutationObserver(apply).observe(document.body, { childList: true, subtree: true });
    apply();
  }
  boot();
})();
