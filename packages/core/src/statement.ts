import { addDays } from "./cycle";
import { parseMajorToMinor } from "./money";
import { monthNum } from "./statement-dates";

/** Credit-card statement import (spec §3.2): CSV from the bank, or text copied out of the PDF. All amounts are SGD billed. */
export interface StatementRow {
  /** SGT calendar date 'YYYY-MM-DD' */
  date: string;
  description: string;
  /** positive = charge, negative = credit / refund / payment */
  amount_minor: number;
  raw: string;
}

export interface ParsedStatement {
  rows: StatementRow[];
  skipped: string[];
  mode: "csv" | "text";
}

// In running text only a 4-digit year may follow "DD MON": with two year-less dates ("12 SEP 13 SEP ...") a 2-digit year would swallow the second day.
const DATE_TOKEN = String.raw`(?:\d{4}-\d{2}-\d{2}|\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{1,2}\s+[A-Za-z]{3,9}(?:\s+\d{4})?)`;

/** Parse one date cell. Day-first (Singapore). Year-less dates ("12 SEP") take the latest year that doesn't land in the future. */
export function parseStatementDate(s: string, today: string): string | null {
  const t = s.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) return ok(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/.exec(t);
  if (m) return ok(m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!, +m[2]!, +m[1]!);
  m = /^(\d{1,2})\s+([A-Za-z]{3,9})(?:\s+(\d{2,4}))?$/.exec(t);
  if (m) {
    const mo = monthNum(m[2]!);
    if (!mo) return null;
    if (m[3]) return ok(m[3].length === 2 ? 2000 + +m[3] : +m[3], mo, +m[1]!);
    let y = +today.slice(0, 4);
    let d = ok(y, mo, +m[1]!);
    if (d && d > addDays(today, 35)) d = ok(--y, mo, +m[1]!);
    return d;
  }
  return null;
}

function ok(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null; // 31 Feb etc.
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** "1,234.56" "(12.50)" "12.50 CR" "-12.50" "S$ 12.50" -> signed minor units (CR / () / - = credit = negative). null if not an amount. */
export function parseStatementAmount(s: string): number | null {
  let t = s.trim();
  if (!t) return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  if (/\bCR\b/i.test(t)) { neg = !neg; t = t.replace(/\bCR\b/i, ""); }
  t = t.replace(/\bDR\b/i, "");
  if (/^-/.test(t.trim()) || /-$/.test(t.trim())) { neg = !neg; t = t.replace(/-/g, ""); }
  t = t.replace(/[^\d.,]/g, "");
  if (!/\d/.test(t) || !/^\d[\d,]*(\.\d+)?$/.test(t.replace(/^,/, ""))) return null;
  try {
    const v = parseMajorToMinor(t, "SGD");
    return neg ? -v : v;
  } catch {
    return null;
  }
}

function splitCsvLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

const PAYMENT_RE = /payment|thank you|giro|autopay|bill payment|fast payment|paynow|direct debit/i;
export const looksLikePayment = (desc: string) => PAYMENT_RE.test(desc);

export function parseStatement(input: string, today: string): ParsedStatement {
  const lines = input.replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  const csv = tryCsv(lines, today);
  return csv ?? parseText(lines, today);
}

function tryCsv(lines: string[], today: string): ParsedStatement | null {
  const delim = [",", ";", "\t"].map((d) => [d, (lines.slice(0, 15).join("\n").match(new RegExp(d === "\t" ? "\t" : `\\${d}`, "g")) ?? []).length] as const).sort((a, b) => b[1] - a[1])[0]!;
  if (delim[1] < 2) return null;
  const hIdx = lines.findIndex((l) => {
    const c = splitCsvLine(l, delim[0]).map((x) => x.toLowerCase());
    return c.some((x) => /date/.test(x)) && c.some((x) => /desc|merchant|detail|particular|narrat|transaction|payee/.test(x)) && c.some((x) => /amount|debit|credit|withdraw|charge/.test(x));
  });
  if (hIdx < 0) return null;
  const head = splitCsvLine(lines[hIdx]!, delim[0]).map((x) => x.toLowerCase());
  const dateI = head.findIndex((x) => /date/.test(x));
  const descI = head.findIndex((x) => /desc|merchant|detail|particular|narrat|payee|transaction(?!.*date)/.test(x));
  const amtI = head.findIndex((x) => /^amount|amount/.test(x) && !/foreign|orig/.test(x));
  const debI = head.findIndex((x) => /debit|withdraw|charge/.test(x));
  const credI = head.findIndex((x) => /credit|deposit/.test(x));
  const rows: StatementRow[] = [];
  const skipped: string[] = [];
  for (const l of lines.slice(hIdx + 1)) {
    const c = splitCsvLine(l, delim[0]);
    const date = parseStatementDate(c[dateI] ?? "", today);
    let amt: number | null = null;
    if (amtI >= 0) amt = parseStatementAmount(c[amtI] ?? "");
    else {
      const d = debI >= 0 ? parseStatementAmount(c[debI] ?? "") : null;
      const cr = credI >= 0 ? parseStatementAmount(c[credI] ?? "") : null;
      amt = d ? Math.abs(d) : cr ? -Math.abs(cr) : null;
    }
    const desc = (c[descI] ?? "").replace(/\s+/g, " ").trim();
    if (!date || amt === null || amt === 0 || !desc) { skipped.push(l); continue; }
    rows.push({ date, description: desc, amount_minor: amt, raw: l });
  }
  // Single signed "amount" column: banks differ on whether charges are + or -. If most rows are negative, flip them.
  if (amtI >= 0 && rows.length > 0 && rows.filter((r) => r.amount_minor < 0).length / rows.length > 0.6) for (const r of rows) r.amount_minor = -r.amount_minor;
  return { rows, skipped, mode: "csv" };
}

function parseText(lines: string[], today: string): ParsedStatement {
  const re = new RegExp(String.raw`^(${DATE_TOKEN})\s+(?:(${DATE_TOKEN})\s+)?(.+?)\s+(\(?-?[\d,]+\.\d{2}\)?(?:\s*(?:CR|DR))?)$`, "i");
  const rows: StatementRow[] = [];
  const skipped: string[] = [];
  for (const l of lines) {
    const m = re.exec(l);
    const date = m ? parseStatementDate(m[1]!, today) : null;
    const amt = m ? parseStatementAmount(m[4]!) : null;
    const desc = m ? m[3]!.replace(/\s+/g, " ").trim() : "";
    if (!m || !date || amt === null || amt === 0 || !desc) { skipped.push(l); continue; }
    rows.push({ date, description: desc, amount_minor: amt, raw: l });
  }
  return { rows, skipped, mode: "text" };
}
