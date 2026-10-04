import { sgtDate } from "@okanary/core";
import type { AiLike } from "../deps";
import { AI_MODEL } from "../categorise";
import { cleanMerchant, cycleFromRenewal, toMinor } from "./common";

/** A service receipt (Netflix, Spotify, Google Play...) read by the LLM: always reviewed by David, never trusted blindly. */
export interface ExtractedReceipt {
  service: string;
  amount_minor: number;
  currency: string;
  /** SGT date 'YYYY-MM-DD' of the charge. */
  date: string;
  /** Next renewal 'YYYY-MM-DD' when the mail states one. */
  renews: string | null;
  cycle: "monthly" | "yearly" | null;
}

const isoDate = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim());
  if (!m) return null;
  const t = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!);
  return new Date(t).getUTCDate() === +m[3]! ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

/**
 * LLM extraction for receipt mails with no regex parser (v2 S). The model's output is untrusted (same rules as ai.ts): every
 * field is validated and anything odd returns null (-> failed raw_ingest). The date must be within 45 days of when the mail
 * arrived (else the arrival day is used) and a renewal must fall 1 day to 400 days after it (else dropped).
 */
export async function extractReceiptWithAi(ai: AiLike | undefined, text: string, receivedAt: string): Promise<ExtractedReceipt | null> {
  if (!ai) return null;
  try {
    const out = (await Promise.race([
      ai.run(AI_MODEL, {
        messages: [
          { role: "system", content: 'Extract the subscription or service charge from this receipt email. Reply ONLY with JSON: {"service":"Netflix","amount":"19.98","currency":"SGD","date":"2026-10-05","renews":"2026-11-05"}. Use null for anything not stated (renews is the next billing date). Never invent values.' },
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
    const service = typeof j.service === "string" ? cleanMerchant(j.service).slice(0, 80) : "";
    const currency = typeof j.currency === "string" && /^[A-Za-z]{3}$/.test(j.currency) ? j.currency.toUpperCase() : null;
    const amount = typeof j.amount === "string" || typeof j.amount === "number" ? String(j.amount) : null;
    if (!service || !currency || !amount) return null;
    const minor = toMinor(currency, amount);
    if (!minor) return null;

    const arrival = sgtDate(receivedAt);
    const stated = isoDate(j.date);
    const date = stated && Math.abs(Date.parse(stated) - Date.parse(arrival)) <= 45 * 86400_000 ? stated : arrival;
    const r = isoDate(j.renews);
    const gap = r ? (Date.parse(r) - Date.parse(date)) / 86400_000 : NaN;
    const renews = r && gap >= 1 && gap <= 400 ? r : null;
    return { service, amount_minor: minor, currency, date, renews, cycle: renews ? cycleFromRenewal(date, renews) : null };
  } catch {
    return null;
  }
}
