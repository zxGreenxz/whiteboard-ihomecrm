// Hộp xác nhận + form của MỘT bộ thao tác phiếu (useVoucherActions). Dời nguyên từ
// IncomeExpensePage (28/10/2026) để Thu chi máy tính, Thu chi điện thoại và Báo cáo lợi nhuận
// dùng chung đúng một bản — trước đó hai trang Thu chi mỗi trang một bản chép đã lệch nhau.
import { CommissionReasonField } from "@/components/income-expenses/CommissionReasonField";
import { RevisionComparison } from "@/components/income-expenses/RevisionSummary";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import AttachmentUpload from "@/components/income-expenses/AttachmentUpload";
import IncomeExpenseForm from "@/components/income-expenses/IncomeExpenseForm";
import IncomeExpenseQuickEditDialog from "@/components/income-expenses/IncomeExpenseQuickEditDialog";
import IncomeExpenseVerifyDialog from "@/components/income-expenses/IncomeExpenseVerifyDialog";
import IncomeExpensePostingDialog from "@/components/income-expenses/IncomeExpensePostingDialog";
import VoucherHistoryDialog from "@/components/income-expenses/VoucherHistoryDialog";
import { isCommissionVoucher } from "@/lib/commissionIntervention";
import { REVISION_REASON_MIN } from "@/lib/incomeExpenseRevision";
import { isNonCashVoucher } from "@/lib/financeV2VoucherState";
import { adoptVoucherAttachmentsAsEvidence, uploadFinanceEvidence } from "@/hooks/income-expenses/financeV2Mutations";
import type { VoucherActions } from "@/hooks/income-expenses/useVoucherActions";

