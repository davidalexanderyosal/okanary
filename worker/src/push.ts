import { buildPushPayload } from "@block65/webcrypto-web-push";
import type { Deps } from "./deps";
import type { Env } from "./env";

/**
 * `pledge` / `actions` are optional and carried in the push data as-is (the whole payload is the data): a goal pledge id and a
 * comma-separated list of action ids ("transfer,skip") the service worker can offer as notification buttons.
 */
export interface PushPayload { title: string; body: string; url?: string; tag?: string; pledge?: string; actions?: string }

export const pushConfigured = (env: Env) => !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);

/** Send to every stored subscription; prune ones the push service says are gone (404/410). Never throws. Returns count delivered. */
export async function sendPushToAll(env: Env, deps: Deps, payload: PushPayload): Promise<number> {
  if (!pushConfigured(env)) return 0;
  const subs = (await env.DB.prepare("SELECT id, endpoint, keys FROM push_subscriptions").all<{ id: string; endpoint: string; keys: string }>()).results;
  let delivered = 0;
  for (const s of subs) {
    try {
      const keys = JSON.parse(s.keys) as { p256dh: string; auth: string };
      const req = await buildPushPayload(
        { data: payload as unknown as Record<string, string>, options: { ttl: 3600, urgency: "normal" } },
        { endpoint: s.endpoint, expirationTime: null, keys },
        { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY },
      );
      const res = await deps.fetch(s.endpoint, { method: req.method, headers: req.headers, body: req.body });
      if (res.status === 404 || res.status === 410) await env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(s.id).run();
      else if (res.ok) delivered++;
    } catch {
      /* one bad subscription must not block the rest */
    }
  }
  return delivered;
}
