import { friendlyError } from '@/lib/friendlyError';
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
  const [readError, setReadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [readAttempt, setReadAttempt] = useState(0);
  const [checking, setChecking] = useState(false);
  const [hasFinancialRecords, setHasFinancialRecords] = useState(false);

  // Check for invoices/termination records when dialog opens
  useEffect(() => {
    if (!open) {
      setHasFinancialRecords(false);
      return;
    }

    let active = true;
    const checkRecords = async () => {
      setChecking(true);
      setReadError(null);
      try {
        // Check invoices
        const { data: invoices, error: invoicesError } = await supabase
          .from("invoices")
          .select("id")
          .eq("contract_id", contract.id)
          .limit(1);

        if (!active) return;
        if (invoicesError) throw invoicesError;
        if (!Array.isArray(invoices)) throw new Error("Chưa tải đủ hóa đơn liên quan.");
        if (invoices.length > 0) {
          setHasFinancialRecords(true);
          setChecking(false);
          return;
        }

        // Check termination records
        const { data: terminations, error: terminationsError } = await supabase
          .from("contract_terminations")
          .select("id")
          .eq("contract_id", contract.id)
          .limit(1);

        if (!active) return;
        if (terminationsError) throw terminationsError;
        if (!Array.isArray(terminations)) throw new Error("Chưa tải đủ hồ sơ thanh lý liên quan.");
        if (terminations.length > 0) {
          setHasFinancialRecords(true);
          setChecking(false);
          return;
        }

        setHasFinancialRecords(false);
      } catch (error) {
        if (active) setReadError(friendlyError(error, "Chưa kiểm tra được dữ liệu liên quan", {operation:"kiểm tra hợp đồng trước khi xóa"}).description);
      } finally {
        if (active) setChecking(false);
      }
    };

    void checkRecords();
    return () => { active = false; };
  }, [open, contract.id, readAttempt]);

  const handleDelete = async (event: React.MouseEvent) => {
    event.preventDefault();
    setSaveError(null);
    try {
      await deleteContract.mutateAsync(contract.id);
      onOpenChange(false);
    } catch (error) {
      setSaveError(friendlyError(error, "Chưa xóa được hợp đồng", {operation:"xóa hợp đồng"}).description);
      // Mutation owns its toast
    }
  };

  const contractNumber = contract.contract_number || contract.id.slice(0, 8);
  const canDelete = !checking && !readError && !hasFinancialRecords;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Xác nhận xóa hợp đồng</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              {readError ? <div role="alert" className="text-destructive"><p>Chưa kiểm tra được hóa đơn và hồ sơ thanh lý của hợp đồng này.</p><p>{readError}</p><button type="button" onClick={()=>setReadAttempt(n=>n+1)}>Tải lại</button></div> : checking ? (
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
        {saveError && <p role="alert" className="text-sm text-destructive">{saveError}</p>}
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
