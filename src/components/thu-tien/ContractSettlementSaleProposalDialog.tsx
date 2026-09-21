import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { SettlementSelection } from "@/lib/contractSettlement";
import type { CreatableSettlementSourceRef } from "@/lib/contractSettlementCreate";
import { ContractSettlementCreateForm } from "./ContractSettlementCreateForm";
import { ContractSettlementSaleProposalSelector } from "./ContractSettlementSaleProposalSelector";

type SaleSource = Extract<
  CreatableSettlementSourceRef,
  { kind: "sale_contract" | "sale_deposit" }
>;

interface Props {
  organizationId: string;
  disabled: boolean;
  refreshRequired: () => Promise<void>;
  onSelect: (selection: SettlementSelection) => void;
}

/** Explicit proposal flow: selecting a source does not create an obligation. */
export function ContractSettlementSaleProposalDialog({
  organizationId,
  disabled,
  refreshRequired,
  onSelect,
}: Props) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<SaleSource | null>(null);
  const [blocked, setBlocked] = useState(false);
  const close = () => {
    if (blocked) return;
    setOpen(false);
    setSource(null);
  };
  return (
    <>
      <button
        type="button"
        className="cs-button cs-button-primary"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        Đề xuất thưởng sale
      </button>
      <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
        <DialogContent className="contract-settlement max-h-[calc(100dvh-40px)] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Đề xuất thưởng sale</DialogTitle>
            <DialogDescription>
              Chọn đúng nguồn phát sinh, rà soát căn cứ rồi lập phiếu chờ duyệt.
            </DialogDescription>
          </DialogHeader>
          {source ? (
            <div className="space-y-4">
              <Button type="button" variant="outline" disabled={blocked} onClick={() => setSource(null)}>
                Chọn nguồn khác
              </Button>
              <ContractSettlementCreateForm
                sourceRef={source}
                refreshRequired={refreshRequired}
                onBusyChange={setBlocked}
                onCreated={(result) => {
                  setBlocked(false);
                  setOpen(false);
                  setSource(null);
                  onSelect({ kind: "voucher", voucherId: result.voucherId });
                }}
              />
            </div>
          ) : (
            <ContractSettlementSaleProposalSelector
              organizationId={organizationId}
              onSelectSource={setSource}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

export default ContractSettlementSaleProposalDialog;
