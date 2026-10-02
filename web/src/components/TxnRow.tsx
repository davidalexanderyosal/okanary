import { formatMoney } from "@okanary/core";
import type { Account, Category } from "@okanary/core";
import type { TxnRowData } from "../lib/api";
import { prettyMerchant, timeLabel } from "../lib/format";
import { Icon, groupTint } from "./Icons";

export function TxnRow({ t, categories, accounts, onClick }: { t: TxnRowData; categories: Map<string, Category>; accounts: Map<string, Account>; onClick: () => void }) {
  const cat = t.category_id ? categories.get(t.category_id) : undefined;
  const acct = t.account_id ? accounts.get(t.account_id) : undefined;
  const refund = !!t.is_refund;
  const dim = !!t.is_excluded || !!t.is_reimbursable || t.status === "void";
  const title = prettyMerchant(t.merchant) || cat?.name || "Expense";
  const sub = [t.merchant ? (cat?.name ?? "Uncategorised") : null, acct?.name, timeLabel(t.occurred_at)].filter(Boolean).join(" · ");
  return (
    <button onClick={onClick} className="tap flex w-full items-center gap-3 border-t-2 border-dashed border-line px-4 py-2.5 text-left first:border-t-0 active:bg-line/50">
      <span
        className="grid h-9 w-9 shrink-0 place-items-center rounded-full"
        style={{ background: groupTint(t.group_id).bg, color: groupTint(t.group_id).fg, outline: t.status === "pending" ? "1.5px dashed currentColor" : undefined, outlineOffset: 2 }}
      >
        <Icon name={t.group_id ?? "uncategorised"} className="h-[18px] w-[18px]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-bold">{title}</span>
        <span className="block truncate text-xs text-muted">
          {sub}
          {t.is_excluded ? " · excluded" : ""}
          {t.is_reimbursable ? " · reimbursable" : ""}
          {t.status === "pending" ? " · pending" : ""}
          {t.category_source === "ai" ? " · suggested" : ""}
        </span>
      </span>
      <span className={`num text-[15px] font-semibold ${refund ? "text-good" : ""} ${dim ? "line-through opacity-50" : ""}`}>
        {refund ? "+" : ""}
        {formatMoney(t.amount_minor, t.currency)}
      </span>
    </button>
  );
}
