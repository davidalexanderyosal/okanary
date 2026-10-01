import { cleanMerchant, monthNum, sgtWallToUtc, toMinor, type ParsedAlert } from "./common";

/**
 * Citi Singapore card alert parser.
 *
 * UNVERIFIED: spec §2/§10.3 says it is not even confirmed that Citi sends per-transaction EMAIL alerts. These two layouts
 * (a sentence and a labeled block) are guesses, tested only against invented fixtures (worker/fixtures/synthetic-citi-*.txt).
 * If Citi sends no email, this parser is simply never exercised and Citi spend relies on manual add + statement import.
 */
export function parseCiti(text: string, receivedAt: string): ParsedAlert | null {
  return parseSentence(text, receivedAt) ?? parseLabeled(text, receivedAt);
}

function parseSentence(text: string, receivedAt: string): ParsedAlert | null {
  const m = /transaction of\s+([A-Z]{3})\s*([\d][\d.,]*)\s+was made with your\s+(?:[\w/ ]*?)card ending\s+(\d{4})\s+on\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+at\s+(\d{1,2}):(\d{2})\s+at\s+(.+?)\s*$/im.exec(text);
  if (!m) return null;
  const minor = toMinor(m[1]!, m[2]!);
  if (!minor) return null;
  const year = m[6]!.length === 2 ? 2000 + +m[6]! : +m[6]!;
  return {
    amount_minor: minor, currency: m[1]!, merchant: cleanMerchant(m[9]!), card_last4: m[3]!,
    occurred_at: sgtWallToUtc(+m[4]!, +m[5]!, year, +m[7]!, +m[8]!, receivedAt),
  };
}

function parseLabeled(text: string, receivedAt: string): ParsedAlert | null {
  const amt = /^\s*Amount\s*:\s*([A-Z]{3})\s*([\d][\d.,]*)/im.exec(text);
  const merchant = /^\s*Merchant\s*:\s*(.+?)\s*$/im.exec(text);
  const date = /^\s*Date\s*:\s*(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})[,\s]+(\d{1,2}):(\d{2})/im.exec(text);
  const card = /ending\s+(\d{4})/i.exec(text);
  if (!amt || !merchant || !date) return null;
  const month = monthNum(date[2]!);
  const minor = toMinor(amt[1]!, amt[2]!);
  if (!month || !minor) return null;
  return {
    amount_minor: minor, currency: amt[1]!, merchant: cleanMerchant(merchant[1]!), card_last4: card?.[1] ?? null,
    occurred_at: sgtWallToUtc(+date[1]!, month, +date[3]!, +date[4]!, +date[5]!, receivedAt),
  };
}
