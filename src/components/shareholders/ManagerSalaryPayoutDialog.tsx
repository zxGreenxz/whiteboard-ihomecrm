// Hộp "Chi lương điều hành" theo sổ lương điều hành (E10): được nhận − đã trả − chờ duyệt = còn lại.
// Không cho chi quá số còn lại ở MỌI trạng thái sổ tổng (khi sổ tổng chưa chạy thật máy chủ chưa chặn,
// nên chặn ở đây), không có tạm ứng. Sổ tổng đóng băng ⇒ tạm khoá chi. Sổ quỹ: chỉ sổ tiền thật của
// đúng công ty (máy chủ cũng từ chối sổ ảo / sổ công ty khác).
import { validateInputDrafts } from "@/lib/inputDraftValidation";
import { QueryRegion } from "@/components/errors/QueryRegion";
import { focusFirstError } from "@/lib/formErrors";
import { useEffect, useMemo, useRef, useState } from "react";
import { Info } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CurrencyInput } from "@/components/ui/currency-input";
import { DateInput } from "@/components/ui/date-input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useAccounts } from "@/hooks/useAccounts";
import { useCreateManagerSalaryPayout } from "@/hooks/useIncomeExpenses";
import { profitLedgerErrorMessage } from "@/lib/profitLedger/errors";
import type { ManagerLedger } from "@/lib/profitLedger/ledgerReaders";
import { profitPayoutAccounts } from "@/lib/profitLedger/payoutAccounts";
import { profitLedgerRouteState } from "@/lib/profitLedger/route";
import { formatVND } from "@/lib/utils";
import { format } from "date-fns";

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Công ty của sổ lương điều hành — sổ quỹ chi lọc theo công ty này. */
  organizationId: string | null;
  /** Sổ lương điều hành (E10): người nhận + số còn lại. Chưa tải ⇒ chưa chi được. */
  ledger: ManagerLedger | undefined;
  defaultManagerId?: string | null;
}

/** Luật duyệt của phiếu lương điều hành theo sổ tổng (chốt chặn F1) — báo trước khi lập. */
export const MANAGER_PAYOUT_APPROVAL_NOTE =
  "Người duyệt phải khác người lập phiếu và khác người nhận. Người nhận là một tài khoản chủ thì chính người đó phải lập phiếu để chủ còn lại duyệt.";

