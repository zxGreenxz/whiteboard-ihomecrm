// =============================================
// ChangeCollectionMethodDialog — "Đổi hình thức thu" của MỘT dòng thu hoá đơn
// (đợt 1 sửa phiếu, chủ chốt 25/09/2026).
//
// Sổ đi theo hình thức: Tiền mặt = sổ tiền mặt riêng của NGƯỜI ĐÃ THU; Chuyển
// khoản / Thanh toán = danh sách sổ của toà (mặc định đứng đầu) giao với sổ người
// đã thu giữ/biết. Đổi qua lại được, kể cả đổi sổ trong cùng hình thức (vd
// MBHIEP ↔ TKHIEP). Không đổi số tiền, không đổi nợ hoá đơn. Mỗi lần đổi bắt lý do
// (≥ 8 ký tự) và được ghi vào lịch sử phiếu.
//
// Luật + quyền (người đã thu, chủ công ty, super admin) nằm ở máy chủ:
// get_receiving_cashbooks_v1 (danh sách sổ của người đã thu) và
// change_collection_tender_method_v1 (ghi). Hộp này chỉ bày đúng danh sách máy chủ
// trả và chặn sớm các ca chắc chắn bị từ chối (tiền thối, làm tròn, lý do ngắn).
//
// Dùng chung: hộp "Các lần thanh toán" của hoá đơn và màn Thu chi.
// =============================================

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, Loader2 } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  missingReceivingBookMessage,
  receivingBooksFor,
  useChangeCollectionTenderMethod,
  useReceivingCashbooks,
  type ReceivingMethod,
} from '@/hooks/useReceivingCashbooks';
import {
  tenderMethodChangeBlock,
  type ChangeCollectionMethodTender,
} from '@/hooks/useCollectionTenders';
import {
  newRevisionIdempotencyKey,
  PAYMENT_METHOD_LABELS,
  REVISION_REASON_MAX,
  REVISION_REASON_MIN,
} from '@/lib/incomeExpenseRevision';

export type { ChangeCollectionMethodTender };

export interface ChangeCollectionMethodDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  tender: ChangeCollectionMethodTender;
  onChanged?: () => void;
}

const METHODS: ReceivingMethod[] = ['TM', 'TK', 'TT'];

const isReceivingMethod = (m: string): m is ReceivingMethod =>
  (METHODS as string[]).includes(m);

const methodLabel = (m: string) => PAYMENT_METHOD_LABELS[m] ?? m;

const fmtVnd = (n: number) => `${new Intl.NumberFormat('vi-VN').format(Math.round(Number(n) || 0))} đ`;

/** Câu lỗi máy chủ đã viết sẵn bằng tiếng Việt; bỏ tiền tố máy-đọc kiểu [PROFIT_LOCKED]. */
const loiDoc = (error: unknown): string => {
  const msg = (error as { message?: unknown } | null)?.message;
  return typeof msg === 'string' && msg.trim()
    ? msg.replace(/^\[[A-Z_]+\]\s*/, '')
    : 'Không tải được danh sách sổ nhận tiền.';
};

