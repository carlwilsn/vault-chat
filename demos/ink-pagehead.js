/* Builds a masthead at the top of each non-chat page (Activity / Alerts /
   Notes) and keeps its count live off the existing menu badges. Skin-only —
   no app logic touched. */
(function () {
  var PAGES = [
    { page: "activity", host: "#pAct", title: "Activity", caption: "missions & workers", badge: "mAct", unit: "running" },
    { page: "alerts", host: "#pAl", title: "Alerts", caption: "decisions & updates", badge: "mAl", unit: "unread" },
    { page: "notes", host: "#pNotes", title: "Notes", caption: "quick captures for the assistant" },
  ];
  function ensure() {
    for (var i = 0; i < PAGES.length; i++) {
      var p = PAGES[i], host = document.querySelector(p.host);
      if (!host) continue;
      if (!host.querySelector(".ink-mast")) {
        var d = document.createElement("div");
        d.className = "ink-mast";
        d.innerHTML =
          '<div class="ink-mast-row"><h1></h1><span class="ink-mast-ct"></span></div><p></p>';
        d.querySelector("h1").textContent = p.title;
        d.querySelector("p").textContent = p.caption;
        host.insertBefore(d, host.firstChild);
      }
      if (p.badge) {
        var b = document.getElementById(p.badge);
        var ct = host.querySelector(".ink-mast-ct");
        if (b && ct) {
          var zero = b.classList.contains("zero");
          var n = (b.textContent || "").trim();
          ct.textContent = zero || !n || n === "0" ? "" : n + " " + p.unit;
        }
      }
    }
  }
  function boot() {
    if (!document.body) return setTimeout(boot, 40);
    new MutationObserver(ensure).observe(document.body, { childList: true, subtree: true, characterData: true });
    ensure();
  }
  boot();
})();
