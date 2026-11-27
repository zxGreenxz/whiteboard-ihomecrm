// Hộp CHỐT "Chi lợi nhuận cổ đông" của CHỦ (quyền chi lợi nhuận) — từ 18/11/2026 thay hộp nhập tay số tiền
// (lệnh chi cũ). Hộp "Chi tạm ứng cho tôi" của cổ đông tách sang ProfitSelfAdvanceDialog.tsx.
//
// Chủ chỉ chọn cổ đông và "Chốt đến hết tháng"; máy chủ tính (R5), KHÔNG có ô nhập số tiền:
//   Lợi nhuận chưa chi đến tháng đó − Khấu trừ tạm ứng (đã duyệt) = Thực chi.
//   Thực chi > 0 ⇒ chọn sổ quỹ + ngày chi; khối "Duyệt và Chi" bên dưới (19/11/2026, chủ chốt "gộp vào 1 màn hình
//     luôn Duyệt và Chi có ảnh phía dưới như bình thường"): MỘT nút lập phiếu chi (W2 lưu phiếu ở Chờ duyệt) rồi cùng
//     nick làm tiếp cho đúng phiếu đó — giữ sổ đã chọn ⇒ Duyệt và Chi kèm ảnh chứng từ (bắt buộc); không giữ sổ ⇒ chỉ
//     duyệt, người giữ sổ bấm Chi ở Thu chi (useOwnerPayoutPosting). Bước sau hỏng ⇒ phiếu ở Chờ duyệt, hộp nói đúng
//     trạng thái, "Làm tiếp" không lập phiếu thứ hai.
//   Thực chi = 0 ⇒ "Chốt, không ra tiền": không phiếu, có hiệu lực ngay ⇒ phải qua bước xác nhận.
// Gửi (W2) kèm ĐÚNG hai số đang hiện (phần ghi nhận + thực chi). Số liệu vừa đổi ⇒ máy chủ từ chối (PT409):
// hộp báo, tải lại xem trước, chủ xem số mới rồi tự bấm lại — KHÔNG tự gửi lại.
// Tháng mặc định là tháng máy chủ trả (tháng đủ điều kiện mới nhất). Tháng đó có thể không còn gì để chốt:
// hộp nói rõ và để chủ TỰ chọn tháng sớm hơn, không tự nhảy. Ngược lại, tháng chủ TỰ chọn mà xem trước lỗi (tháng
// không còn chốt được, hay lỗi bất kỳ) ⇒ hộp đưa về tháng mặc định của máy chủ và nói vì sao — không khoá ô tháng.
// Nhắc (không chặn): còn tạm ứng chờ duyệt (chưa được khấu trừ); cổ đông chưa có mốc "đã trả đủ" và chưa
// chốt lần nào (lần chốt đầu gom toàn bộ phần được chia từ đầu) ⇒ đặt mốc trước nếu tháng cũ đã trả ngoài app.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { AlertTriangle, Info, Loader2, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { QueryRegion, type RegionQuery } from '@/components/errors/QueryRegion';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { DateInput } from '@/components/ui/date-input';
import {
  Dialog, DIALOG_SCROLL_BODY, DIALOG_STICKY_FOOTER, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Textarea } from '@/components/ui/textarea';
import { useAccounts } from '@/hooks/useAccounts';
import { useProfitSettlementPreview, useShareholderProfitLedger } from '@/hooks/profit-ledger/useProfitLedgerQueries';
import {
  useSettleShareholderProfit, type SettleShareholderProfitInput, type SettleShareholderProfitResult,
} from '@/hooks/profit-ledger/useProfitLedgerMutations';
import {
  describeOwnerPayoutFailure, ownerPayoutCanResume, useOwnerPayoutPosting,
  type OwnerPayoutStep, type OwnerPayoutStepFailure, type OwnerPayoutTarget,
} from '@/hooks/profit-ledger/useOwnerPayoutPosting';
import { todayISO } from '@/lib/collect';
import { focusFirstError } from '@/lib/formErrors';
import { profitLedgerErrorMessage, type ProfitLedgerErrorInfo } from '@/lib/profitLedger/errors';
import { settleFormSchema, type SettleFormValues } from '@/lib/profitLedger/forms';
import type { ShareholderLedgerRow } from '@/lib/profitLedger/ledgerReaders';
import { profitPayoutAccounts } from '@/lib/profitLedger/payoutAccounts';
import type { ProfitSettlementRow, SettlementPreview } from '@/lib/profitLedger/positionReaders';
import {
  settleMonthLabel, settlementCashLabel, settlementVoidable, shouldRemindMarkerFirst,
} from '@/lib/profitLedger/positionView';
import { sameMoney } from '@/lib/profitLedger/readPrimitives';
import { profitLedgerRouteState } from '@/lib/profitLedger/route';
import { cancelTargetFromSettlement, type ProfitPayoutCancelTarget } from '@/lib/profitLedger/vouchers';
import { formatVND } from '@/lib/utils';
import {
  OWNER_PAYOUT_APPROVE_LABEL, OWNER_PAYOUT_POST_LABEL, OWNER_PAYOUT_RESUME_LABEL, OwnerPayoutPostingSection,
} from './OwnerPayoutPostingSection';
import { ProfitPayoutCancelDialog } from './ProfitPayoutCancelDialog';
import { ProfitSettlementVoidDialog, type ProfitSettlementVoidTarget } from './ProfitSettlementVoidDialog';

