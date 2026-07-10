/* Ink icon pass — swap the two text glyphs (↑ send, ✕ close) for thin-stroke
   SVGs so the whole app speaks ONE icon voice (stroke 1.5, round caps).
   Resilient to the app's async boot: observes the DOM and is idempotent.
   When the icon research lands we drop in Phosphor Thin here instead. */
(function () {
  var A = 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
  function svg(inner) { return '<svg viewBox="0 0 24 24" ' + A + '>' + inner + "</svg>"; }
  var GLYPH = {
    send: '<path d="M12 19V6M6 12l6-6 6 6"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
  };
  function set(sel, inner) {
    document.querySelectorAll(sel).forEach(function (b) {
      if (b.getAttribute("data-icd")) return;
      b.setAttribute("data-icd", "1");
      b.textContent = "";
      b.innerHTML = svg(inner);
    });
  }
  function apply() {
    set(".send", GLYPH.send);
    set(".sheet-x", GLYPH.x);
    set(".newbtn", GLYPH.plus); // note: newbtn also has a text label; handled below
  }
  // newbtn has "New" text next to its icon — restore the label after swap
  function fixNew() {
    document.querySelectorAll(".newbtn[data-icd]").forEach(function (b) {
      if (b.getAttribute("data-icd2")) return;
      b.setAttribute("data-icd2", "1");
      b.insertAdjacentText("beforeend", "New");
    });
  }
  function tick() { apply(); fixNew(); }
  function boot() {
    if (!document.body) return setTimeout(boot, 40);
    new MutationObserver(tick).observe(document.body, { childList: true, subtree: true });
    tick();
  }
  boot();
})();
