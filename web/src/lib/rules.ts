import { api, type TxnRowData } from "./api";
import { prettyMerchant } from "./format";

type ToastFn = (t: { msg: string; action?: { label: string; run: () => void } }) => void;

/** After the user (re)categorises a transaction that has a merchant: "Always use Transport for GRAB?" -> creates a rule. */
export function offerRule(toast: ToastFn, txn: Pick<TxnRowData, "merchant">, categoryId: string, categoryName: string) {
  if (!txn.merchant) return;
  toast({
    msg: `Always use ${categoryName} for ${prettyMerchant(txn.merchant)}?`,
    action: { label: "Always", run: () => void api.createRule({ pattern: txn.merchant!, category_id: categoryId, match_type: "exact" }).catch(() => undefined) },
  });
}