export function VoucherActionDialogs({ actions }: { actions: VoucherActions }) {
  const d = actions.dialogs;
  const { cancel, restore, unapprove, approve, approveAndPost, postApproved, reverse, cancelBatch, posting } = d;
  const approveTarget = approve.target;
  const postApprovedTarget = postApproved.target;
  const reverseTarget = reverse.target;

  return (
    <>
      <IncomeExpenseForm
        open={!!d.editingVoucher}
        onOpenChange={(o) => { if (!o) d.closeEdit(); }}
        voucher={d.editingVoucher}
      />
      {/* Form "Tạo bản sao" từ phiếu đã huỷ — chế độ tạo mới, prefill toàn bộ */}
      <IncomeExpenseForm
        open={!!d.copyVoucher}
        onOpenChange={(o) => { if (!o) d.closeCopy(); }}
        voucher={null}
        copyFrom={d.copyVoucher}
        defaultType={d.copyVoucher?.type}
      />
      <IncomeExpenseQuickEditDialog
        open={!!d.quickEditVoucher}
        onOpenChange={(o) => { if (!o) d.closeQuickEdit(); }}
        voucher={d.quickEditVoucher}
      />
      <IncomeExpenseVerifyDialog
        open={!!d.verifyVoucher}
        onOpenChange={(o) => { if (!o) d.closeVerify(); }}
        voucher={d.verifyVoucher}
      />
      {/* Đợt 4: lịch sử phiếu — mốc lập/duyệt/huỷ + lý do + nhật ký trước/sau. */}
      <VoucherHistoryDialog
        open={!!d.historyVoucher}
        onOpenChange={(o) => { if (!o) d.closeHistory(); }}
        voucher={d.historyVoucher}
      />

      <AlertDialog open={!!cancel.target} onOpenChange={(o) => { if (!o) cancel.close(); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận huỷ phiếu</AlertDialogTitle>
            <AlertDialogDescription>
              {cancel.posted ? (
                <>
                  Phiếu này <b>đã {cancel.isIncome ? "thu" : "chi"} tiền
                  thật</b>. Huỷ sẽ <b>trừ thẳng khoản này khỏi tồn quỹ</b> ngay,
                  không sinh thêm phiếu đối ứng nào trong danh sách. Phiếu
                  chuyển <b>Đã huỷ</b> và giữ lại đầy đủ mốc lập / duyệt / huỷ
                  cùng lý do để đối soát.
                </>
              ) : (
                <>
                  Phiếu sẽ được đánh dấu <b>Đã huỷ</b> và không còn ảnh hưởng
                  đến tồn quỹ tài khoản. Phiếu vẫn được lưu lại trong lịch sử.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {/* ĐỢT A: phiếu THU đi cửa riêng, huỷ CẢ ĐỢT THU nếu lần thu đó gồm nhiều phiếu (bộ
              đếm toàn vẹn định nghĩa bất biến ở mức đợt thu, huỷ lẻ một phiếu sẽ kẹt cổng an
              toàn của hệ thống). */}
          {cancel.isIncome && cancel.gate.mode === "COLLECTION" && (
            <p className="rounded-md bg-blue-50 px-2 py-1.5 text-xs text-blue-800">
              Đây là khoản thu của một hoá đơn. Huỷ sẽ gỡ <b>cả lần thu đó</b>{" "}
              (kể cả khi lần thu gồm nhiều phiếu ở nhiều sổ quỹ) và{" "}
              <b>mở lại nợ trên hoá đơn</b> để thu lại.
            </p>
          )}
          {cancel.isIncome && cancel.gate.mode === "FORFEIT_PAIR" && (
            <p className="rounded-md bg-blue-50 px-2 py-1.5 text-xs text-blue-800">
              Phiếu này là một chân của cặp cấn cọc bỏ cọc — huỷ sẽ lật{" "}
              <b>cả hai chân</b> để hai sổ không lệch nhau.
            </p>
          )}
          {/* Sự thật về QUYỀN. Phiếu THU (ĐỢT A, quyết định của chủ 01/08/2026): chỉ người đã
              thu / chủ tổ chức / super admin — không còn đòi giữ sổ, không còn đòi quyền theo
              toà. Phiếu CHI giữ luật cũ. */}
          <p className="text-xs text-muted-foreground">
            {cancel.isIncome
              ? "Người huỷ được: chính người đã thu khoản này, chủ tổ chức, hoặc super admin."
              : "Người huỷ được: chủ tổ chức, super admin, người tạo phiếu — hoặc người vừa có quyền huỷ thu chi ở toà này vừa đang giữ sổ quỹ của phiếu (CUSTODIAN)."}
          </p>
          {/* Server đã nói trước là không huỷ được thì nói luôn ở đây, đừng để người dùng gõ
              xong lý do rồi mới ăn toast lỗi. */}
          {cancel.gate.reason && (
            <p
              className={
                cancel.gate.canCancel
                  ? "rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-800"
                  : "rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-700"
              }
            >
              {cancel.gate.canCancel ? "Lưu ý: " : "Không huỷ được: "}
              {cancel.gate.reason}
            </p>
          )}
          {/* Đợt 4: lý do là BẮT BUỘC ở mọi trạng thái. Đây là vế "đổi lại" của thoả thuận:
              cho huỷ thẳng không sinh phiếu đối ứng, nhưng phiếu đã huỷ phải tự giải thích
              được khi đối soát về sau. */}
          <div className="space-y-1">
            <Textarea
              name="cancelReason"
              aria-invalid={d.reasonError === "cancelReason"}
              value={cancel.reason}
              onChange={(e) => { cancel.setReason(e.target.value); d.setReasonError(null); }}
              placeholder="Lý do huỷ (bắt buộc, ít nhất 8 ký tự) — ví dụ: ghi nhầm số tiền, khách huỷ giao dịch…"
              rows={2}
            />
            <p className="text-xs text-muted-foreground">
              {d.reasonError === "cancelReason" && <span role="alert" className="text-destructive">Nhập lý do huỷ có ít nhất 8 ký tự. </span>}
              Lý do được lưu cùng mốc lập / duyệt / huỷ phiếu để đối soát lại khi cần.
            </p>
          </div>
          {d.actionError && <p role="alert" className="text-sm text-destructive">{d.actionError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel>Đóng</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => { event.preventDefault(); void cancel.confirm(); }}
              disabled={d.blockedVoucherId === cancel.target || !cancel.gate.canCancel || cancel.pending}
              className="bg-red-600 hover:bg-red-700"
            >
              {cancel.posted ? "Huỷ phiếu và cập nhật sổ quỹ" : "Huỷ phiếu"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!restore.target} onOpenChange={(o) => { if (!o) restore.close(); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận khôi phục phiếu</AlertDialogTitle>
            <AlertDialogDescription>
              Phiếu sẽ trở lại trạng thái <b>Đã ghi nhận</b> và tính lại vào{" "}
              <b>tồn quỹ</b>. Nếu là phiếu thu theo hoá đơn, khoản thanh toán
              tương ứng trên hoá đơn cũng được phục hồi. Thao tác được ghi vào
              lịch sử của phiếu.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {d.actionError && <p role="alert" className="text-sm text-destructive">{d.actionError}</p>}
          {restore.needsReason && <CommissionReasonField id="restoreTarget-reason" label="Lý do khôi phục phiếu" value={restore.reason} onChange={restore.setReason} />}
          <AlertDialogFooter>
            <AlertDialogCancel>Đóng</AlertDialogCancel>
            <AlertDialogAction
              disabled={restore.pending}
              onClick={(event) => { event.preventDefault(); void restore.confirm(); }}
              className="bg-green-600 hover:bg-green-700"
            >
              Khôi phục
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!approveTarget} onOpenChange={(o) => { if (!o) approve.close(); }}>
        <AlertDialogContent className="max-h-[90vh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận duyệt phiếu</AlertDialogTitle>
            <AlertDialogDescription>
              {approve.v2ApproveOnly ? (
                <>
                  <b>Duyệt</b> chỉ chuyển trạng thái phê duyệt — <b>không</b> thay
                  đổi tồn quỹ. Tiền chỉ vào/ra sổ khi thực hiện <b>Thu/Chi</b> với
                  đủ ngày, sổ quỹ và chứng từ.
                </>
              ) : (
                <>
                  Sau khi duyệt, phiếu sẽ được tính vào <b>tồn quỹ</b> và không
                  còn chỉnh sửa được. Hãy chắc chắn đã thanh toán cho người nhận.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {/* Câu 25: máy chủ báo người đang xem là người lập không được tự duyệt phiếu này. */}
          {approve.selfGate.blocked && (
            <p
              id="ie-self-approve-note"
              role="note"
              className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
            >
              {approve.selfGate.message}
            </p>
          )}

          {/* Phiếu đã bị sửa khi Chờ duyệt ⇒ người duyệt thấy đổi gì, ai sửa, vì sao. */}
          {approveTarget && <RevisionComparison voucherId={approveTarget.id} />}

          {!approve.v2ApproveOnly && (
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="approve-account">Sổ quỹ</Label>
              <Select value={approve.accountId} onValueChange={approve.setAccountId}>
                <SelectTrigger id="approve-account">
                  <SelectValue placeholder="Chọn sổ quỹ" />
                </SelectTrigger>
                <SelectContent>
                  {approve.accounts.map((acc) => (
                    <SelectItem key={acc.id} value={acc.id}>
                      {acc.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Bổ sung hoặc đổi sổ quỹ ghi nhận phiếu này trước khi duyệt.
              </p>
            </div>

            {approve.needsReason && (
              <div className="space-y-2">
                <Label htmlFor="approve-reason">Lý do thay đổi trước duyệt *</Label>
                <Textarea
                  id="approve-reason"
                  name="approveReason"
                  aria-invalid={d.reasonError === "approveReason"}
                  value={approve.reason}
                  onChange={(e) => { approve.setReason(e.target.value); d.setReasonError(null); }}
                  rows={2}
                  placeholder="Vì sao cần thay đổi nội dung phiếu?"
                />
                <p className="text-xs text-muted-foreground">
                  {d.reasonError === "approveReason" && <span role="alert" className="text-destructive">Nhập lý do thay đổi có ít nhất 8 ký tự. </span>}
                  Đổi sổ được lưu thành một lần sửa phiếu (ít nhất {REVISION_REASON_MIN} ký tự).
                </p>
              </div>
            )}

            <div className="space-y-2">
              <Label>Hình ảnh đính kèm</Label>
              <AttachmentUpload
                attachments={approve.attachments}
                onChange={approve.setAttachments}
                userId={d.authUserId ?? approveTarget?.user_id ?? ""}
              />
            </div>
          </div>
          )}

          {d.actionError && <p role="alert" className="text-sm text-destructive">{d.actionError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={approve.historyBlocked || approve.pending || approve.selfChecking}>
              Đóng
            </AlertDialogCancel>
            {/* 7af: phiếu NỘI BỘ (bút toán không tiền, sổ ảo) không bao giờ được chào ghi tiền
                vào sổ quỹ thật — chỉ còn nút "Duyệt". */}
            {approve.v2ApproveAndPost && !isNonCashVoucher(approveTarget) && (
              <Button
                variant="outline"
                className="border-blue-600 text-blue-700 hover:bg-blue-50"
                disabled={approve.pending || approveAndPost.pending || approve.selfGate.blocked || approve.selfChecking}
                aria-describedby={approve.selfGate.blocked ? "ie-self-approve-note" : undefined}
                onClick={() => { void approve.openApproveAndPost(); }}
              >
                {approveTarget?.type === "INCOME" ? "Duyệt và Thu…" : "Duyệt và Chi…"}
              </Button>
            )}
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void approve.confirm();
              }}
              disabled={
                approve.pending ||
                (!approve.v2ApproveOnly && approve.isShareholderPayout && !approve.accountId) ||
                d.blockedVoucherId === approveTarget?.id ||
                approve.selfGate.blocked ||
                approve.selfChecking
              }
              aria-describedby={approve.selfGate.blocked ? "ie-self-approve-note" : undefined}
              className="bg-green-600 hover:bg-green-700"
            >
              {approve.pending || approve.selfChecking
                ? "Đang duyệt…"
                : approve.v2ApproveOnly
                  ? "Chỉ duyệt"
                  : "Duyệt phiếu"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Finance V2: Duyệt và Chi/Thu atomic qua Posting dialog (§12.3). */}
      {approveTarget && (
        <IncomeExpensePostingDialog
          open={approveAndPost.open}
          onOpenChange={approveAndPost.setOpen}
          mode="APPROVE_AND_POST"
          voucher={{
            subjectKind: "VOUCHER",
            subjectId: approveTarget.id,
            type: (approveTarget.type as "INCOME" | "EXPENSE") ?? "EXPENSE",
            approvedTotal: approveTarget.total_amount ?? 0,
            name: approveTarget.name ?? undefined,
            defaultCashbookId: approveTarget.account_id ?? null,
            attachments: approveTarget.attachments ?? null,
            isCommission: isCommissionVoucher(approveTarget),
          }}
          capability={{ isCustodian: posting.custodianBooks.length > 0, canApprove: true }}
          cashbookOptions={posting.custodianBooks}
          cashbookError={posting.cashbookError}
          onRetryCashbooks={posting.retryCashbooks}
          expectedExecutionRevision={0}
          expectedApprovalVersion={(approveTarget as { approval_version?: number }).approval_version ?? 1}
          expectedPostingVersion={(approveTarget as { posting_version?: number }).posting_version ?? 1}
          onAdoptAttachments={adoptVoucherAttachmentsAsEvidence}
          onAttachEvidence={(file) =>
            posting.attachPostingEvidence(file, {
              voucherId: approveTarget.id,
              userId: d.authUserId ?? "",
              organizationId: (approveTarget as { organization_id?: string | null }).organization_id,
            })
          }
          onRemoveAttachment={(url) => posting.removePostingAttachment(approveTarget.id, url)}
          onUploadEvidence={(file) =>
            uploadFinanceEvidence(file, (approveTarget as { organization_id?: string | null }).organization_id)
          }
          onSubmit={approveAndPost.submit}
          isSubmitting={approveAndPost.pending}
        />
      )}

      {/* Mô hình 2 nút: xác nhận HOÀN TÁC phiếu đã ghi sổ (kèm lý do). */}
      <AlertDialog open={!!reverseTarget} onOpenChange={(o) => { if (!o) reverse.close(); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hoàn tác {reverseTarget?.type === "INCOME" ? "khoản thu" : "khoản chi"}</AlertDialogTitle>
            <AlertDialogDescription>
              Hệ thống tạo bút toán <b>đối dấu ghi ngày hôm nay</b> — tiền{" "}
              {reverseTarget?.type === "INCOME" ? "rời khỏi" : "trả về"} sổ{" "}
              <b>{(reverseTarget as { account_name?: string } | null)?.account_name ?? "đã chi"}</b>,{" "}
              <b>tồn quỹ thay đổi</b>. Phiếu chuyển sang <b>Đã hoàn tác</b> và
              nằm chờ: có thể <b>Thu/Chi lại</b> (vd đúng sổ khác) hoặc{" "}
              <b>Huỷ</b>. Bút toán gốc giữ nguyên trong lịch sử.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {isCommissionVoucher(reverseTarget) ? <CommissionReasonField id="reverse-reason" label="Lý do hoàn tác hoa hồng" value={reverse.reason} onChange={reverse.setReason} /> : <Textarea
            value={reverse.reason}
            onChange={(e) => reverse.setReason(e.target.value)}
            placeholder="Lý do hoàn tác (ghi vào bút toán — nên nhập)"
            rows={2}
          />}
          {d.actionError && <p role="alert" className="text-sm text-destructive">{d.actionError}</p>}
          <AlertDialogFooter>
            {/* Đang ghi bút toán đối dấu thì không cho đóng hộp giữa chừng. */}
            <AlertDialogCancel disabled={reverse.pending}>Đóng</AlertDialogCancel>
            <AlertDialogAction
              className="bg-violet-600 hover:bg-violet-700"
              disabled={reverse.pending}
              onClick={(event) => { event.preventDefault(); void reverse.confirm(); }}
            >
              Hoàn tác
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Finance V2 §12.3: Thu/Chi phiếu ĐÃ DUYỆT (CUSTODIAN, không cần quyền duyệt). */}
      {postApprovedTarget && (
        <IncomeExpensePostingDialog
          open={!!postApprovedTarget}
          onOpenChange={(o) => { if (!o) postApproved.close(); }}
          mode="POST_APPROVED"
          voucher={{
            subjectKind: "VOUCHER",
            subjectId: postApprovedTarget.id,
            type: (postApprovedTarget.type as "INCOME" | "EXPENSE") ?? "EXPENSE",
            approvedTotal: postApprovedTarget.total_amount ?? 0,
            name: postApprovedTarget.name ?? undefined,
            defaultCashbookId: postApprovedTarget.account_id ?? null,
            attachments: postApprovedTarget.attachments ?? null,
            isCommission: isCommissionVoucher(postApprovedTarget),
          }}
          capability={{ isCustodian: posting.custodianBooks.length > 0, canApprove: false }}
          cashbookOptions={posting.custodianBooks}
          cashbookError={posting.cashbookError}
          onRetryCashbooks={posting.retryCashbooks}
          expectedExecutionRevision={0}
          expectedApprovalVersion={postApprovedTarget.approval_version ?? 1}
          expectedPostingVersion={postApprovedTarget.posting_version ?? 1}
          onAdoptAttachments={adoptVoucherAttachmentsAsEvidence}
          onAttachEvidence={(file) =>
            posting.attachPostingEvidence(file, {
              voucherId: postApprovedTarget.id,
              userId: d.authUserId ?? "",
              organizationId: postApprovedTarget.organization_id,
            })
          }
          onRemoveAttachment={(url) => posting.removePostingAttachment(postApprovedTarget.id, url)}
          onUploadEvidence={(file) => uploadFinanceEvidence(file, postApprovedTarget.organization_id)}
          onSubmit={postApproved.submit}
          isSubmitting={postApproved.pending}
        />
      )}

      <AlertDialog open={!!unapprove.target} onOpenChange={(o) => { if (!o) unapprove.close(); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận huỷ duyệt phiếu</AlertDialogTitle>
            <AlertDialogDescription>
              Phiếu sẽ chuyển về trạng thái <b>Chờ duyệt</b> và không còn tính vào{" "}
              <b>tồn quỹ</b> cho đến khi duyệt lại. Dùng khi cần chỉnh sửa phiếu
              đã ghi nhận.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {d.actionError && <p role="alert" className="text-sm text-destructive">{d.actionError}</p>}
          {unapprove.needsReason && <CommissionReasonField id="unapproveTarget-reason" label="Lý do bỏ duyệt phiếu" value={unapprove.reason} onChange={unapprove.setReason} />}
          <AlertDialogFooter>
            <AlertDialogCancel>Đóng</AlertDialogCancel>
            <AlertDialogAction
              disabled={unapprove.pending}
              onClick={(event) => { event.preventDefault(); void unapprove.confirm(); }}
              className="bg-amber-600 hover:bg-amber-700"
            >
              Huỷ duyệt
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!cancelBatch.target} onOpenChange={(o) => { if (!o) cancelBatch.close(); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận huỷ cả đợt</AlertDialogTitle>
            <AlertDialogDescription>
              Hệ thống sẽ huỷ từng phiếu trong đợt và báo số phiếu hoàn tất. Nếu một phiếu chưa huỷ được, hãy kiểm tra kết quả từng phiếu trước khi tiếp tục. Lịch sử vẫn được giữ.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {d.actionError && <p role="alert" className="text-sm text-destructive">{d.actionError}</p>}
          <CommissionReasonField id="cancel-batch-reason" label="Lý do huỷ cả đợt" value={cancelBatch.reason} onChange={cancelBatch.setReason} />
          <AlertDialogFooter>
            <AlertDialogCancel>Đóng</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => { event.preventDefault(); void cancelBatch.confirm(); }}
              className="bg-red-600 hover:bg-red-700"
            >
              Huỷ cả đợt
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default VoucherActionDialogs;
