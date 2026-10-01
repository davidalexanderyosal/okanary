import { findRule, type MerchantRule } from "@okanary/core";
import type { AiLike } from "./deps";

export interface Categorisation {
  category_id: string | null;
  source: "rule" | "history" | "ai" | null;
  set_excluded: boolean;
  rule_id?: string;
}

/** Spec §4.4 order: merchant rule -> history -> LLM suggestion -> uncategorised. */
export async function categorise(db: D1Database, ai: AiLike | undefined, merchantNorm: string): Promise<Categorisation> {
  if (!merchantNorm) return { category_id: null, source: null, set_excluded: false };

  const rules = (await db.prepare("SELECT id, match_type, pattern, category_id, set_excluded, priority FROM merchant_rules").all<MerchantRule>()).results;
  const rule = findRule(rules, merchantNorm);
  if (rule) {
    await db.prepare("UPDATE merchant_rules SET hits = hits + 1 WHERE id = ?").bind(rule.id).run();
    return { category_id: rule.category_id, source: "rule", set_excluded: !!rule.set_excluded, rule_id: rule.id };
  }

  const hist = await db
    .prepare(
      `SELECT category_id FROM transactions WHERE merchant = ? AND category_id IS NOT NULL AND category_source IN ('user','rule','history') AND status != 'void'
       ORDER BY occurred_at DESC LIMIT 1`,
    )
    .bind(merchantNorm)
    .first<{ category_id: string }>();
  if (hist) return { category_id: hist.category_id, source: "history", set_excluded: false };

  if (ai) {
    const id = await suggestWithAi(db, ai, merchantNorm);
    if (id) return { category_id: id, source: "ai", set_excluded: false };
  }
  return { category_id: null, source: null, set_excluded: false };
}

export const AI_MODEL = "@cf/meta/llama-3.1-8b-instruct";

async function suggestWithAi(db: D1Database, ai: AiLike, merchant: string): Promise<string | null> {
  const cats = (
    await db
      .prepare("SELECT c.id, c.name, g.name AS grp FROM categories c JOIN category_groups g ON g.id = c.group_id WHERE c.archived = 0 AND g.id NOT IN ('income','transfers')")
      .all<{ id: string; name: string; grp: string }>()
  ).results;
  const list = cats.map((c) => `${c.id}: ${c.name} (${c.grp})`).join("\n");
  try {
    const out = (await Promise.race([
      ai.run(AI_MODEL, {
        messages: [
          { role: "system", content: 'You categorise Singapore card transactions. Reply ONLY with JSON like {"category_id":"<id>"} choosing exactly one id from the list, or {"category_id":null} if unsure.' },
          { role: "user", content: `Merchant: ${merchant}\nCategories:\n${list}` },
        ],
        max_tokens: 40,
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("ai timeout")), 5000)),
    ])) as { response?: string } | string;
    const text = typeof out === "string" ? out : (out?.response ?? "");
    const m = /\{[^}]*\}/.exec(text);
    if (!m) return null;
    const id = (JSON.parse(m[0]) as { category_id?: string | null }).category_id;
    return id && cats.some((c) => c.id === id) ? id : null;
  } catch {
    return null; // AI is best-effort; never block capture
  }
}
