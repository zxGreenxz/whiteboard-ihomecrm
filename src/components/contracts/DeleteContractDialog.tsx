import { useState, useEffect } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { AlertTriangle, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useDeleteContract } from "@/hooks/useContracts";
import type { ContractWithRelations } from "@/types/contract";

interface DeleteContractDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contract: ContractWithRelations;
}

export function DeleteContractDialog({
  open,
  onOpenChange,
  contract,
}: DeleteContractDialogProps) {
  const deleteContract = useDeleteContract();
  const [checking, setChecking] = useState(false);
  const [hasFinancialRecords, setHasFinancialRecords] = useState(false);

  // Check for invoices/termination records when dialog opens
  useEffect(() => {
    if (!open) {
      setHasFinancialRecords(false);
      return;
    }

    const checkRecords = async () => {
      setChecking(true);
      try {
        // Check invoices
        const { data: invoices } = await supabase
          .from("invoices")
          .select("id")
          .eq("contract_id", contract.id)
          .limit(1);

        if (invoices && invoices.length > 0) {
          setHasFinancialRecords(true);
          setChecking(false);
          return;
        }

        // Check termination records
        const { data: terminations } = await supabase
          .from("contract_terminations")
          .select("id")
          .eq("contract_id", contract.id)
          .limit(1);

        if (terminations && terminations.length > 0) {
          setHasFinancialRecords(true);
          setChecking(false);
          return;
        }

        setHasFinancialRecords(false);
      } catch {
        setHasFinancialRecords(false);
      } finally {
        setChecking(false);
      }
    };

    checkRecords();
  }, [open, contract.id]);

  const handleDelete = async () => {
    try {
      await deleteContract.mutateAsync(contract.id);
      onOpenChange(false);
    } catch {
      // Error handled by mutation hook
    }
  };

  const contractNumber = contract.contract_number || contract.id.slice(0, 8);
  const canDelete = !checking && !hasFinancialRecords;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Xác nhận xóa hợp đồng</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              {checking ? (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Đang kiểm tra dữ liệu liên quan...</span>
                </div>
              ) : hasFinancialRecords ? (
                <div className="flex items-start gap-2 rounded-md border border-yellow-200 bg-yellow-50 p-3">
                  <AlertTriangle className="h-5 w-5 text-yellow-600 mt-0.5 shrink-0" />
                  <div className="space-y-1">
                    <p className="font-medium text-yellow-800">
                      Không thể xóa hợp đồng này
                    </p>
                    <p className="text-sm text-yellow-700">
                      Hợp đồng <span className="font-semibold">{contractNumber}</span> đã
                      có hoá đơn hoặc bản ghi thanh lý. Vui lòng xóa các bản ghi liên
                      quan trước.
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  <p>
                    Bạn có chắc chắn muốn xóa hợp đồng{" "}
                    <span className="font-semibold">{contractNumber}</span>?
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Hành động này không thể hoàn tác.
                  </p>
                </>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Hủy</AlertDialogCancel>
          {canDelete && (
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleteContract.isPending}
              className="bg-destructive hover:bg-destructive/90"
            >
              {deleteContract.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Đang xóa...
                </>
              ) : (
                "Xóa"
              )}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
