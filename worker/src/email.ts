import PostalMime from "postal-mime";
import type { Transaction } from "@okanary/core";
import { runAlertsInBackground } from "./alerts";
import { captureTransaction, pushPurchaseNudge } from "./capture";
import type { Deps } from "./deps";
import { bankForDomain, dkimPass } from "./email-auth";
import type { Env } from "./env";
import { extractWithAi } from "./parsers/ai";
import { htmlToText, type ParsedAlert } from "./parsers/common";
import { parseAlert } from "./parsers";
import { ulid } from "./util";

/** The subset of Cloudflare's ForwardableEmailMessage we use (keeps tests simple). */
export interface InboundEmail {
  raw: ReadableStream<Uint8Array>;
  rawSize: number;
  forward(to: string, headers?: Headers): Promise<void>;
}

export type EmailOutcome =
  | { action: "forwarded"; reason: "not-an-alert" | "untrusted" | "too-large" | "error" }
  | { action: "duplicate" }
  | { action: "captured"; transactionId: string; merged: boolean; status: Transaction["status"]; via: "regex" | "ai" }
  | { action: "failed"; error: string };

const MAX_BYTES = 2 * 1024 * 1024;

async function forwardToOwner(env: Env, message: InboundEmail): Promise<void> {
  if (!env.FORWARD_TO) return;
  try { await message.forward(env.FORWARD_TO); } catch { /* destination unverified etc.: nothing more we can do */ }
}

async function matchAccountByLast4(db: D1Database, last4: string | null, bank: string): Promise<string | null> {
  if (!last4) return null;
  const rows = (await db.prepare("SELECT id, bank FROM accounts WHERE last4 = ? AND archived = 0").bind(last4).all<{ id: string; bank: string | null }>()).results;
  return (rows.find((r) => r.bank?.toLowerCase().includes(bank)) ?? rows[0])?.id ?? null;
}

/**
 * Cloudflare Email Routing entry point (spec §4.2). Never logs bodies. Unexpected errors forward the mail to the owner
 * so nothing is silently lost.
 */
export async function handleEmail(message: InboundEmail, env: Env, deps: Deps, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<EmailOutcome> {
  try {
    if (message.rawSize > MAX_BYTES) {
      await forwardToOwner(env, message);
      return { action: "forwarded", reason: "too-large" };
    }
    const buf = await new Response(message.raw).arrayBuffer();
    const mail = await PostalMime.parse(buf);
    const fromDomain = (mail.from?.address ?? "").split("@")[1]?.toLowerCase() ?? "";
    const bank = bankForDomain(fromDomain, env.ALERT_SENDER_DOMAINS);

    if (!bank) {
      await forwardToOwner(env, message); // e.g. Gmail's forwarding-verification mail
      return { action: "forwarded", reason: "not-an-alert" };
    }
    const auth = (mail.headers ?? []).filter((h) => h.key.toLowerCase() === "authentication-results").map((h) => h.value);
    if (!dkimPass(auth, fromDomain)) {
      await forwardToOwner(env, message);
      return { action: "forwarded", reason: "untrusted" };
    }

    const receivedAt = deps.now().toISOString();
    const text = (mail.text?.trim() || htmlToText(mail.html ?? "")).slice(0, 20000);
    const sentAt = mail.date && !Number.isNaN(Date.parse(mail.date)) ? new Date(mail.date).toISOString() : receivedAt;
    const messageId = mail.messageId ?? "";
    const header = `${messageId ? `Message-ID: ${messageId}\n` : ""}Subject: ${mail.subject ?? ""}\n\n`;

    if (messageId) {
      // NB: D1 rejects LIKE patterns over 50 bytes, so compare the stored prefix exactly instead.
      const prefix = `Message-ID: ${messageId}\n`;
      const seen = await env.DB.prepare("SELECT 1 AS x FROM raw_ingest WHERE source LIKE 'email:%' AND substr(payload, 1, length(?1)) = ?1 LIMIT 1").bind(prefix).first();
      if (seen) return { action: "duplicate" }; // Gmail retried / forwarded twice
    }

    const rawId = ulid();
    await env.DB.prepare("INSERT INTO raw_ingest (id, source, received_at, payload, parse_status) VALUES (?,?,?,?,?)")
      .bind(rawId, `email:${bank}`, receivedAt, header + text, "received").run();

    let parsed: ParsedAlert | null = parseAlert(bank, text, sentAt);
    let via: "regex" | "ai" = "regex";
    if (!parsed) {
      parsed = await extractWithAi(deps.ai, text, sentAt);
      via = "ai";
    }
    if (!parsed) {
      await env.DB.prepare("UPDATE raw_ingest SET parse_status = 'failed', error = ? WHERE id = ?").bind("no parser matched and AI fallback found nothing", rawId).run();
      return { action: "failed", error: "unparseable" };
    }

    const res = await captureTransaction(env, deps, {
      source: "email", occurred_at: parsed.occurred_at, amount_minor: parsed.amount_minor, currency: parsed.currency,
      amount_sgd_minor: parsed.sgd_minor, merchant_raw: parsed.merchant,
      account_id: await matchAccountByLast4(env.DB, parsed.card_last4, bank),
      status: via === "ai" ? "needs_review" : "confirmed", raw_id: rawId,
    });
    if (!res.merged) {
      const push = pushPurchaseNudge(env, deps, res.txn).catch(() => undefined);
      if (ctx) ctx.waitUntil(push); else await push;
    }
    await runAlertsInBackground(env, deps, ctx);
    return { action: "captured", transactionId: res.txn.id, merged: res.merged, status: res.txn.status, via };
  } catch (err) {
    console.error("email handler error", err instanceof Error ? err.message : String(err)); // message only: never bodies/headers
    await forwardToOwner(env, message);
    return { action: "forwarded", reason: "error" };
  }
}
