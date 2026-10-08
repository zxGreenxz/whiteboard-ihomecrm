import { expect, it } from "vitest";
import { transactionInput } from "@/lib/personalFinance/transactionInput";
import { resolvePersonalDraft } from "@/lib/quickEntry/personalRefs";
import type { Snapshot } from "@/lib/personalFinance/contract";
import type { QuickDraft } from "@/lib/quickEntry/draft";
it("explicitly selected hidden wallets remain usable but are not automatic defaults", () => {
  const snapshot = {
    wallets: [{ id: "hidden", hidden: true, is_default: true }],
    categories: [{ id: "food", type: "EXPENSE", hidden: false }],
  } as Snapshot;
  expect(
    transactionInput(
      {
        type: "EXPENSE",
        amount: 100,
        wallet_id: "hidden",
        category_id: "food",
      },
      snapshot,
    ),
  ).toMatchObject({ wallet_id: "hidden" });
  expect(
    resolvePersonalDraft(
      { mode: "personal", lines: [] } as unknown as QuickDraft,
      snapshot.wallets,
      [],
    ).personalWalletId,
  ).toBeNull();
});
