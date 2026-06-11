// Service worker for the vault-chat phone PWA. Push + notification clicks
// only — deliberately no offline cache: the box being reachable IS the
// product, and a stale cached shell would only hide that truth.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { body: e.data ? e.data.text() : "" };
  }
  e.waitUntil(
    (async () => {
      // Don't buzz the user about something they're already looking at. If the
      // app is open and focused/visible, skip the OS banner — the in-app Alerts
      // badge already updates live. Only raise an OS notification when the app
      // is backgrounded or closed, which is the only time a push earns a buzz.
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const foreground = wins.some((w) => w.visibilityState === "visible" && w.focused);
      if (foreground) return;
      await self.registration.showNotification(d.title || "vault-chat", {
        body: d.body || "",
        tag: d.tag || undefined,
        icon: "/icon.svg",
        badge: "/icon.svg",
        data: { url: d.url || "/phone" },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/phone";
  e.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of wins) {
        if (w.url.includes("/phone") && "focus" in w) {
          await w.focus();
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