export default function ChangeCollectionMethodDialog({
  open,
  onOpenChange,
  organizationId,
  tender,
  onChanged,
}: ChangeCollectionMethodDialogProps) {
  const queryClient = useQueryClient();
  const mutation = useChangeCollectionTenderMethod();

  const currentMethod: ReceivingMethod = isReceivingMethod(tender.paymentMethod) ? tender.paymentMethod : 'TM';
  const [method, setMethod] = useState<ReceivingMethod>(currentMethod);
  /** Sổ người dùng tự chọn trong danh sách ('' = chưa chọn → dùng sổ gợi ý). */
  const [pickedAccountId, setPickedAccountId] = useState('');
  const [reason, setReason] = useState('');
  // Khoá gọi lại ổn định cho CÙNG một nội dung: bấm lại sau khi mạng chập chờn thì
  // máy chủ trả kết quả cũ thay vì đổi thêm lần nữa; đổi nội dung thì khoá mới.
  const attemptRef = useRef<{ fingerprint: string; key: string } | null>(null);

  // Mỗi lần mở (hoặc đổi dòng thu) bắt đầu lại từ trạng thái hiện tại.
  useEffect(() => {
    if (!open) return;
    setMethod(currentMethod);
    setPickedAccountId('');
    setReason('');
    attemptRef.current = null;
  }, [open, tender.id, currentMethod]);

  const blockReason = tenderMethodChangeBlock(tender);
  const collectorKnown = !!tender.collectorUserId;
  // Sổ theo NGƯỜI ĐÃ THU (máy chủ chặn sổ ngoài danh sách của người đó), không
  // phải người đang bấm — chủ công ty đổi hộ thì vẫn là sổ của người thu.
  const books = useReceivingCashbooks(
    open && collectorKnown && !blockReason ? organizationId : null,
    tender.buildingId,
    tender.collectorUserId,
  );

  const list = useMemo(() => receivingBooksFor(books.data, method), [books.data, method]);
  const selectedAccountId = useMemo((): string | null => {
    if (method === 'TM') return list[0]?.id ?? null;
    if (pickedAccountId && list.some((b) => b.id === pickedAccountId)) return pickedAccountId;
    // Giữ hình thức cũ ⇒ gợi ý đúng sổ đang dùng; đổi hình thức ⇒ sổ mặc định.
    if (method === currentMethod && tender.accountId && list.some((b) => b.id === tender.accountId)) {
      return tender.accountId;
    }
    return list[0]?.id ?? null;
  }, [method, list, pickedAccountId, currentMethod, tender.accountId]);
  const selectedBook = list.find((b) => b.id === selectedAccountId) ?? null;

  const reasonLength = reason.trim().length;
  const reasonOk = reasonLength >= REVISION_REASON_MIN && reasonLength <= REVISION_REASON_MAX;
  const unchanged = method === currentMethod && !!selectedAccountId && selectedAccountId === tender.accountId;
  const booksLoading = !blockReason && collectorKnown && !books.data && !books.isError;

  // Chặn theo thứ tự người dùng cần biết trước.
  let chan: string | null = blockReason;
  if (!chan && !collectorKnown) chan = 'Chưa xác định được người đã thu khoản này — tải lại rồi thử lại.';
  if (!chan && books.isError) chan = loiDoc(books.error);
  const thieuSo = !chan && !!books.data && !selectedAccountId ? missingReceivingBookMessage(method, tender.buildingName) : null;

  const canSubmit =
    !chan && !booksLoading && !thieuSo && !!selectedAccountId && !unchanged && reasonOk && !mutation.isPending;

  const handleSubmit = async () => {
    if (!canSubmit || !selectedAccountId) return;
    const payload = { tenderId: tender.id, method, accountId: selectedAccountId, reason: reason.trim() };
    const fingerprint = JSON.stringify(payload);
    if (!attemptRef.current || attemptRef.current.fingerprint !== fingerprint) {
      attemptRef.current = { fingerprint, key: newRevisionIdempotencyKey('tender-method') };
    }
    try {
      await mutation.mutateAsync({ ...payload, idempotencyKey: attemptRef.current.key });
    } catch {
      // Hook đã báo lỗi bằng toast (câu tiếng Việt của máy chủ); giữ hộp mở để sửa.
      return;
    }
    // Các khoá màn hoá đơn / Thu tiền mà hook dùng chung không phủ tới.
    for (const queryKey of [
      ['invoice-payments-summary'],
      ['invoice-vouchers'],
      ['invoice-collectors'],
      ['handover-vouchers'],
    ]) {
      queryClient.invalidateQueries({ queryKey });
    }
    onChanged?.();
    onOpenChange(false);
  };

  const disabledAll = !!chan || mutation.isPending;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!mutation.isPending) onOpenChange(v); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowRightLeft className="h-5 w-5 text-violet-600" />
            Đổi hình thức thu
          </DialogTitle>
          <DialogDescription>
            Không đổi số tiền, không đổi nợ hoá đơn — chỉ chuyển khoản thu sang hình thức và sổ khác.
            Mỗi lần đổi được ghi vào lịch sử phiếu kèm lý do.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-md border bg-muted/40 p-3 text-sm space-y-1">
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">Số tiền</span>
              <span className="font-semibold">{fmtVnd(tender.amount)}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">Hiện tại</span>
              <span className="font-medium text-right">
                {methodLabel(tender.paymentMethod)} · {tender.accountName || 'Sổ không rõ'}
              </span>
            </div>
            {tender.buildingName && (
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Toà</span>
                <span>{tender.buildingName}</span>
              </div>
            )}
          </div>

          {chan && (
            <Alert variant="destructive">
              <AlertDescription>{chan}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <Label>Hình thức mới *</Label>
            <RadioGroup
              className="grid-cols-3"
              value={method}
              onValueChange={(v) => {
                if (!isReceivingMethod(v)) return;
                setMethod(v);
                setPickedAccountId('');
              }}
              disabled={disabledAll}
            >
              {METHODS.map((m) => (
                <Label
                  key={m}
                  htmlFor={`doi-hinh-thuc-${m}`}
                  className="flex cursor-pointer items-center gap-2 rounded-md border p-2 text-sm font-normal has-[[data-state=checked]]:border-violet-400 has-[[data-state=checked]]:bg-violet-50 has-[:disabled]:cursor-not-allowed"
                >
                  <RadioGroupItem id={`doi-hinh-thuc-${m}`} value={m} aria-label={methodLabel(m)} />
                  {methodLabel(m)}
                </Label>
              ))}
            </RadioGroup>
          </div>

          <div className="space-y-2">
            <Label>{method === 'TM' ? 'Sổ tiền mặt riêng của người thu' : 'Sổ nhận *'}</Label>
            {chan ? (
              <p className="text-sm text-muted-foreground">—</p>
            ) : booksLoading ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                <Loader2 className="h-4 w-4 animate-spin" />
                Đang tải danh sách sổ nhận tiền…
              </p>
            ) : thieuSo ? (
              <p className="text-sm text-red-600" role="alert">{thieuSo}</p>
            ) : method === 'TM' ? (
              <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm" aria-label="Sổ nhận">
                {selectedBook?.name}
              </div>
            ) : (
              <Select
                value={selectedAccountId ?? undefined}
                onValueChange={setPickedAccountId}
                disabled={disabledAll || list.length <= 1}
              >
                <SelectTrigger aria-label="Sổ nhận">
                  <SelectValue placeholder="Chọn sổ nhận" />
                </SelectTrigger>
                <SelectContent>
                  {list.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name}
                      {b.isDefault ? ' (mặc định)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {!chan && !booksLoading && !thieuSo && unchanged && (
              <p className="text-xs text-amber-700">
                Hình thức và sổ đang chọn trùng hiện tại — chọn hình thức hoặc sổ khác.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="ly-do-doi-hinh-thuc">Lý do đổi *</Label>
            <Textarea
              id="ly-do-doi-hinh-thuc"
              rows={3}
              maxLength={REVISION_REASON_MAX}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Vd: khách chuyển vào TKHIEP chứ không phải MBHIEP"
              disabled={disabledAll}
            />
            <p className={`text-xs ${reasonLength > 0 && !reasonOk ? 'text-red-600' : 'text-muted-foreground'}`}>
              Bắt buộc, ít nhất {REVISION_REASON_MIN} ký tự
              {reasonLength > 0 && reasonLength < REVISION_REASON_MIN
                ? ` (còn thiếu ${REVISION_REASON_MIN - reasonLength})`
                : ''}
              .
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            Huỷ
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={!canSubmit}>
            {mutation.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Đang đổi…
              </>
            ) : (
              'Đổi hình thức thu'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
