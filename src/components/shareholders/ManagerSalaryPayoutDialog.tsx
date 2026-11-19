// Hộp "Chi lương điều hành" theo sổ lương điều hành (E10): được nhận − đã trả − chờ duyệt = còn lại.
// Sổ tổng chạy (SHADOW trở đi): KHÔNG cho chi quá số còn lại (máy chủ CANONICAL cũng chặn), không có
// tạm ứng. Sổ tổng còn xem thử (LEGACY — chưa có mốc, số còn lại tính trên toàn lịch sử): chỉ CẢNH BÁO
// khi vượt, vẫn lập được như trước Đợt 2. Đóng băng ⇒ tạm khoá chi. Sổ quỹ: chỉ sổ tiền thật của đúng
// công ty (máy chủ cũng từ chối sổ ảo / sổ công ty khác).
//
// Sổ tổng chạy thật (CANONICAL — phiếu lương điều hành là phiếu sổ tổng do chủ lập) — từ 19/11/2026 cùng một màn với
// khối "Duyệt và Chi" bên dưới (như hộp chốt chi lợi nhuận cổ đông): MỘT nút lập phiếu (manager_salary_payout_v1 lưu
// phiếu ở Chờ duyệt) rồi cùng nick làm tiếp cho đúng phiếu đó — giữ sổ đã chọn ⇒ Duyệt và Chi kèm ảnh chứng từ; không
// giữ sổ ⇒ chỉ duyệt (useOwnerPayoutPosting). Bước sau hỏng ⇒ phiếu ở Chờ duyệt, "Làm tiếp" không lập phiếu thứ hai.
// Route khác: chỉ lập phiếu chờ duyệt như trước.
import { validateInputDrafts } from "@/lib/inputDraftValidation";
import { QueryRegion } from "@/components/errors/QueryRegion";
import { focusFirstError } from "@/lib/formErrors";
import { useEffect, useMemo, useRef, useState } from "react";
import { Info, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DIALOG_SCROLL_BODY,
  DIALOG_STICKY_FOOTER,
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
import {
  describeOwnerPayoutFailure, ownerPayoutCanResume, useOwnerPayoutPosting,
  type OwnerPayoutStep, type OwnerPayoutStepFailure, type OwnerPayoutTarget,
} from "@/hooks/profit-ledger/useOwnerPayoutPosting";
import { profitLedgerErrorMessage } from "@/lib/profitLedger/errors";
import type { ManagerLedger } from "@/lib/profitLedger/ledgerReaders";
import { profitPayoutAccounts } from "@/lib/profitLedger/payoutAccounts";
import { profitLedgerRouteState } from "@/lib/profitLedger/route";
import { formatVND } from "@/lib/utils";
import { format } from "date-fns";
import {
  OWNER_PAYOUT_APPROVE_LABEL, OWNER_PAYOUT_POST_LABEL, OWNER_PAYOUT_RESUME_LABEL, OwnerPayoutPostingSection,
} from "./OwnerPayoutPostingSection";

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Công ty của sổ lương điều hành — sổ quỹ chi lọc theo công ty này. */
  organizationId: string | null;
  /** Sổ lương điều hành (E10): người nhận + số còn lại. Chưa tải ⇒ chưa chi được. */
  ledger: ManagerLedger | undefined;
  defaultManagerId?: string | null;
}

/** Luật duyệt của phiếu lương điều hành theo sổ tổng (chốt F1, nới 19/11/2026) — báo trước khi lập. */
export const MANAGER_PAYOUT_APPROVAL_NOTE =
  "Phiếu lương điều hành do chủ lập: người có quyền chi lương điều hành tự duyệt được phiếu mình lập, duyệt được cả khi chính mình là người nhận; tự chi khi là người nhận thì quyền chi phải phủ cả công ty.";

/** Phiếu đã lập (E11 xong) — bước Duyệt và Chi / Duyệt làm tiếp cho ĐÚNG phiếu này. */
interface CreatedManagerPayout {
  target: OwnerPayoutTarget;
  code: string | null;
  managerName: string;
  amount: number;
  accountName: string | null;
  /** Lương điều hành còn lại sau phiếu này (chỉ khi máy chủ trả số dư trước phiếu). */
  remainingAfter: number | null;
}

