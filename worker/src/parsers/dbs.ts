import { cleanMerchant, monthNum, sgtWallToUtc, toMinor, type ParsedAlert } from "./common";

/**
 * DBS/POSB card alert parser.
 *
 * UNVERIFIED: written from the commonly seen "Date & Time / Amount / From / To" digibank layout and a sentence variant,
 * tested ONLY against invented fixtures (worker/fixtures/synthetic-dbs-*.txt). No real DBS email has been available.
 * Replace/extend with real redacted samples in worker/fixtures/ (spec §10.1) before trusting it; until then the LLM fallback
 * and the Review inbox catch anything it misses.
 */
export function parseDbs(text: string, receivedAt: string): ParsedAlert | null {
  return parseLabeled(text, receivedAt) ?? parseSentence(text, receivedAt);
}

function parseLabeled(text: string, receivedAt: string): ParsedAlert | null {
  const amt = /^\s*Amount\s*:\s*([A-Z]{3})\s*([\d][\d.,]*)/im.exec(text);
  const dt = /Date\s*(?:&|and)\s*Time\s*:\s*(\d{1,2})\s+([A-Za-z]{3,9})(?:\s+(\d{4}))?[,\s]+(\d{1,2}):(\d{2})/i.exec(text);
  const to = /^\s*To\s*:\s*(.+?)\s*$/im.exec(text);
  const card = /card\s+ending\s+(\d{4})/i.exec(text);
  if (!amt || !dt || !to) return null;
  const month = monthNum(dt[2]!);
  const minor = toMinor(amt[1]!, amt[2]!);
  if (!month || !minor) return null;
  return {
    amount_minor: minor, currency: amt[1]!, merchant: cleanMerchant(to[1]!), card_last4: card?.[1] ?? null,
    occurred_at: sgtWallToUtc(+dt[1]!, month, dt[3] ? +dt[3] : undefined, +dt[4]!, +dt[5]!, receivedAt),
  };
}

function parseSentence(text: string, receivedAt: string): ParsedAlert | null {
  const m = /transaction of\s+([A-Z]{3})\s*([\d][\d.,]*)\s+was made with your\s+(?:[\w/ ]*?)card ending\s+(\d{4})\s+on\s+(\d{1,2})\s+([A-Za-z]{3,9})(?:\s+(\d{4}))?[,\s]+(\d{1,2}):(\d{2})(?:\s*\(?SGT\)?)?\s+at\s+(.+?)\s*$/im.exec(text);
  if (!m) return null;
  const month = monthNum(m[5]!);
  const minor = toMinor(m[1]!, m[2]!);
  if (!month || !minor) return null;
  return {
    amount_minor: minor, currency: m[1]!, merchant: cleanMerchant(m[9]!), card_last4: m[3]!,
    occurred_at: sgtWallToUtc(+m[4]!, month, m[6] ? +m[6] : undefined, +m[7]!, +m[8]!, receivedAt),
  };
}
