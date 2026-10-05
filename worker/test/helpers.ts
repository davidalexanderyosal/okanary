import { env } from "cloudflare:test";
import { createApp } from "../src/app";
import type { Deps } from "../src/deps";
import type { Env } from "../src/env";

export const NOW = new Date("2026-10-14T04:00:00Z"); // 12:00 SGT, day 14 of 31

const b64u = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));

export async function genVapid() {
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey;
  const raw = new Uint8Array(65);
  raw[0] = 4;
  raw.set(unb64u(jwk.x!), 1);
  raw.set(unb64u(jwk.y!), 33);
  return { pub: b64u(raw), priv: jwk.d! };
}

export async function clientSubscription(endpoint = "https://push.example.com/send/abc") {
  const kp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const pub = new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
  return { endpoint, keys: { p256dh: b64u(pub), auth: b64u(crypto.getRandomValues(new Uint8Array(16))) } };
}

export const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });

export interface PushCall { url: string; headers: Record<string, string>; body: Uint8Array }

/** An app + env wired with a fake network that records Web Push deliveries and answers Frankfurter lookups. */
export function harness(opts: {
  vapid?: { pub: string; priv: string }; rates?: Record<string, number>; now?: Date;
  /** Consulted first for every fetch; return a Response to answer it, or undefined to fall through to the built-in fakes. */
  onFetch?: (url: string, init?: RequestInit) => Response | undefined | Promise<Response | undefined>;
} = {}) {
  const pushes: PushCall[] = [];
  const fxCalls: string[] = [];
  const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    const custom = await opts.onFetch?.(u, init);
    if (custom) return custom;
    if (u.includes("frankfurter")) {
      fxCalls.push(u);
      const base = /base=([A-Z]{3})/.exec(u)![1]!;
      const rate = opts.rates?.[base];
      return rate ? Response.json({ rates: { SGD: rate } }) : new Response("no", { status: 404 });
    }
    pushes.push({ url: u, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body as Uint8Array });
    return new Response("{}", { status: 201 });
  }) as typeof fetch;
  let now = opts.now ?? NOW;
  const deps: Deps = { now: () => now, fetch: fetchFn };
  const e = { ...env, INGEST_TOKEN: "tok", ...(opts.vapid ? { VAPID_SUBJECT: "mailto:me@example.com", VAPID_PUBLIC_KEY: opts.vapid.pub, VAPID_PRIVATE_KEY: opts.vapid.priv } : {}) } as unknown as Env;
  const app = createApp(deps);
  const call = (path: string, init?: RequestInit) => Promise.resolve(app.request(path, init, e));
  /** Move the clock (deps.now() of the app, cron and jobs all follow). */
  const setNow = (d: Date) => { now = d; };
  return { call, e, deps, pushes, fxCalls, setNow };
}

export const count = async (sql: string) => (await env.DB.prepare(sql).first<{ n: number }>())!.n;

export async function resetDb() {
  await env.DB.exec("DELETE FROM income_events; DELETE FROM lifestyle_bonus; DELETE FROM plans; DELETE FROM income_settings;");
  await env.DB.exec("DELETE FROM wants;");
  await env.DB.exec("DELETE FROM goal_contributions; DELETE FROM goal_snapshots; DELETE FROM goal_funding; DELETE FROM goals;");
  await env.DB.exec("DELETE FROM card_statement_paid; DELETE FROM holdings; DELETE FROM nw_balances; DELETE FROM nw_accounts; DELETE FROM price_quotes; DELETE FROM networth_snapshots;");
  await env.DB.exec(
    "DELETE FROM duplicate_candidates; DELETE FROM raw_ingest; DELETE FROM transactions; DELETE FROM subscription_events; DELETE FROM subscriptions; DELETE FROM merchant_rules; DELETE FROM accounts; DELETE FROM alert_log; DELETE FROM push_subscriptions; DELETE FROM fx_rates; DELETE FROM budgets; DELETE FROM trips; DELETE FROM push_outbox;",
  );
  await env.DB.exec("DELETE FROM settings WHERE key NOT IN ('base_currency','timezone')");
}