export default function ManagerSalaryPayoutDialog({
  open,
  onOpenChange,
  organizationId,
  ledger,
  defaultManagerId,
}: Props) {
  const accountsQuery = useAccounts();
  const { data: accounts = [] } = accountsQuery;
  const routeState = profitLedgerRouteState(ledger?.route);
  // Sổ tổng chạy thật: phiếu lương điều hành là phiếu sổ tổng do chủ lập ⇒ Duyệt và Chi ngay trong hộp.
  const postInDialog = !!ledger && routeState.canApprove;
  const createMut = useCreateManagerSalaryPayout({ deferFeedback: postInDialog });
  const posting = useOwnerPayoutPosting(open && postInDialog, 'pay_manager');

  const [managerId, setManagerId] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState('');
  const [saveBlocked, setSaveBlocked] = useState(false);
  const [amount, setAmount] = useState(0);
  const [accountId, setAccountId] = useState("");
  const [voucherDate, setVoucherDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [note, setNote] = useState("");
  // E11 đã lập phiếu, bước sau chưa xong: khoá form, chỉ còn "Làm tiếp" cho đúng phiếu này.
  const [created, setCreated] = useState<CreatedManagerPayout | null>(null);
  const [stepFailure, setStepFailure] = useState<OwnerPayoutStepFailure | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);

  useEffect(() => {
    if (open && !saveBlocked) {
      setErrors({}); setServerError('');
      setManagerId(defaultManagerId ?? "");
      setAmount(0);
      setAccountId("");
      setVoucherDate(format(new Date(), "yyyy-MM-dd"));
      setNote("");
      setCreated(null);
      setStepFailure(null);
      setEvidenceError(null);
    }
  }, [open, defaultManagerId, saveBlocked]);

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
  // Trần "còn lại" chỉ là chốt cứng khi sổ tổng chạy; LEGACY chỉ cảnh báo (số còn lại đang xem thử).
  const capEnforced = !!ledger && routeState.ledgerReady;
  const overRemaining = remaining !== null && Number.isFinite(amount) && amount > remaining + 0.005;
  const busy = createMut.isPending || finishing || posting.pending;
  // Chỉ đang chờ ảnh tải thì vẫn đóng được (như hộp Thu/Chi): lượt bấm tự dừng, chưa gửi gì.
  const closeBlocked = busy && !posting.evidence.waiting;
  const formLocked = saveBlocked || !!created;
  const selectedStep = postInDialog ? posting.stepFor(accountId) : null;
  const accountName = (id: string) => payoutAccounts.find((a) => a.id === id)?.name ?? null;

  /** Giữ sổ (Duyệt và Chi): phải có ảnh chứng từ, ảnh đang tải thì chờ xong. true = đi tiếp được. */
  const evidenceReady = async (label: string): Promise<boolean> => {
    setEvidenceError(null);
    setFinishing(true);
    let stop: string | null;
    try {
      stop = await posting.evidence.ensureReady(label);
    } finally {
      setFinishing(false);
    }
    if (stop === null) return true;
    if (stop) {
      setEvidenceError(stop);
      void focusFirstError({ evidenceIds: stop }, { root: dialogRef.current });
    }
    return false;
  };

  /** Bước sau cho phiếu vừa lập: nói đúng trạng thái thật rồi đóng; hỏng thì giữ phiếu đó để "Làm tiếp". */
  const finish = async (next: CreatedManagerPayout) => {
    setStepFailure(null);
    setFinishing(true);
    const posted = next.target.step === 'APPROVE_AND_POST';
    const voucher = next.code ? `phiếu ${next.code}` : 'phiếu chi';
    const book = next.accountName ? `sổ ${next.accountName}` : 'sổ quỹ đã chọn';
    const tail = next.remainingAfter === null ? '' : ` Lương điều hành còn lại: ${formatVND(next.remainingAfter)}.`;
    try {
      const outcome = await posting.complete(next.target);
      setCreated(null);
      if (outcome === 'POSTED') {
        toast.success(`Đã chi lương điều hành ${formatVND(next.amount)} cho ${next.managerName}: ${voucher} đã duyệt và chi từ ${book}.${tail}`);
      } else if (posted) {
        toast.success(`Lương điều hành ${formatVND(next.amount)} cho ${next.managerName}: ${voucher} đã được duyệt — bấm Chi (kèm ảnh chứng từ) ở Thu chi để chi tiền.${tail}`);
      } else {
        toast.success(`Đã lập và duyệt ${voucher} lương điều hành ${formatVND(next.amount)} cho ${next.managerName} — người giữ ${book} bấm Chi (kèm ảnh chứng từ) ở Thu chi.${tail}`);
      }
      onOpenChange(false);
    } catch (error) {
      const failure = describeOwnerPayoutFailure(error, next.target.step);
      if (failure.kind === 'APPROVE_ONLY') {
        // Máy chủ không cho chính người nhận chi (quyền chi không phủ cả công ty): làm tiếp chỉ Duyệt.
        setCreated({ ...next, target: { ...next.target, step: 'APPROVE' } });
        setStepFailure({ ...failure, message: `${failure.message} Bấm “${OWNER_PAYOUT_RESUME_LABEL}” để chỉ duyệt.` });
      } else {
        // Từ chối vì quyền / chưa rõ kết quả ⇒ khoá "Làm tiếp" (gửi lại vẫn y lỗi), chỉ đường sang Chờ duyệt / Thu chi.
        setStepFailure(failure);
      }
      toast.warning(`Đã lập ${voucher} lương điều hành cho ${next.managerName}, đang chờ duyệt — chưa ${posted ? 'duyệt và chi' : 'duyệt'} được.`);
    } finally {
      setFinishing(false);
    }
  };

  /** "Làm tiếp": bước sau cho ĐÚNG phiếu đã lập — không lập phiếu thứ hai. */
  const resume = async () => {
    if (!created || busy || !ownerPayoutCanResume(stepFailure)) return;
    if (created.target.step === 'APPROVE_AND_POST' && !(await evidenceReady(OWNER_PAYOUT_RESUME_LABEL))) return;
    await finish(created);
  };

  const handleSubmit = async () => {
    if (busy || formLocked || locked) return;
    const next: Record<string, string> = {};
    if (!managerId || !row) next.managerId = 'Chọn quản lý nhận khoản chi.';
    if (!Number.isFinite(amount) || amount <= 0) next.amount = 'Nhập số tiền lớn hơn 0.';
    else if (capEnforced && overRemaining && remaining !== null) {
      next.amount = `Vượt lương điều hành còn lại ${formatVND(remaining)}. Không chi quá số còn lại.`;
    }
    if (!payoutAccounts.some(a => a.id === accountId)) next.accountId = 'Chọn sổ quỹ chi hợp lệ.';
    if (!voucherDate) next.voucherDate = 'Chọn ngày chi.';
    setErrors(next); setServerError('');
    if (Object.keys(next).length) { await focusFirstError(next, { root: dialogRef.current }); return; }
    if (!validateInputDrafts(dialogRef.current)) return;
    const account = payoutAccounts.find(a => a.id === accountId);
    if (!row || !account?.organization_id) return;
    // Sổ tổng chạy thật: bước sau theo sổ người bấm đang GIỮ (như hộp Chi) và quyền — giữ ⇒ Duyệt và Chi kèm ảnh; không
    // ⇒ duyệt; không duyệt được ⇒ chỉ lập phiếu chờ duyệt như route khác.
    let step: OwnerPayoutStep | null = null;
    if (postInDialog) {
      const next = posting.stepFor(accountId);
      if (next === undefined) {
        setServerError(posting.cashbooksError
          ? 'Chưa tải được danh sách sổ quỹ bạn đang giữ — bấm "Tải lại sổ quỹ" rồi gửi.'
          : 'Đang kiểm sổ quỹ bạn đang giữ — đợi một chút rồi bấm lại.');
        return;
      }
      if (next === 'APPROVE_AND_POST' && !(await evidenceReady(OWNER_PAYOUT_POST_LABEL))) return;
      step = next;
    }
    let receipt: Awaited<ReturnType<typeof createMut.mutateAsync>>;
    try {
      receipt = await createMut.mutateAsync({
        manager_id: managerId,
        manager_name: row.name,
        amount,
        account_id: accountId,
        organizationId: account.organization_id,
        voucher_date: voucherDate,
        note: note.trim() || null,
      });
    } catch (error) {
      // Vượt số còn lại (máy chủ, kèm số), sổ tổng đóng băng, tháng đã chốt… — câu theo mã.
      const info = profitLedgerErrorMessage(error, 'manager_payout');
      setServerError(info.message);
      if (info.kind === 'UNKNOWN_OUTCOME') setSaveBlocked(true);
      return;
    }
    if (!step) {
      // Route khác: hook đã báo "đã tạo phiếu". Sổ tổng chạy mà người bấm không duyệt được: hộp tự báo đúng trạng thái.
      if (postInDialog) {
        toast.success(`Đã lập ${receipt.code ? `phiếu ${receipt.code}` : 'phiếu'} lương điều hành ${formatVND(amount)} cho ${row.name} — chờ duyệt, chưa chi tiền.`);
      }
      onOpenChange(false);
      return;
    }
    const createdPayout: CreatedManagerPayout = {
      target: { voucherId: receipt.voucher_id, organizationId: account.organization_id, accountId, postedOn: voucherDate, step },
      code: receipt.code || null,
      managerName: row.name,
      amount,
      accountName: account.name,
      remainingAfter: receipt.balance_before === null ? null : receipt.balance_before - amount,
    };
    setCreated(createdPayout);
    await finish(createdPayout);
  };

  const submitLabel = !postInDialog || selectedStep === null
    ? "Ghi phiếu chi"
    : selectedStep === 'APPROVE' ? OWNER_PAYOUT_APPROVE_LABEL : OWNER_PAYOUT_POST_LABEL;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!closeBlocked) onOpenChange(next); }}>
      {/* Cùng khuôn hộp dài với ProfitDistributeDialog: ở CANONICAL câu luật duyệt làm hộp cao hơn khung điện
          thoại (đo 16/11/2026: 882px trong 844px) ⇒ giới hạn theo khung nhìn động + cuộn dọc. */}
      <DialogContent ref={dialogRef} className={`sm:max-w-[460px] ${DIALOG_SCROLL_BODY}`}>
        <DialogHeader>
          <DialogTitle>Chi lương điều hành</DialogTitle>
          <DialogDescription>Không chi quá số còn lại; không có tạm ứng lương điều hành.</DialogDescription>
        </DialogHeader>

        <QueryRegion label="sổ quỹ chi" queries={[accountsQuery]} skeleton="detail" rows={5}>
        <fieldset disabled={formLocked || busy} className="m-0 min-w-0 space-y-4 border-0 px-0 py-2">
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
                <p>Còn lại{capEnforced ? '' : ' (xem thử)'}: <strong>{formatVND(row.balance)}</strong></p>
              ) : (
                <p className="text-destructive">
                  Đã chi vượt{capEnforced ? '' : ' (xem thử)'}: <strong>{formatVND(-row.balance)}</strong>
                  {capEnforced ? ' — không chi thêm được.' : ''}
                </p>
              )}
              <p className="text-muted-foreground">
                Được nhận {formatVND(row.allocated)} · đã trả {formatVND(row.payouts_approved)} · chờ duyệt {formatVND(row.payouts_pending)}
              </p>
            </div>
          )}
          <div className="space-y-2">
            <Label>Số tiền <span className="text-red-500">*</span></Label>
            <CurrencyInput name="amount" aria-invalid={!!errors.amount} aria-describedby="error-amount" value={amount} onChange={setAmount} />
            {!capEnforced && overRemaining && remaining !== null && (
              <p role="status" className="text-sm text-amber-700" data-testid="manager-payout-over-warning">
                Vượt số còn lại {formatVND(remaining)} theo sổ đang xem thử (chưa có mốc đã trả đủ) — vẫn lập được; kiểm tra lại số trước khi chi.
              </p>
            )}
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
        </fieldset>
        {/* Khối "Duyệt và Chi" bên dưới phần số liệu: cùng ô ảnh chứng từ với hộp Duyệt và Chi của Thu chi. */}
        {postInDialog && (
          <OwnerPayoutPostingSection
            posting={posting}
            accountId={created ? created.target.accountId : accountId}
            accountName={created ? created.accountName : accountName(accountId)}
            evidenceError={evidenceError}
            disabled={busy || saveBlocked || (!!stepFailure && !ownerPayoutCanResume(stepFailure))}
            created={created ? { code: created.code, step: created.target.step } : null}
            stepFailure={stepFailure}
          />
        )}
        {Object.entries(errors).map(([key, message]) => <p id={`error-${key}`} key={key} className="text-sm text-destructive">{message}</p>)}
        {serverError && <p role="alert" className="rounded border border-destructive p-3 text-sm text-destructive">{serverError}</p>}
        <DialogFooter className={DIALOG_STICKY_FOOTER}>
          <Button variant="outline" disabled={closeBlocked} onClick={() => onOpenChange(false)}>Huỷ</Button>
          {created ? (
            // Phiếu đã lập, bước sau dở: làm tiếp cho ĐÚNG phiếu đó (không lập phiếu mới).
            <Button type="button" disabled={busy || !ownerPayoutCanResume(stepFailure)} onClick={() => { void resume(); }}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{OWNER_PAYOUT_RESUME_LABEL}
            </Button>
          ) : (
            <Button onClick={() => { void handleSubmit(); }} disabled={busy || saveBlocked || locked}>
              {createMut.isPending ? "Đang ghi..." : posting.evidence.waiting ? "Đang chờ ảnh tải xong…" : submitLabel}
            </Button>
          )}
        </DialogFooter>
        </QueryRegion>
      </DialogContent>
    </Dialog>
  );
}
