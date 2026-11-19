// Khối "Duyệt và Chi" ở cuối hộp chốt chi lợi nhuận cổ đông / chi lương điều hành của chủ (19/11/2026): cùng ô ảnh
// chứng từ với hộp "Duyệt và Chi" của Thu chi (PostingEvidenceUpload). Người bấm GIỮ sổ quỹ đã chọn ⇒ cần ảnh, một nút
// là lập phiếu + duyệt + chi; không giữ sổ ⇒ chỉ duyệt, ô ảnh không hiện (người giữ sổ bấm Chi kèm ảnh ở Thu chi).
// Lượt trước đã lập phiếu mà bước sau chưa xong ⇒ nói đúng phiếu đang ở bước nào, nút "Làm tiếp" không lập phiếu mới.

import { AlertTriangle, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PostingEvidenceUpload } from '@/components/income-expenses/IncomeExpensePostingDialog';
import type { OwnerPayoutPosting, OwnerPayoutStep } from '@/hooks/profit-ledger/useOwnerPayoutPosting';
import { warmUploadConnection } from '@/lib/storage/resilientUpload';

/** Chữ nút gửi theo bước sau (ô ảnh nhắc đúng chữ này). */
export const OWNER_PAYOUT_POST_LABEL = 'Duyệt và Chi';
export const OWNER_PAYOUT_APPROVE_LABEL = 'Lập phiếu và duyệt';
export const OWNER_PAYOUT_RESUME_LABEL = 'Làm tiếp';

export interface OwnerPayoutCreated {
  code: string | null;
  step: OwnerPayoutStep;
}

export interface OwnerPayoutStepFailure {
  message: string;
  /** Chưa rõ kết quả bước sau ⇒ không làm tiếp ở hộp, đối chiếu phiếu ở Thu chi. */
  reconcile: boolean;
}

export interface OwnerPayoutPostingSectionProps {
  posting: OwnerPayoutPosting;
  /** Sổ quỹ đã chọn ('' = chưa chọn). */
  accountId: string;
  accountName: string | null;
  evidenceError: string | null;
  /** Đang gửi / đang bị khoá đối chiếu: khoá ô ảnh. */
  disabled: boolean;
  created: OwnerPayoutCreated | null;
  stepFailure: OwnerPayoutStepFailure | null;
}

const NOTE = 'flex gap-2 rounded-md border bg-muted/30 p-3 text-sm';

export function OwnerPayoutPostingSection({
  posting, accountId, accountName, evidenceError, disabled, created, stepFailure,
}: OwnerPayoutPostingSectionProps) {
  const { evidence } = posting;
  // Phiếu đã lập: bước sau quyết lúc bấm, giữ nguyên dù danh sách sổ / quyền vừa tải lại.
  const step = created ? created.step : posting.stepFor(accountId);
  const book = accountName ? `sổ ${accountName}` : 'sổ quỹ đã chọn';
  const codeText = created?.code ? `phiếu ${created.code}` : 'phiếu chi';

  return (
    <section className="space-y-2 rounded-md border p-3" data-testid="owner-payout-posting" aria-label="Duyệt và Chi">
      <p className="text-sm font-medium">Duyệt và Chi</p>

      {step === null ? (
        <p role="status" className={NOTE} data-testid="owner-payout-create-only">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Bạn chưa có quyền duyệt thu chi: hộp chỉ lập phiếu CHỜ DUYỆT — chủ khác duyệt ở Chờ duyệt.</span>
        </p>
      ) : posting.cashbooksError && !created ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          <span>Chưa tải được danh sách sổ quỹ bạn đang giữ — chưa biết chi luôn được hay chỉ duyệt.</span>
          <Button type="button" variant="outline" size="sm" onClick={posting.retryCashbooks}>Tải lại sổ quỹ</Button>
        </div>
      ) : !accountId ? (
        <p className="text-xs text-muted-foreground">
          Chọn sổ quỹ chi: sổ bạn đang giữ thì bấm một lần là lập phiếu, duyệt và chi (kèm ảnh chứng từ); sổ người khác giữ
          thì hộp lập phiếu và duyệt, người giữ sổ bấm Chi.
        </p>
      ) : step === undefined ? (
        <p className="text-xs text-muted-foreground">Đang kiểm sổ quỹ và quyền của bạn…</p>
      ) : step === 'APPROVE_AND_POST' ? (
        <div className="space-y-2" data-testid="owner-payout-evidence">
          <p className="text-xs text-muted-foreground">
            Bạn đang giữ {book}: bấm “{OWNER_PAYOUT_POST_LABEL}” là lập phiếu, duyệt và chi tiền khỏi sổ ngay. Cần ít nhất một
            ảnh chứng từ; ảnh chỉ gắn lên phiếu khi bấm nút — đóng hộp thì ảnh vừa tải bị xoá.
          </p>
          <p className="text-sm font-medium">Hình ảnh/chứng từ <span className="text-destructive">*</span></p>
          <PostingEvidenceUpload
            invalid={!!evidenceError}
            items={evidence.items}
            onFiles={evidence.addFiles}
            onRemove={evidence.remove}
            canRemove={(item) => item.addedNow}
            busy={false}
            adopting={false}
            disabled={disabled || evidence.waiting || evidence.committing}
            fallbackCount={evidence.fallbackCount}
            pendingChanges={false}
            confirmLabel={OWNER_PAYOUT_POST_LABEL}
            localPreviews={evidence.localPreviews}
            onLocalPreviewError={evidence.dropPreview}
            pendingUploads={evidence.pendingUploads}
            onRetryPending={evidence.retry}
            onRemovePending={evidence.removePending}
            uploadStats={evidence.uploadStats}
            onWarm={warmUploadConnection}
            pendingLocked={disabled || evidence.committing}
          />
          {evidenceError && <p role="alert" className="text-sm text-destructive" data-testid="owner-payout-evidence-error">{evidenceError}</p>}
        </div>
      ) : (
        <p role="status" className={NOTE} data-testid="owner-payout-approve-only">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Hộp chỉ DUYỆT: bạn không giữ {book} (hoặc quyền chi của bạn không phủ cả công ty). Bấm “{OWNER_PAYOUT_APPROVE_LABEL}”
            là lập phiếu và duyệt luôn; tiền chưa ra khỏi sổ — người giữ sổ bấm Chi (kèm ảnh chứng từ) ở Thu chi.
          </span>
        </p>
      )}

      {created && stepFailure && (
        <div role="alert" className="flex gap-2 rounded-md border border-destructive p-3 text-sm text-destructive" data-testid="owner-payout-step-failure">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-1">
            <p>
              Đã lập {codeText} — phiếu đang CHỜ DUYỆT, chưa {created.step === 'APPROVE_AND_POST' ? 'duyệt và chi' : 'duyệt'} được:{' '}
              {stepFailure.message}
            </p>
            <p>
              {stepFailure.reconcile
                ? 'Chưa rõ kết quả bước này — đóng hộp, mở phiếu ở Thu chi kiểm tra trạng thái trước khi làm tiếp.'
                : `Bấm “${OWNER_PAYOUT_RESUME_LABEL}” để thử lại cho đúng phiếu này (không lập phiếu mới). Phiếu cũng xử lý được ở Chờ duyệt / Thu chi.`}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
