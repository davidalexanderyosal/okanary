/**
 * Sender trust for alert emails (spec §4.2): the From domain must be allow-listed AND an Authentication-Results header
 * must show dkim=pass for a domain aligned with it. Anything else is forwarded to Gmail, never parsed.
 *
 * UNVERIFIED against real traffic: Gmail auto-forwarding normally preserves the bank's DKIM signature, so
 * Cloudflare should report dkim=pass header.d=dbs.com. Confirm with the first real forwarded email (see PROGRESS.md).
 */
export const DEFAULT_SENDER_DOMAINS: Record<string, "dbs" | "citi"> = {
  "dbs.com": "dbs", "dbs.com.sg": "dbs", "posb.com.sg": "dbs",
  "citibank.com.sg": "citi", "citi.com": "citi", "citibank.com": "citi",
};

export function bankForDomain(domain: string, extra?: string): "dbs" | "citi" | null {
  const d = domain.toLowerCase();
  const map: Record<string, "dbs" | "citi"> = { ...DEFAULT_SENDER_DOMAINS };
  // ALERT_SENDER_DOMAINS="example.com:dbs,other.com:citi" lets you add domains without a code change
  for (const pair of (extra ?? "").split(",")) {
    const [dom, bank] = pair.split(":").map((x) => x?.trim().toLowerCase());
    if (dom && (bank === "dbs" || bank === "citi")) map[dom] = bank;
  }
  for (const [dom, bank] of Object.entries(map)) if (d === dom || d.endsWith("." + dom)) return bank;
  return null;
}

const aligned = (a: string, b: string) => a === b || a.endsWith("." + b) || b.endsWith("." + a);

/** True if any Authentication-Results header has dkim=pass with header.d aligned to the From domain. */
export function dkimPass(authResults: string[], fromDomain: string): boolean {
  const from = fromDomain.toLowerCase();
  for (const h of authResults) {
    for (const part of h.split(";")) {
      const m = /dkim\s*=\s*pass\b[^;]*?header\.(?:d|i)\s*=\s*"?@?([^\s;"]+)/i.exec(part);
      if (m && aligned(m[1]!.toLowerCase().replace(/^.*@/, ""), from)) return true;
    }
  }
  return false;
}
