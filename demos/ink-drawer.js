/* Mirrors the Conversations drawer's open state onto <body> as .cdraw-open,
   so the skin can recede the chat behind it (the app itself sets no body
   class for this). Pure observation — no app logic touched. */
(function () {
  function boot() {
    var d = document.getElementById("cdraw");
    if (!d) return setTimeout(boot, 60);
    var sync = function () { document.body.classList.toggle("cdraw-open", d.classList.contains("on")); };
    new MutationObserver(sync).observe(d, { attributes: true, attributeFilter: ["class"] });
    sync();
  }
  boot();
})();