export interface ProfitDistributeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Công ty của cổ đông. */
  organizationId: string | null;
  /** Dòng sổ tổng (E1) trang đã có; không truyền thì hộp tự đọc E1 (cùng khoá query). */
  ledgerRows?: readonly ShareholderLedgerRow[];
  defaultShareholderId?: string | null;
  /** Bị chặn vì phiếu lương cần xem lại: trang mở sổ chi tiết để "Xác nhận phần lương". */
  onReviewSalary?: (shareholderId: string) => void;
  /** Lời nhắc "đặt mốc trước": trang mở hộp đặt mốc của cổ đông này. */
  onSetMarker?: (shareholderId: string) => void;
}

const emptyValues = (shareholderId: string): SettleFormValues => ({
  shareholderId, throughMonth: '', accountId: '', voucherDate: todayISO(), note: '', previewCash: 0,
});

const WARN_BOX = 'flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200';

/** Phiếu tiền của lần chốt đã lập (W2 xong) — bước Duyệt và Chi / Duyệt làm tiếp cho ĐÚNG phiếu này. */
interface CreatedPayout {
  target: OwnerPayoutTarget;
  code: string | null;
  /** Câu đầu của thông báo (số đã chốt). */
  head: string;
  accountName: string | null;
}

/** Câu đầu thông báo của một lần chốt đã ghi. */
function settledHead(result: SettleShareholderProfitResult, shareholderName: string | null): string {
  const who = shareholderName ? ` cho ${shareholderName}` : '';
  return `Đã chốt chi lợi nhuận đến hết ${settleMonthLabel(result.through_month)}${who}: ghi nhận ${formatVND(result.recognized_amount)} · khấu trừ tạm ứng ${formatVND(result.advance_offset_amount)} · thực chi ${formatVND(result.cash_amount)}.`;
}