export default function ManagerSalaryPayoutDialog({
  open,
  onOpenChange,
  organizationId,
  ledger,
  defaultManagerId,
}: Props) {
  const accountsQuery = useAccounts();
  const { data: accounts = [] } = accountsQuery;
  const createMut = useCreateManagerSalaryPayout();

  const [managerId, setManagerId] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState('');
  const [saveBlocked, setSaveBlocked] = useState(false);
  const [amount, setAmount] = useState(0);
  const [accountId, setAccountId] = useState("");
  const [voucherDate, setVoucherDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [note, setNote] = useState("");

  useEffect(() => {
    if (open && !saveBlocked) {
      setErrors({}); setServerError('');
      setManagerId(defaultManagerId ?? "");
      setAmount(0);
      setAccountId("");
      setVoucherDate(format(new Date(), "yyyy-MM-dd"));
      setNote("");
    }
  }, [open, defaultManagerId, saveBlocked]);

  const routeState = profitLedgerRouteState(ledger?.route);
  // Chỉ người nhận còn hiệu lực mới chi được (đã xoá / ngưng ⇒ chỉ hiện số trên bảng).
  const payable = useMemo(
    () => (ledger?.managers ?? []).filter((row) => !row.is_deleted && row.is_active),
    [ledger],
  );
  const row = payable.find((m) => m.manager_id === managerId) ?? null;
  const remaining = row ? Math.max(row.balance, 0) : null;
  const payoutAccounts = useMemo(
    () => profitPayoutAccounts({ mode: "OWNER", organizationId, accounts }),
    [organizationId, accounts],
  );
  const frozen = !!ledger && !routeState.canPayManager;
  const locked = !ledger || frozen || !organizationId;

  const handleSubmit = async () => {
    if (createMut.isPending || saveBlocked || locked) return;
    const next: Record<string, string> = {};
    if (!managerId || !row) next.managerId = 'Chọn quản lý nhận khoản chi.';
    if (!Number.isFinite(amount) || amount <= 0) next.amount = 'Nhập số tiền lớn hơn 0.';
    else if (remaining !== null && amount > remaining + 0.005) {
      next.amount = `Vượt lương điều hành còn lại ${formatVND(remaining)}. Không chi quá số còn lại.`;
    }
    if (!payoutAccounts.some(a => a.id === accountId)) next.accountId = 'Chọn sổ quỹ chi hợp lệ.';
    if (!voucherDate) next.voucherDate = 'Chọn ngày chi.';
    setErrors(next); setServerError('');
    if (Object.keys(next).length) { await focusFirstError(next, { root: dialogRef.current }); return; }
    if (!validateInputDrafts(dialogRef.current)) return;
    const account = payoutAccounts.find(a => a.id === accountId);
    if (!row || !account?.organization_id) return;
    try {
      await createMut.mutateAsync({
        manager_id: managerId,
        manager_name: row.name,
        amount,
        account_id: accountId,
        organizationId: account.organization_id,
        voucher_date: voucherDate,
        note: note.trim() || null,
      });
      onOpenChange(false);
    } catch (error) {
      // Vượt số còn lại (máy chủ, kèm số), sổ tổng đóng băng, tháng đã chốt… — câu theo mã.
      const info = profitLedgerErrorMessage(error, 'manager_payout');
      setServerError(info.message);
      if (info.kind === 'UNKNOWN_OUTCOME') setSaveBlocked(true);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent ref={dialogRef} className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>Chi lương điều hành</DialogTitle>
          <DialogDescription>Không chi quá số còn lại; không có tạm ứng lương điều hành.</DialogDescription>
        </DialogHeader>

        <QueryRegion label="sổ quỹ chi" queries={[accountsQuery]} skeleton="detail" rows={5}>
        <div className="space-y-4 py-2">
          {frozen && (
            <p role="status" className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />Sổ tổng đang đóng băng — tạm khoá chi lương điều hành.
            </p>
          )}
          {!ledger && (
            <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">
              Chưa tải được lương điều hành còn lại — tải lại trang rồi chi.
            </p>
          )}
          <div className="space-y-2">
            <Label>Quản lý <span className="text-red-500">*</span></Label>
            <SearchableSelect
              name="managerId" aria-invalid={!!errors.managerId} aria-describedby="error-managerId"
              value={managerId}
              onValueChange={setManagerId}
              placeholder="Chọn quản lý"
              options={payable.map((m) => ({ value: m.manager_id, label: m.name }))}
            />
          </div>
          {row && (
            <div className="space-y-1 rounded-md border bg-muted/30 p-3 text-sm" data-testid="manager-payout-balance">
              {row.balance >= 0 ? (
                <p>Còn lại: <strong>{formatVND(row.balance)}</strong></p>
              ) : (
                <p className="text-destructive">Đã chi vượt: <strong>{formatVND(-row.balance)}</strong> — không chi thêm được.</p>
              )}
              <p className="text-muted-foreground">
                Được nhận {formatVND(row.allocated)} · đã trả {formatVND(row.payouts_approved)} · chờ duyệt {formatVND(row.payouts_pending)}
              </p>
            </div>
          )}
          <div className="space-y-2">
            <Label>Số tiền <span className="text-red-500">*</span></Label>
            <CurrencyInput name="amount" aria-invalid={!!errors.amount} aria-describedby="error-amount" value={amount} onChange={setAmount} />
          </div>
          <div className="space-y-2">
            <Label>Chi từ sổ quỹ <span className="text-red-500">*</span></Label>
            <SearchableSelect
              name="accountId" aria-invalid={!!errors.accountId} aria-describedby="error-accountId"
              value={accountId}
              onValueChange={setAccountId}
              placeholder="Chọn sổ quỹ nguồn"
              options={payoutAccounts.map((a) => ({ value: a.id, label: a.name, keywords: a.code ?? undefined }))}
            />
          </div>
          <div className="space-y-2">
            <Label>Ngày <span className="text-red-500">*</span></Label>
            <DateInput name="voucherDate" aria-invalid={!!errors.voucherDate} aria-describedby="error-voucherDate" value={voucherDate} onChange={setVoucherDate} />
          </div>
          <div className="space-y-2">
            <Label>Ghi chú</Label>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
          </div>
          {routeState.route === 'CANONICAL' && !!ledger && (
            <p className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground" data-testid="manager-payout-approval-note">
              {MANAGER_PAYOUT_APPROVAL_NOTE}
            </p>
          )}
        </div>
        {Object.entries(errors).map(([key, message]) => <p id={`error-${key}`} key={key} className="text-sm text-destructive">{message}</p>)}
        {serverError && <p role="alert" className="rounded border border-destructive p-3 text-sm text-destructive">{serverError}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Huỷ</Button>
          <Button onClick={handleSubmit} disabled={createMut.isPending || saveBlocked || locked}>
            {createMut.isPending ? "Đang ghi..." : "Ghi phiếu chi"}
          </Button>
        </DialogFooter>
        </QueryRegion>
      </DialogContent>
    </Dialog>
  );
}
