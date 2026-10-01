import type { AiLike } from "../deps";
import { AI_MODEL } from "../categorise";
import { cleanMerchant, toMinor, type ParsedAlert } from "./common";

/**
 * LLM fallback when the regex parser finds nothing (spec §4.2). The result is always saved as needs_review.
 * The model's output is untrusted: every field is validated, and anything odd returns null (-> failed raw_ingest).
 */
export async function extractWithAi(ai: AiLike | undefined, text: string, receivedAt: string): Promise<ParsedAlert | null> {
  if (!ai) return null;
  try {
    const out = (await Promise.race([
      ai.run(AI_MODEL, {
        messages: [
          { role: "system", content: 'Extract the card transaction from this bank alert email. Reply ONLY with JSON: {"amount":"12.50","currency":"SGD","merchant":"NAME","card_last4":"1234","datetime":"2026-10-14T12:10:00+08:00"}. Use null for anything not stated. Never invent values.' },
          { role: "user", content: text.slice(0, 4000) },
        ],
        max_tokens: 200,
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("ai timeout")), 8000)),
    ])) as { response?: string } | string;
    const body = typeof out === "string" ? out : (out?.response ?? "");
    const m = /\{[\s\S]*\}/.exec(body);
    if (!m) return null;
    const j = JSON.parse(m[0]) as Record<string, unknown>;
    const currency = typeof j.currency === "string" && /^[A-Za-z]{3}$/.test(j.currency) ? j.currency.toUpperCase() : null;
    const amount = typeof j.amount === "string" || typeof j.amount === "number" ? String(j.amount) : null;
    const merchant = typeof j.merchant === "string" ? cleanMerchant(j.merchant) : "";
    if (!currency || !amount || !merchant) return null;
    const minor = toMinor(currency, amount);
    if (!minor) return null;
    const when = typeof j.datetime === "string" ? Date.parse(j.datetime) : NaN;
    const occurred = !Number.isNaN(when) && Math.abs(when - Date.parse(receivedAt)) < 3 * 86400_000 ? new Date(when).toISOString() : receivedAt;
    const last4 = typeof j.card_last4 === "string" && /^\d{4}$/.test(j.card_last4) ? j.card_last4 : null;
    return { amount_minor: minor, currency, merchant, card_last4: last4, occurred_at: occurred };
  } catch {
    return null;
  }
}