export default function ProfitDistributeDialog({
  open, onOpenChange, organizationId, ledgerRows, defaultShareholderId, onReviewSalary, onSetMarker,
}: ProfitDistributeDialogProps) {
  const accountsQuery = useAccounts({ enabled: open });
  const ledgerQuery = useShareholderProfitLedger(open && !ledgerRows ? organizationId : null);
  const settleMut = useSettleShareholderProfit();
  // Khối "Duyệt và Chi": ảnh chứng từ, sổ người bấm giữ, bước sau cho phiếu vừa lập.
  const posting = useOwnerPayoutPosting(open, 'distribute');
  const dialogRef = useRef<HTMLDivElement>(null);
  const [failure, setFailure] = useState<ProfitLedgerErrorInfo | null>(null);
  // Lần chốt chưa rõ kết quả: giữ ĐÚNG nội dung đã gửi (và bước sau đã chọn) để "Kiểm tra lại" gửi lại y nguyên (cùng khoá).
  const [blocked, setBlocked] = useState<{ input: SettleShareholderProfitInput; step: OwnerPayoutStep | null; failure: ProfitLedgerErrorInfo } | null>(null);
  const saveBlocked = !!blocked;
  // W2 đã lập phiếu, bước sau chưa xong: khoá form (không chốt lại), chỉ còn "Làm tiếp" cho đúng phiếu này.
  const [created, setCreated] = useState<CreatedPayout | null>(null);
  const [stepFailure, setStepFailure] = useState<OwnerPayoutStepFailure | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  // Đang chờ ảnh tải / đang làm bước sau.
  const [finishing, setFinishing] = useState(false);
  const formLocked = saveBlocked || !!created;
  const busy = settleMut.isPending || finishing || posting.pending;
  // Tháng chủ TỰ chọn; null = để máy chủ chọn tháng đủ điều kiện mới nhất.
  const [pickedMonth, setPickedMonth] = useState<string | null>(null);
  // Tháng tự chọn vừa bị đưa về mặc định vì xem trước lỗi: câu báo cạnh ô tháng.
  const [monthReset, setMonthReset] = useState<string | null>(null);
  // Lần chốt không ra tiền đang chờ chủ xác nhận.
  const [confirmInput, setConfirmInput] = useState<SettleShareholderProfitInput | null>(null);
  const [voidTarget, setVoidTarget] = useState<ProfitSettlementVoidTarget | null>(null);
  const [cancelTarget, setCancelTarget] = useState<ProfitPayoutCancelTarget | null>(null);

  const initialShareholder = defaultShareholderId ?? '';
  const form = useForm<SettleFormValues>({ resolver: zodResolver(settleFormSchema), defaultValues: emptyValues(initialShareholder) });
  const { reset } = form;

  // Mở lại hộp: làm mới form — CHỈ ở lúc hộp vừa MỞ (đóng → mở), và TRỪ khi lần trước chưa rõ kết quả (giữ nguyên để
  // đối chiếu đúng nội dung). Gỡ khoá trong lúc hộp đang mở (lượt "Kiểm tra lại kết quả" chứng minh chưa ghi, hay đối
  // chiếu xong theo nhánh khác) KHÔNG phải lúc mở: giữ nguyên câu báo, cổ đông, tháng, sổ quỹ, ngày, ghi chú đang nhập.
  const wasOpen = useRef(false);
  useEffect(() => {
    const justOpened = open && !wasOpen.current;
    wasOpen.current = open;
    if (justOpened && !saveBlocked) {
      reset(emptyValues(initialShareholder));
      setPickedMonth(null);
      setMonthReset(null);
      setFailure(null);
      setConfirmInput(null);
      setCreated(null);
      setStepFailure(null);
      setEvidenceError(null);
    }
  }, [open, saveBlocked, initialShareholder, reset]);

  const values = useWatch({ control: form.control });
  const shareholderId = values.shareholderId ?? '';
  const accountId = values.accountId ?? '';
  // Phiếu đã lập (bước sau đang dở): giữ nguyên số đang hiện, không tính lại theo số mới của máy chủ.
  const previewQuery = useProfitSettlementPreview({
    shareholderId: shareholderId || null,
    throughMonth: pickedMonth,
    accountId: accountId || null,
    enabled: open && !formLocked,
  });
  // Số để HIỆN: lần xem trước của đúng cổ đông và đúng tháng đang chọn (lúc đang tải lại vì đổi sổ quỹ vẫn giữ
  // số cũ để các ô không chớp tắt). Số để GỬI: còn phải tải xong, không lỗi, không phải số giữ tạm.
  const preview: SettlementPreview | null = useMemo(() => {
    const data = previewQuery.data;
    if (!data || data.shareholder_id !== shareholderId) return null;
    if (pickedMonth !== null && data.through_month !== pickedMonth) return null;
    return data;
  }, [previewQuery.data, shareholderId, pickedMonth]);
  const previewCurrent = !!preview && !previewQuery.isFetching && !previewQuery.isError && !previewQuery.isPlaceholderData;

  // Tháng TỰ CHỌN mà xem trước lỗi: tháng không còn chốt được (22023 PROFIT_LEDGER_SETTLE_MONTH), hoặc lỗi khác mà
  // CHƯA từng có số của đúng cổ đông + tháng đó (ô tháng khoá, chủ kẹt) ⇒ đưa về tháng mặc định của máy chủ, nói vì sao.
  // Một lượt TẢI LẠI lỗi khi đã có số của tháng đó (react-query giữ số cũ, realtime làm mới xem trước thường xuyên) KHÔNG
  // đổi tháng chủ đã chọn: số đang hiện giữ nguyên, nút gửi khoá tới khi "Tính lại" xong (previewCurrent).
  // Tháng mặc định cũng lỗi thì giữ khung lỗi có nút "Tính lại" như cũ (không còn tháng nào để lùi về).
  const pickedHasData = !!previewQuery.data && previewQuery.data.shareholder_id === shareholderId
    && previewQuery.data.through_month === pickedMonth;
  const pickedErrorKind = pickedMonth !== null && previewQuery.isError && !formLocked
    ? profitLedgerErrorMessage(previewQuery.error, 'preview').kind
    : null;
  const pickedFailed = pickedErrorKind !== null && (pickedErrorKind === 'SETTLE_MONTH' || !pickedHasData);
  const pickedError = pickedFailed ? previewQuery.error : null;
  useEffect(() => {
    if (!pickedFailed || pickedMonth === null) return;
    setMonthReset(`Đã quay về tháng mặc định vì không xem trước được tháng ${settleMonthLabel(pickedMonth)}. ${profitLedgerErrorMessage(pickedError, 'preview').message}`);
    setPickedMonth(null);
  }, [pickedFailed, pickedMonth, pickedError]);

  const through = preview?.through_month ?? null;
  const recognized = preview?.recognized_amount ?? null;
  const cash = preview?.cash_amount ?? null;
  const settleable = !!preview && through !== null && recognized !== null && recognized > 0 && cash !== null;
  const hasCash = settleable && cash !== null && cash > 0 && !sameMoney(cash, 0);
  const zeroCash = settleable && !hasCash;

  // Tháng và số thực chi của form đi theo lần xem trước đang hiện (máy chủ tính, không phải ô nhập).
  useEffect(() => {
    if (formLocked || !preview) return;
    const nextMonth = through ?? '';
    if (form.getValues('throughMonth') !== nextMonth) form.setValue('throughMonth', nextMonth, { shouldValidate: form.formState.isSubmitted });
    const nextCash = hasCash && cash !== null ? cash : 0;
    if (form.getValues('previewCash') !== nextCash) form.setValue('previewCash', nextCash, { shouldValidate: form.formState.isSubmitted });
  }, [preview, through, cash, hasCash, formLocked, form]);

  // Số mới đã tính xong: bỏ câu "đang tính" của lần bấm trước.
  useEffect(() => {
    if (previewCurrent) form.clearErrors('root.preview');
  }, [previewCurrent, form]);

  const ledgerData = ledgerQuery.data;
  // Chỉ cổ đông còn hiệu lực mới chốt được (đã xoá / ngưng ⇒ máy chủ từ chối).
  const shareholderOptions = useMemo(() => (ledgerRows ?? ledgerData?.shareholders ?? [])
    .filter((row) => !row.is_deleted && row.is_active)
    .map((row) => ({ value: row.shareholder_id, label: row.name })), [ledgerRows, ledgerData]);
  const shareholderName = shareholderOptions.find((option) => option.value === shareholderId)?.label ?? null;

  // Phiếu chi tiền của lần chốt do chủ lập: mọi sổ TIỀN THẬT của đúng công ty, không bao giờ sổ ảo.
  const payoutAccounts = useMemo(() => profitPayoutAccounts({
    mode: 'OWNER', organizationId, accounts: accountsQuery.data ?? [],
  }), [organizationId, accountsQuery.data]);

  // Danh sách tháng lấy từ lần xem trước gần nhất CỦA ĐÚNG cổ đông đang chọn — kể cả số giữ tạm trong lúc tải tháng vừa
  // chọn (danh sách tháng không đổi theo tháng xem), để ô tháng không khoá chớp. Chỉ dùng để chọn tháng: số để hiện /
  // gửi vẫn là `preview` (đúng tháng, đã tải xong).
  const monthSource = previewQuery.data && previewQuery.data.shareholder_id === shareholderId ? previewQuery.data : null;
  const monthOptions = useMemo(() => {
    if (!monthSource) return [];
    return monthSource.months
      .filter((m) => m.selectable || m.month === monthSource.through_month)
      .sort((a, b) => (a.month < b.month ? 1 : -1))
      .map((m) => ({
        value: m.month,
        label: m.selectable ? `Hết tháng ${settleMonthLabel(m.month)}` : `Hết tháng ${settleMonthLabel(m.month)} — không còn gì để chốt`,
      }));
  }, [monthSource]);
  const otherSelectable = !!preview && preview.months.some((m) => m.selectable && m.month !== preview.through_month);

  // Route biết từ lần xem trước (R5) hoặc sổ tổng (E1) hộp tự đọc; chưa biết thì chưa khoá theo route.
  const routeSource = preview?.route ?? ledgerData?.route;
  const routeState = profitLedgerRouteState(routeSource);
  const blockedByRoute = (routeSource !== undefined && !routeState.canPayShareholder) || preview?.blocked_reason === 'ROUTE';
  const reviewCount = preview?.position.needs_review.count ?? 0;
  const blockedByReview = preview?.blocked_reason === 'SALARY_REVIEW_PENDING' || reviewCount > 0;
  const blockedOther = preview?.blocked_reason === 'OTHER';
  // Chưa chọn cổ đông thì nút vẫn bấm được để form chỉ đúng ô còn thiếu.
  const locked = !organizationId || blockedByRoute || blockedByReview || blockedOther || (!!preview && !settleable);

  const sources: readonly RegionQuery[] = [accountsQuery, ...(!ledgerRows ? [ledgerQuery] : [])];

  const payoutAccountName = (id: string | null) => payoutAccounts.find((account) => account.id === id)?.name ?? null;

  /**
   * Bước sau cho phiếu vừa lập (W2 đã lưu phiếu ở Chờ duyệt): Duyệt và Chi (giữ sổ, kèm ảnh) hoặc chỉ Duyệt. Xong thì
   * nói đúng trạng thái thật rồi đóng; hỏng thì phiếu nằm ở bước đã tới, hộp giữ phiếu đó để "Làm tiếp".
   */
  const finish = async (next: CreatedPayout) => {
    setStepFailure(null);
    setFinishing(true);
    const posted = next.target.step === 'APPROVE_AND_POST';
    const voucher = next.code ? `Phiếu ${next.code}` : 'Phiếu chi';
    const book = next.accountName ? `sổ ${next.accountName}` : 'sổ quỹ đã chọn';
    try {
      const outcome = await posting.complete(next.target);
      setCreated(null);
      if (outcome === 'POSTED') toast.success(`${next.head} ${voucher} đã duyệt và chi từ ${book}.`);
      else if (posted) toast.success(`${next.head} ${voucher} đã được duyệt — bấm Chi (kèm ảnh chứng từ) ở Thu chi để chi tiền.`);
      else toast.success(`${next.head} ${voucher} đã duyệt — người giữ ${book} bấm Chi (kèm ảnh chứng từ) ở Thu chi.`);
      onOpenChange(false);
    } catch (error) {
      const failure = describeOwnerPayoutFailure(error, next.target.step);
      if (failure.kind === 'APPROVE_ONLY') {
        // Máy chủ không cho chính người nhận chi (quyền chi không phủ cả công ty): giao dịch lùi cả bước duyệt ⇒ làm tiếp
        // chỉ Duyệt, người giữ sổ khác bấm Chi.
        setCreated({ ...next, target: { ...next.target, step: 'APPROVE' } });
        setStepFailure({ ...failure, message: `${failure.message} Bấm “${OWNER_PAYOUT_RESUME_LABEL}” để chỉ duyệt.` });
      } else {
        // Từ chối vì quyền / chưa rõ kết quả ⇒ khoá "Làm tiếp" (gửi lại vẫn y lỗi), chỉ đường sang Thu chi.
        setStepFailure(failure);
      }
      toast.warning(`${next.head} ${voucher} đã lập, đang chờ duyệt — chưa ${posted ? 'duyệt và chi' : 'duyệt'} được.`);
    } finally {
      setFinishing(false);
    }
  };

  /** `step`: bước sau đã chọn lúc bấm (null = lần chốt không ra tiền). */
  const send = async (input: SettleShareholderProfitInput, shownOffset: number | null, step: OwnerPayoutStep | null) => {
    if (settleMut.isPending) return;
    setFailure(null);
    let result: SettleShareholderProfitResult;
    try {
      result = await settleMut.mutateAsync(input);
    } catch (error) {
      const info = profitLedgerErrorMessage(error, 'settle');
      setFailure(info);
      if (info.kind === 'UNKNOWN_OUTCOME') {
        setBlocked({ input, step, failure: info });
        return;
      }
      setBlocked(null);
      // Tháng không còn chốt được: quay về tháng máy chủ chọn.
      if (info.kind === 'SETTLE_MONTH') setPickedMonth(null);
      // Số liệu vừa đổi (PT409…): tải lại xem trước — chủ xem số mới rồi tự bấm lại, KHÔNG tự gửi lại.
      if (info.reload) void previewQuery.refetch();
      return;
    }
    setBlocked(null);
    const head = settledHead(result, shareholderName);
    // Máy chủ so-rồi-ghi trên hai số đã gửi nên không lệch; nếu biên nhận vẫn khác số đã hiện thì nói ra, không im lặng.
    if (!sameMoney(result.recognized_amount, input.expectedRecognized) || !sameMoney(result.cash_amount, input.expectedCash)
        || (shownOffset !== null && !sameMoney(result.advance_offset_amount, shownOffset))) {
      toast.warning('Số máy chủ vừa ghi khác số đang hiện lúc bấm — mở lại hộp chốt để xem số đã ghi.');
    }
    if (!result.voucher_id) {
      toast.success(`${head} Không ra tiền — có hiệu lực ngay.`);
      onOpenChange(false);
      return;
    }
    if (!step || !input.accountId || !input.voucherDate) {
      // Người bấm không duyệt được (thiếu quyền duyệt thu chi): chỉ lập phiếu, nói đúng trạng thái phiếu.
      toast.success(`${head} ${result.code ? `Phiếu ${result.code}` : 'Phiếu chi'} chờ duyệt, chưa chi tiền.`);
      onOpenChange(false);
      return;
    }
    const next: CreatedPayout = {
      target: { voucherId: result.voucher_id, organizationId: input.organizationId, accountId: input.accountId, postedOn: input.voucherDate, step },
      code: result.code,
      head,
      accountName: payoutAccountName(input.accountId),
    };
    setCreated(next);
    await finish(next);
  };

  /**
   * Giữ sổ (Duyệt và Chi): phải có ảnh chứng từ, ảnh đang tải thì chờ xong — như hộp Duyệt và Chi của Thu chi.
   * true = đi tiếp được.
   */
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

  /** "Làm tiếp": bước sau cho ĐÚNG phiếu đã lập — không chốt lại, không lập phiếu thứ hai. */
  const resume = async () => {
    if (!created || busy || !ownerPayoutCanResume(stepFailure)) return;
    if (created.target.step === 'APPROVE_AND_POST' && !(await evidenceReady(OWNER_PAYOUT_RESUME_LABEL))) return;
    await finish(created);
  };

  const submit = async (data: SettleFormValues) => {
    if (busy || formLocked || !organizationId) return;
    setFailure(null);
    form.clearErrors('root');
    // Chỉ gửi theo số đã tính XONG cho đúng cổ đông + tháng + sổ đang chọn (không gửi theo số cũ / đang tải lại).
    if (!previewCurrent || !preview || through === null || recognized === null || cash === null || !settleable) {
      form.setError('root.preview', {
        type: 'preview',
        message: previewQuery.isError
          ? 'Chưa tính được số chốt — bấm "Tính lại" rồi gửi.'
          : 'Đang tính số chốt — đợi kết quả rồi bấm lại.',
      });
      return;
    }
    if (!preview.can_submit) {
      form.setError('root.preview', { type: 'preview', message: 'Chưa chốt được theo số đang hiện — xem lý do ở trên rồi thử lại.' });
      return;
    }
    const input: SettleShareholderProfitInput = {
      organizationId,
      shareholderId: data.shareholderId,
      throughMonth: through,
      expectedRecognized: recognized,
      expectedCash: cash,
      accountId: hasCash ? data.accountId : null,
      voucherDate: hasCash ? data.voucherDate : null,
      note: data.note.trim() || null,
    };
    // Không ra tiền = có hiệu lực ngay, không ai duyệt ⇒ bắt một bước xác nhận.
    if (!hasCash) {
      setConfirmInput(input);
      return;
    }
    // Có tiền: bước sau theo sổ người bấm đang GIỮ (như hộp Chi) và quyền — giữ ⇒ Duyệt và Chi kèm ảnh; không ⇒ chỉ duyệt.
    const step = posting.stepFor(data.accountId);
    if (step === undefined) {
      form.setError('root.preview', {
        type: 'cashbook',
        message: posting.cashbooksError
          ? 'Chưa tải được danh sách sổ quỹ bạn đang giữ — bấm "Tải lại sổ quỹ" rồi gửi.'
          : 'Đang kiểm sổ quỹ bạn đang giữ — đợi một chút rồi bấm lại.',
      });
      return;
    }
    if (step === 'APPROVE_AND_POST' && !(await evidenceReady(OWNER_PAYOUT_POST_LABEL))) return;
    await send(input, preview.advance_offset_amount, step);
  };

  const onInvalid = (errors: unknown) => { void focusFirstError(errors, { root: dialogRef.current }); };
  const rootPreviewError = form.formState.errors.root?.preview?.message;
  const pending = busy;
  // Chỉ đang chờ ảnh tải thì vẫn đóng được (như hộp Thu/Chi): lượt bấm tự dừng, chưa gửi gì.
  const closeBlocked = busy && !posting.evidence.waiting;
  const selectedStep = posting.stepFor(accountId);
  const submitLabel = zeroCash ? 'Chốt, không ra tiền'
    : selectedStep === 'APPROVE' ? OWNER_PAYOUT_APPROVE_LABEL
    : selectedStep === null ? 'Lập phiếu chờ duyệt'
    : OWNER_PAYOUT_POST_LABEL;
  const settlements = preview?.settlements ?? [];
  const remindMarker = settleable && !!preview && shouldRemindMarkerFirst({ marker_month: preview.position.marker_month, settlements: preview.settlements });
  const pendingAdvance = settleable && !!preview && !sameMoney(preview.advance_pending, 0) ? preview.advance_pending : 0;
  // Phần lương đã trừ theo một phiếu tạm ứng còn CHỜ duyệt đang nằm trong tiền sắp chi (interface §8.1).
  const pendingAdvanceAtRisk = pendingAdvance > 0 && !!preview && preview.position.components.advance_overoffset > 0;

  const openSettlementAction = (row: ProfitSettlementRow) => {
    if (!organizationId) return;
    if (settlementVoidable(row)) {
      setVoidTarget({
        settlementId: row.id, organizationId, subjectName: shareholderName, throughMonth: row.through_month,
        recognizedAmount: row.recognized_amount, advanceOffsetAmount: row.advance_offset_amount,
      });
      return;
    }
    setCancelTarget(cancelTargetFromSettlement(row, { organizationId, subjectName: shareholderName }));
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => { if (!closeBlocked) onOpenChange(next); }}>
        {/* Khuôn hộp dài: giới hạn theo khung nhìn động + cuộn dọc, hàng nút dính đáy (điện thoại không mất tiêu đề / nút). */}
        <DialogContent ref={dialogRef} className={`sm:max-w-[560px] ${DIALOG_SCROLL_BODY}`}>
          <DialogHeader>
            <DialogTitle>Chi lợi nhuận cổ đông</DialogTitle>
            <DialogDescription>
              Chốt đến hết một tháng: máy tính số, khấu trừ tạm ứng đã duyệt; phần còn lại lập phiếu chi rồi Duyệt và Chi ngay
              trong hộp này.
            </DialogDescription>
          </DialogHeader>

          <QueryRegion label="sổ quỹ và sổ tổng lợi nhuận" queries={sources} skeleton="detail" rows={5}>
            {routeState.banner && blockedByRoute && (
              <p role="status" className={WARN_BOX}>
                <Info className="mt-0.5 h-4 w-4 shrink-0" />{routeState.banner}
              </p>
            )}
            <Form {...form}>
              <form onSubmit={form.handleSubmit(submit, onInvalid)} className="space-y-4" noValidate>
                <fieldset disabled={formLocked || pending} className="space-y-4">
                  <FormField control={form.control} name="shareholderId" render={({ field, fieldState }) => (
                    <FormItem>
                      <FormLabel>Cổ đông <span className="text-destructive">*</span></FormLabel>
                      <FormControl>
                        <SearchableSelect
                          name={field.name}
                          aria-invalid={!!fieldState.error}
                          value={field.value}
                          onValueChange={(next) => { field.onChange(next); setPickedMonth(null); setMonthReset(null); setFailure(null); }}
                          placeholder="Chọn cổ đông"
                          options={shareholderOptions}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />

                  {!!shareholderId && (
                    <FormField control={form.control} name="throughMonth" render={({ field, fieldState }) => (
                      <FormItem>
                        <FormLabel>Chốt đến hết tháng <span className="text-destructive">*</span></FormLabel>
                        <FormControl>
                          <SearchableSelect
                            name={field.name}
                            aria-invalid={!!fieldState.error}
                            value={field.value}
                            onValueChange={(next) => { field.onChange(next); setPickedMonth(next || null); setMonthReset(null); setFailure(null); }}
                            placeholder={preview && through === null ? 'Chưa có tháng nào chốt được' : 'Đang tìm tháng chốt được…'}
                            options={monthOptions}
                            searchable={false}
                            disabled={monthOptions.length === 0}
                          />
                        </FormControl>
                        <p className="text-xs text-muted-foreground">
                          Mặc định là tháng đã chốt lợi nhuận mới nhất. Chỉ chọn được tháng còn lợi nhuận chưa chi.
                        </p>
                        {monthReset && (
                          <p role="status" className="text-xs text-amber-800 dark:text-amber-300" data-testid="profit-settle-month-reset">{monthReset}</p>
                        )}
                        <FormMessage />
                      </FormItem>
                    )} />
                  )}

                  <SettlePreviewBox
                    loading={!!shareholderId && !preview && previewQuery.isFetching}
                    refreshing={!!preview && previewQuery.isFetching}
                    error={previewQuery.isError ? profitLedgerErrorMessage(previewQuery.error, 'preview').message : null}
                    onRetry={() => { void previewQuery.refetch(); }}
                    preview={preview}
                    otherSelectable={otherSelectable}
                    onReviewSalary={onReviewSalary && shareholderId ? () => onReviewSalary(shareholderId) : undefined}
                  />

                  {pendingAdvance > 0 && (
                    <p role="status" className={WARN_BOX} data-testid="profit-settle-pending-advance">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>
                        Còn {formatVND(pendingAdvance)} tạm ứng chờ duyệt — chưa được khấu trừ trong lần chốt này.
                        {pendingAdvanceAtRisk
                          ? ' Một phần tiền sắp chi có thể đang treo theo phiếu tạm ứng đó: nên duyệt hoặc từ chối phiếu trước khi chốt.'
                          : ' Muốn khấu trừ luôn thì duyệt phiếu tạm ứng trước rồi mới chốt.'}
                      </span>
                    </p>
                  )}

                  {remindMarker && (
                    <div role="status" className={WARN_BOX} data-testid="profit-settle-marker-reminder">
                      <Info className="mt-0.5 h-4 w-4 shrink-0" />
                      <div className="space-y-2">
                        <p>
                          Cổ đông này chưa có mốc "đã trả đủ" và chưa chốt lần nào: lần chốt này tính TOÀN BỘ phần được chia từ
                          đầu. Nếu các tháng cũ đã trả ngoài app thì đặt mốc trước rồi mới chốt.
                        </p>
                        {onSetMarker && shareholderId && (
                          <Button type="button" variant="outline" size="sm" onClick={() => onSetMarker(shareholderId)}>Đặt mốc trước</Button>
                        )}
                      </div>
                    </div>
                  )}

                  {hasCash && (
                    <>
                      <FormField control={form.control} name="accountId" render={({ field, fieldState }) => (
                        <FormItem>
                          <FormLabel>Chi từ sổ quỹ <span className="text-destructive">*</span></FormLabel>
                          <FormControl>
                            <SearchableSelect
                              name={field.name}
                              aria-invalid={!!fieldState.error}
                              value={field.value}
                              onValueChange={field.onChange}
                              placeholder="Chọn sổ quỹ nguồn"
                              options={payoutAccounts.map((account) => ({ value: account.id, label: account.name, keywords: account.code }))}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />

                      <FormField control={form.control} name="voucherDate" render={({ field, fieldState }) => (
                        <FormItem>
                          <FormLabel>Ngày chi <span className="text-destructive">*</span></FormLabel>
                          <FormControl>
                            <DateInput name={field.name} aria-invalid={!!fieldState.error} value={field.value} onChange={field.onChange} onBlur={field.onBlur} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </>
                  )}

                  {zeroCash && (
                    <p role="status" className="rounded-md border bg-muted/30 p-3 text-sm" data-testid="profit-settle-zero-cash">
                      Lần chốt này không ra tiền: toàn bộ phần lợi nhuận chưa chi được khấu trừ vào tạm ứng. Không lập phiếu chi,
                      không cần duyệt — có hiệu lực ngay.
                    </p>
                  )}

                  <FormField control={form.control} name="note" render={({ field, fieldState }) => (
                    <FormItem>
                      <FormLabel>Ghi chú</FormLabel>
                      <FormControl>
                        <Textarea {...field} rows={2} aria-invalid={!!fieldState.error} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                </fieldset>

                {/* Khối "Duyệt và Chi" bên dưới phần số liệu: cùng ô ảnh chứng từ với hộp Duyệt và Chi của Thu chi. */}
                {(hasCash || !!created) && (
                  <OwnerPayoutPostingSection
                    posting={posting}
                    accountId={created ? created.target.accountId : accountId}
                    accountName={created ? created.accountName : payoutAccountName(accountId)}
                    evidenceError={evidenceError}
                    disabled={pending || saveBlocked || (!!stepFailure && !ownerPayoutCanResume(stepFailure))}
                    created={created ? { code: created.code, step: created.target.step } : null}
                    stepFailure={stepFailure}
                  />
                )}

                {rootPreviewError && <p role="alert" className="text-sm text-destructive">{rootPreviewError}</p>}
                {failure && (
                  <div role="alert" className="space-y-2 rounded-md border border-destructive p-3 text-sm text-destructive" data-testid="profit-settle-failure">
                    <p>{failure.message}</p>
                    {failure.kind === 'SALARY_REVIEW_PENDING' && onReviewSalary && shareholderId && (
                      <Button type="button" variant="outline" size="sm" onClick={() => onReviewSalary(shareholderId)}>Xem lại phần lương</Button>
                    )}
                  </div>
                )}

                {settlements.length > 0 && (
                  <SettlementList
                    rows={settlements}
                    disabled={pending || formLocked || !organizationId}
                    onAction={openSettlementAction}
                    canCancelVoucher={(row) => !!organizationId && cancelTargetFromSettlement(row, { organizationId, subjectName: shareholderName }) !== null}
                  />
                )}

                {/* Hàng nút dính đáy hộp: thân dài (xem trước, nhắc, các lần chốt) cuộn, nút luôn thấy. */}
                <DialogFooter className={DIALOG_STICKY_FOOTER}>
                  <Button type="button" variant="outline" className="flex-1 sm:flex-none" disabled={closeBlocked} onClick={() => onOpenChange(false)}>Đóng</Button>
                  {saveBlocked ? (
                    // Đối chiếu: gửi lại ĐÚNG nội dung với khoá cũ — máy chủ trả biên nhận cũ nếu đã chốt.
                    <Button type="button" variant="secondary" className="flex-1 sm:flex-none" disabled={pending} onClick={() => { if (blocked) void send(blocked.input, null, blocked.step); }}>
                      {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Kiểm tra lại kết quả
                    </Button>
                  ) : created ? (
                    // Phiếu đã lập, bước sau dở: làm tiếp cho ĐÚNG phiếu đó (không chốt lại, không lập phiếu mới).
                    <Button type="button" className="flex-1 sm:flex-none" disabled={pending || !ownerPayoutCanResume(stepFailure)} onClick={() => { void resume(); }}>
                      {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{OWNER_PAYOUT_RESUME_LABEL}
                    </Button>
                  ) : (
                    <Button type="submit" className="flex-1 sm:flex-none" disabled={locked || pending}>
                      {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      {posting.evidence.waiting ? 'Đang chờ ảnh tải xong…' : submitLabel}
                    </Button>
                  )}
                </DialogFooter>
              </form>
            </Form>
          </QueryRegion>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!confirmInput} onOpenChange={(next) => { if (!next) setConfirmInput(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Chốt, không ra tiền?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmInput && (
                <>
                  Chốt chi lợi nhuận đến hết {settleMonthLabel(confirmInput.throughMonth)}{shareholderName ? ` cho ${shareholderName}` : ''}:
                  ghi nhận {formatVND(confirmInput.expectedRecognized)} và khấu trừ hết vào tạm ứng. Không lập phiếu chi, không cần
                  duyệt — có hiệu lực ngay. Muốn bỏ thì dùng "Huỷ chốt" (có lý do).
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Quay lại</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const input = confirmInput;
                setConfirmInput(null);
                if (input) void send(input, input.expectedRecognized, null);
              }}
            >
              Xác nhận chốt
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ProfitSettlementVoidDialog
        open={!!voidTarget}
        onOpenChange={(next) => { if (!next) setVoidTarget(null); }}
        target={voidTarget}
        onVoided={() => { void previewQuery.refetch(); }}
      />
      <ProfitPayoutCancelDialog
        open={!!cancelTarget}
        onOpenChange={(next) => { if (!next) setCancelTarget(null); }}
        target={cancelTarget}
        onCancelled={() => { void previewQuery.refetch(); }}
      />
    </>
  );
}

function SettlePreviewBox({ loading, refreshing, error, onRetry, preview, otherSelectable, onReviewSalary }: {
  loading: boolean;
  /** Đang tính lại (số đang hiện có thể đã cũ — chưa cho gửi). */
  refreshing: boolean;
  error: string | null;
  onRetry: () => void;
  preview: SettlementPreview | null;
  /** Còn tháng khác chọn được (khi tháng đang xem không còn gì để chốt). */
  otherSelectable: boolean;
  onReviewSalary?: () => void;
}) {
  if (error) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-destructive p-3 text-sm text-destructive">
        <span>{error}</span>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>Tính lại</Button>
      </div>
    );
  }
  if (loading) return <p className="text-sm text-muted-foreground"><Loader2 className="mr-1 inline h-4 w-4 animate-spin" />Đang tính số chốt…</p>;
  if (!preview) return null;
  const { through_month: through, recognized_amount: recognized, advance_offset_amount: offset, cash_amount: cash, advance_left: left } = preview;
  const reviewCount = preview.position.needs_review.count;
  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm" data-testid="profit-settle-preview">
      {refreshing && (
        <p className="text-muted-foreground"><Loader2 className="mr-1 inline h-4 w-4 animate-spin" />Đang tính lại…</p>
      )}
      {through === null || recognized === null ? (
        <p role="status" data-testid="profit-settle-nothing">
          Cổ đông chưa có tháng nào chốt chi được: cần tháng đã chốt lợi nhuận, sau mốc "đã trả đủ" và không trước lần chốt chi gần nhất.
        </p>
      ) : (
        // Không có khe cột (gap-x-0) — khoảng cách nằm trong ô số (pl-4): đường kẻ trên dòng "Thực chi" (viền của dt + dd)
        // chạy liền một nét qua hai cột.
        <dl className="grid grid-cols-[1fr_auto] gap-x-0 gap-y-1.5">
          <dt>Lợi nhuận chưa chi đến hết {settleMonthLabel(through)}</dt>
          <dd className={`pl-4 text-right font-mono font-semibold whitespace-nowrap${recognized < 0 ? ' text-destructive' : ''}`} data-testid="profit-settle-recognized">{formatVND(recognized)}</dd>
          {offset !== null && cash !== null ? (
            <>
              <dt>
                Khấu trừ tạm ứng
                <span className="block text-xs text-muted-foreground">
                  tạm ứng đang có {formatVND(preview.position.advance_outstanding)}{left !== null ? ` · còn lại sau chốt ${formatVND(left)}` : ''}
                </span>
              </dt>
              <dd className="pl-4 text-right font-mono font-semibold whitespace-nowrap" data-testid="profit-settle-offset">{sameMoney(offset, 0) ? formatVND(0) : `− ${formatVND(offset)}`}</dd>
              <dt className="border-t pt-1.5 font-medium">
                Thực chi
                <span className="flex items-center gap-1 text-xs font-normal text-muted-foreground"><Lock className="h-3 w-3" aria-hidden="true" />máy tính — không nhập tay</span>
              </dt>
              <dd className="border-t pl-4 pt-1.5 text-right font-mono text-base font-bold whitespace-nowrap" data-testid="profit-settle-cash">{formatVND(cash)}</dd>
            </>
          ) : (
            <dd className="col-span-2" role="status" data-testid="profit-settle-nothing">
              Luỹ kế đến hết tháng này không còn gì để chi.
              {otherSelectable ? ' Nếu muốn chốt đến một tháng sớm hơn thì tự chọn ở ô "Chốt đến hết tháng".' : ''}
            </dd>
          )}
        </dl>
      )}
      {reviewCount > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-destructive">
          <span>Còn {reviewCount} phiếu lương cần chủ xem lại phần lợi nhuận — xác nhận trước khi chốt chi.</span>
          {onReviewSalary && <Button type="button" variant="outline" size="sm" onClick={onReviewSalary}>Xem lại phần lương</Button>}
        </div>
      )}
    </div>
  );
}

function SettlementList({ rows, disabled, onAction, canCancelVoucher }: {
  rows: readonly ProfitSettlementRow[];
  disabled: boolean;
  onAction: (row: ProfitSettlementRow) => void;
  canCancelVoucher: (row: ProfitSettlementRow) => boolean;
}) {
  return (
    <div className="space-y-1.5" data-testid="profit-settle-list">
      <p className="text-sm font-medium">Các lần chốt còn hiệu lực</p>
      <ul className="divide-y rounded-md border text-sm">
        {rows.map((row) => {
          const voidable = settlementVoidable(row);
          const actionable = voidable || canCancelVoucher(row);
          return (
            <li key={row.id} data-testid={`profit-settle-row-${row.id}`} className={`flex items-start gap-2 px-3 py-2${row.excluded_by_marker ? ' opacity-60' : ''}`}>
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  Đến hết {settleMonthLabel(row.through_month)}
                  {row.excluded_by_marker && <span className="ml-1.5 rounded border px-1 text-[11px] font-normal text-muted-foreground">trước mốc</span>}
                </p>
                <p className="text-xs text-muted-foreground">
                  Ghi nhận {formatVND(row.recognized_amount)} · khấu trừ tạm ứng {formatVND(row.advance_offset_amount)} · thực chi {formatVND(row.cash_amount)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {settlementCashLabel(row)}{row.cash_voucher_code ? ` · phiếu ${row.cash_voucher_code}` : ''}
                </p>
              </div>
              {actionable && (
                <Button type="button" size="sm" variant="outline" className="h-7 shrink-0 px-2 text-xs" disabled={disabled} onClick={() => onAction(row)}>
                  {voidable ? 'Huỷ chốt' : 'Huỷ phiếu chi'}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
