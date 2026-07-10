/* Ink glyph pass — replace the two text glyphs (↑ send, ✕ close) with thin
   stroke SVGs so the app speaks one icon voice, while KEEPING the app's own
   icons. Re-applies whenever the app re-renders the glyph (it toggles the send
   button), and never touches the running-state "stop" button (only swaps the
   exact ↑ / ✕ glyphs). Idempotent — our svg carries data-ink so we skip it. */
(function () {
  var A = 'fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"';
  function svg(inner) { return '<svg viewBox="0 0 24 24" ' + A + ' data-ink="1">' + inner + "</svg>"; }
  function node(m) { var t = document.createElement("template"); t.innerHTML = m.trim(); return t.content.firstChild; }
  var JOBS = [
    [".send", "↑", '<path d="M12 19V6M6 12l6-6 6 6"/>'],
    [".sheet-x", "✕", '<path d="M6 6l12 12M18 6L6 18"/>'],
  ];
  function tick() {
    for (var i = 0; i < JOBS.length; i++) {
      var sel = JOBS[i][0], glyph = JOBS[i][1], inner = JOBS[i][2];
      var list = document.querySelectorAll(sel);
      for (var j = 0; j < list.length; j++) {
        var el = list[j];
        if (el.querySelector("svg[data-ink]")) continue; // already ours
        if (el.querySelector("svg")) continue;           // app's own svg — leave it
        if (el.textContent.trim() !== glyph) continue;   // not the expected glyph
        el.textContent = "";
        el.appendChild(node(svg(inner)));
      }
    }
  }
  function boot() {
    if (!document.body) return setTimeout(boot, 40);
    new MutationObserver(tick).observe(document.body, { childList: true, subtree: true });
    tick();
  }
  boot();
})();
