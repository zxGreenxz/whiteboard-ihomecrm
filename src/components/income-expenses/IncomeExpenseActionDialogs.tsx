import { useCallback, useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAccounts } from "@/hooks/useAccounts";
import { formatVND } from "@/lib/utils";
import type { IncomeExpenseActionsController } from "@/hooks/income-expenses/useIncomeExpenseActions";
import {
  adoptVoucherAttachmentsAsEvidence,
  uploadFinanceEvidence,
  useAttachPostingEvidence,
  useRemovePostingAttachment,
} from "@/hooks/income-expenses/financeV2Mutations";
import IncomeExpensePostingDialog from "./IncomeExpensePostingDialog";
import IncomeExpenseQuickEditDialog from "./IncomeExpenseQuickEditDialog";
import AttachmentUpload from "./AttachmentUpload";
const labels = {
  approveOnly: "Chỉ duyệt",
  legacyApprove: "Duyệt phiếu",
  approveAndPost: "Duyệt và Thu/Chi",
  post: "Thu/Chi",
  reverse: "Hoàn tác",
  unapprove: "Huỷ duyệt",
  cancel: "Huỷ phiếu",
  edit: "Sửa phiếu",
  supplement: "Bổ sung chứng từ / ghi chú",
  requestChanges: "Yêu cầu rà soát",
  resubmitReview: "Chuyển chờ duyệt",
};
/** Shared host keeps evidence callbacks, confirmation drafts and the immutable controller request together. */
export function IncomeExpenseActionDialogs({
  controller: c,
}: {
  controller: IncomeExpenseActionsController;
}) {
  const { data: accounts = [] } = useAccounts(),
    attach = useAttachPostingEvidence(),
    remove = useRemovePostingAttachment();
  const [reason, setReason] = useState(""),
    [accountId, setAccountId] = useState(""),
    [attachments, setAttachments] = useState<string[]>([]),
    [evidenceBusy, setEvidenceBusy] = useState(false),
    evidenceCount = useRef(0),
    legacyUpload = useRef(false);
  const selected = c.selected,
    v = selected?.snapshot;
  useEffect(() => {
    setReason("");
    setAccountId(v?.accountId || "");
    setAttachments(v?.attachments || []);
  }, [selected?.key, v?.id, v?.accountId, v?.attachments]);
  const evidence = useCallback(
    async <T,>(call: () => Promise<T>): Promise<T> => {
      evidenceCount.current++;
      setEvidenceBusy(true);
      try {
        return await call();
      } finally {
        evidenceCount.current--;
        setEvidenceBusy(evidenceCount.current > 0);
      }
    },
    [],
  );
  const adoptEvidence = useCallback(
    (id: string) => evidence(() => adoptVoucherAttachmentsAsEvidence(id)),
    [evidence],
  );
  const attachEvidence = useCallback(
    (file: File) =>
      evidence(() =>
        attach(file, {
          voucherId: v?.id || "",
          userId: selected?.scope.actorId || "",
          organizationId: selected?.scope.organizationId,
        }),
      ),
    [
      evidence,
      attach,
      v?.id,
      selected?.scope.actorId,
      selected?.scope.organizationId,
    ],
  );
  const removeEvidence = useCallback(
    (url: string) => evidence(() => remove(v?.id || "", url)),
    [evidence, remove, v?.id],
  );
  const uploadEvidence = useCallback(
    (file: File) =>
      evidence(() =>
        uploadFinanceEvidence(file, selected?.scope.organizationId),
      ),
    [evidence, selected?.scope.organizationId],
  );
  useEffect(() => {
    if (
      v?.capabilities.requiresRealAccount &&
      accountId === v.accountId &&
      accounts.some((a) => a.id === accountId && a.is_virtual)
    )
      setAccountId("");
  }, [
    v?.id,
    v?.accountId,
    v?.capabilities.requiresRealAccount,
    accountId,
    accounts,
  ]);
  if (!selected) return null;
  const blocked = c.dismissalBlocked || evidenceBusy,
    action = selected.action,
    decision = c.selectedAvailability?.[action];
  const close = () => {
    if (!evidenceCount.current && !legacyUpload.current) c.close();
  };
  const feedback = c.outcome.message ? (
    <div role="status" className="space-y-2 rounded border p-3 text-sm">
      <p>{c.outcome.message}</p>
      {(c.outcome.kind === "unknown" ||
        c.outcome.kind === "processed-refresh-failed") && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={c.busy}
            onClick={() => void c.commands.reconcile()}
          >
            Tải lại để đối chiếu
          </Button>
          {c.outcome.kind === "unknown" && c.retryable && (
            <Button
              type="button"
              disabled={c.busy}
              onClick={() => void c.commands.retry().catch(() => {})}
            >
              Gửi lại cùng yêu cầu
            </Button>
          )}
        </div>
      )}
    </div>
  ) : null;
  if (v && action === "supplement")
    return (
      <IncomeExpenseQuickEditDialog
        open
        onOpenChange={(next) => {
          if (!next) close();
        }}
        voucher={{
          id: v.id,
          code: v.code,
          notes: v.notes,
          attachments: v.attachments,
          supplements: [],
        }}
        busy={blocked}
        feedback={feedback}
        onSubmit={(values) => c.commands.confirm({ supplement: values })}
      />
    );
  if (
    v &&
    (action === "post" || action === "approveAndPost") &&
    v.approvalVersion !== null &&
    v.postingVersion !== null
  ) {
    const cashbooks = c.cashbooks.state === "ready" ? c.cashbooks.value : [];
    return (
      <IncomeExpensePostingDialog
        open
        onOpenChange={(next) => {
          if (!next) close();
        }}
        mode={action === "post" ? "POST_APPROVED" : "APPROVE_AND_POST"}
        voucher={{
          subjectKind: "VOUCHER",
          subjectId: v.id,
          type: v.type === "INCOME" ? "INCOME" : "EXPENSE",
          approvedTotal: v.totalAmount,
          name: v.name,
          defaultCashbookId: v.accountId,
          attachments: v.attachments,
        }}
        capability={{
          isCustodian: cashbooks.length > 0,
          canApprove:
            action === "approveAndPost" &&
            !!c.selectedAvailability?.approveAndPost.enabled,
        }}
        cashbookOptions={cashbooks}
        expectedExecutionRevision={0}
        expectedApprovalVersion={v.approvalVersion}
        expectedPostingVersion={v.postingVersion}
        idempotencyKey={selected.key}
        onAdoptAttachments={adoptEvidence}
        onAttachEvidence={attachEvidence}
        onRemoveAttachment={removeEvidence}
        onUploadEvidence={uploadEvidence}
        onSubmit={async (posting) => {
          try {
            await c.commands.confirm({ posting });
          } catch {
            /* Controller keeps the draft and classified outcome. */
          }
        }}
        isSubmitting={blocked || !decision?.enabled}
        feedback={feedback}
      />
    );
  }
  const needsReason = ["cancel", "reverse", "requestChanges"].includes(action),
    minReason = action === "requestChanges" ? 1 : 8;
  const info =
    action === "resubmitReview"
      ? "Trả phiếu hiện có về Chờ duyệt. Giữ nguyên mã, số tiền và nguồn phiếu."
      : action === "requestChanges"
        ? "Ghi lý do cần rà soát; phiếu chưa được duyệt hoặc ghi sổ."
        : action === "approveOnly"
          ? "Duyệt phiếu. Tiền được ghi nhận vào sổ khi thực hiện Thu/Chi."
          : action === "legacyApprove"
            ? "Sau khi duyệt, phiếu được tính vào tồn quỹ. Hãy kiểm tra thanh toán và sổ quỹ."
            : action === "reverse"
              ? "Tạo bút toán đối dấu ngày hôm nay. Phiếu chuyển sang Đã hoàn tác; bút toán gốc giữ trong lịch sử."
              : action === "unapprove"
                ? "Đưa phiếu đã duyệt về Chờ duyệt theo điều kiện hiện tại."
                : action === "cancel"
                  ? "Huỷ phiếu và cập nhật sổ quỹ theo trạng thái hiện tại. Phiếu vẫn giữ trong lịch sử."
                  : "Kiểm tra phiếu trước khi tiếp tục.";
  const cancelMode = c.contexts[selected.id]?.cancellation;
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent
        onInteractOutside={(e) => {
          if (blocked) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (blocked) e.preventDefault();
        }}
        className="max-h-[90dvh] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>{labels[action]}</DialogTitle>
          <DialogDescription>{info}</DialogDescription>
        </DialogHeader>
        {v ? (
          <p className="text-sm">
            <b>{v.code}</b> · {v.name} · <b>{formatVND(v.totalAmount)}</b>
          </p>
        ) : (
          <p>Đang tải phiếu và điều kiện thao tác…</p>
        )}
        {feedback}
        {action === "cancel" &&
          cancelMode?.state === "ready" &&
          cancelMode.value.mode === "COLLECTION" && (
            <p className="text-sm">
              Thao tác huỷ cả lần thu và mở lại nợ trên hoá đơn.
            </p>
          )}
        {action === "cancel" &&
          cancelMode?.state === "ready" &&
          cancelMode.value.mode === "FORFEIT_PAIR" && (
            <p className="text-sm">
              Thao tác huỷ cả hai phiếu của cặp cấn cọc bỏ cọc.
            </p>
          )}
        {needsReason && (
          <div className="space-y-2">
            <Label htmlFor="shared-action-reason">Lý do</Label>
            <Textarea
              id="shared-action-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={blocked}
              maxLength={5000}
              rows={3}
            />
          </div>
        )}
        {action === "legacyApprove" && v && (
          <div className="space-y-3">
            <Label>Sổ quỹ</Label>
            <Select
              value={accountId}
              onValueChange={setAccountId}
              disabled={blocked || v.flowKind !== null}
            >
              <SelectTrigger>
                <SelectValue placeholder="Chọn sổ quỹ" />
              </SelectTrigger>
              <SelectContent>
                {accounts
                  .filter(
                    (a) =>
                      a.organization_id === selected.scope.organizationId &&
                      (!v.capabilities.requiresRealAccount || !a.is_virtual),
                  )
                  .map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <AttachmentUpload
              attachments={attachments}
              onChange={setAttachments}
              userId={selected.scope.actorId}
              disabled={blocked || v.flowKind !== null}
              onUploadingChange={(value) => {
                legacyUpload.current = value;
                setEvidenceBusy(value);
              }}
            />
          </div>
        )}
        {decision?.reason && (
          <p role="status" className="text-sm text-muted-foreground">
            {decision.reason}
          </p>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={close}
            disabled={blocked}
          >
            Đóng
          </Button>
          {action === "approveOnly" &&
            c.selectedAvailability?.approveAndPost.visible && (
              <Button
                type="button"
                variant="outline"
                disabled={
                  blocked || !c.selectedAvailability.approveAndPost.enabled
                }
                title={
                  c.selectedAvailability.approveAndPost.reason || undefined
                }
                onClick={() => c.open("approveAndPost", selected.id)}
              >
                Duyệt và {v?.type === "INCOME" ? "Thu" : "Chi"}…
              </Button>
            )}
          <Button
            type="button"
            disabled={
              blocked ||
              !v ||
              !decision?.enabled ||
              (needsReason && reason.trim().length < minReason) ||
              (action === "legacyApprove" &&
                v?.capabilities.requiresRealAccount &&
                !accountId)
            }
            onClick={() =>
              void c.commands
                .confirm({
                  reason,
                  ...(action === "legacyApprove"
                    ? { legacy: { accountId: accountId || null, attachments } }
                    : {}),
                })
                .catch(() => {})
            }
          >
            {c.busy ? "Đang xử lý…" : labels[action]}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
