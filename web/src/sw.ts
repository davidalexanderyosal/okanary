/// <reference lib="webworker" />
import { clientsClaim } from "workbox-core";
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { actionHandled, actionRequest, notificationActions } from "./lib/pushActions";

declare const self: ServiceWorkerGlobalScope;

self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);
// App shell for navigations; the API is never served from cache.
registerRoute(new NavigationRoute(createHandlerBoundToURL("/index.html"), { denylist: [/^\/api\//] }));

interface PushData { title?: string; body?: string; url?: string; tag?: string; pledge?: string; actions?: string }

self.addEventListener("push", (event) => {
  let d: PushData = {};
  try { d = event.data?.json() ?? {}; } catch { d = { body: event.data?.text() }; }
  // Goal pledges carry `actions` ("transfer,skip") + `pledge`: Transferred / Skip buttons on the notification.
  const actions = notificationActions(d.actions, d.pledge);
  // `actions` is valid for persistent notifications but missing from the WebWorker lib's NotificationOptions.
  const options: NotificationOptions & { actions?: unknown[] } = {
    body: d.body, tag: d.tag, icon: "/icon-192.png", badge: "/icon-192.png", data: { url: d.url ?? "/", pledge: d.pledge },
    ...(actions.length > 0 ? { actions } : {}),
  };
  event.waitUntil(self.registration.showNotification(d.title ?? "Okanary", options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = (event.notification.data ?? {}) as { url?: string; pledge?: string };
  const url = new URL(data.url ?? "/", self.location.origin).href;
  // An action button resolves the pledge right here (same origin, session cookie); a body click opens the app as before.
  const call = actionRequest(event.action, data.pledge);
  event.waitUntil(
    (async () => {
      if (call) {
        try {
          const res = await fetch(call.path, { method: call.method, credentials: "include", headers: { "content-type": "application/json" } });
          if (actionHandled(res.status)) return;
        } catch { /* offline: fall through and open the app so the pledge can be handled there */ }
      }
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of wins) {
        if ("focus" in w) {
          await w.focus();
          if ("navigate" in w) await (w as WindowClient).navigate(url);
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
