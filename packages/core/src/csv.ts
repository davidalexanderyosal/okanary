/**
 * CSV encoding for the export (spec §3.2: data ownership). RFC 4180 quoting plus a guard against spreadsheet formula
 * injection: a cell that starts with = + - @ (or tab/CR) is prefixed with an apostrophe so Excel/Sheets show it as text.
 * Pure-number cells keep their sign (numbers are passed as numbers, not strings, so "-12.50" amounts aren't mangled).
 */
export type CsvCell = string | number | null | undefined;

export function csvCell(v: CsvCell): string {
  if (v === null || v === undefined) return "";
  let s = typeof v === "number" ? String(v) : v;
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: CsvCell[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
