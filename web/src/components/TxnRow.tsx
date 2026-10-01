import { formatMoney } from "@okanary/core";
import type { Account, Category } from "@okanary/core";
import type { TxnRowData } from "../lib/api";
import { timeLabel } from "../lib/format";
import { groupColor } from "./groups";

export function TxnRow({ t, categories, accounts, onClick }: { t: TxnRowData; categories: Map<string, Category>; accounts: Map<string, Account>; onClick: () => void }) {
  const cat = t.category_id ? categories.get(t.category_id) : undefined;
  const acct = t.account_id ? accounts.get(t.account_id) : undefined;
  const refund = !!t.is_refund;
  const dim = !!t.is_excluded || !!t.is_reimbursable || t.status === "void";
  const title = t.merchant || cat?.name || "Expense";
  const sub = [t.merchant ? (cat?.name ?? "Uncategorised") : null, acct?.name, timeLabel(t.occurred_at)].filter(Boolean).join(" · ");
  return (
    <button onClick={onClick} className="tap flex w-full items-center gap-3 px-4 py-2.5 text-left active:bg-line/50">
      <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: groupColor(t.group_id), opacity: t.status === "pending" ? 0.5 : 1, outline: t.status === "pending" ? "1.5px dotted var(--muted)" : undefined, outlineOffset: 2 }} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-medium">{title}</span>
        <span className="block truncate text-xs text-muted">
          {sub}
          {t.is_excluded ? " · excluded" : ""}
          {t.is_reimbursable ? " · reimbursable" : ""}
          {t.status === "pending" ? " · pending" : ""}
        </span>
      </span>
      <span className={`num text-[15px] font-semibold ${refund ? "text-savings" : ""} ${dim ? "line-through opacity-50" : ""}`}>
        {refund ? "+" : ""}
        {formatMoney(t.amount_minor, t.currency)}
      </span>
    </button>
  );
}
