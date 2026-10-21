// Các thao tác ghi của màn quyết toán: ghi nhận thanh toán, huỷ thanh toán, chốt tháng,
// mở chốt. Server là hàng rào thật; hộp thoại chỉ kiểm hình thức và hiện lỗi server.
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { CurrencyInput } from '@/components/ui/currency-input';
import { DateInput } from '@/components/ui/date-input';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import {
  useAddLandlordPayment,
  useCloseLandlordMonth,
  useReopenLandlordMonth,
  useVoidLandlordPayment,
} from '@/hooks/useLandlordSettlement';
import {
  NET_DIRECTION_LABEL,
  PAYMENT_DIRECTION_LABEL,
  describeNet,
  landlordErrorMessage,
  monthLabel,
  type PaymentDirection,
  type SettlementMonth,
  type SettlementPayment,
} from '@/lib/landlordSettlement';
import { formatVND } from '@/lib/utils';

function vnToday(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function ServerError({ message }: { message: string | null }) {
  if (!message) return null;
  return <p role="alert" className="rounded-md border border-destructive/40 p-2 text-sm text-destructive">{message}</p>;
}

// ─────────────────────────────── thanh toán ───────────────────────────────

export function PaymentDialog({
  open, onOpenChange, buildingId, suggestedDirection,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  buildingId: string;
  suggestedDirection: PaymentDirection;
}) {
  const add = useAddLandlordPayment();
  const [paidOn, setPaidOn] = useState('');
  const [direction, setDirection] = useState<PaymentDirection>(suggestedDirection);
  const [amount, setAmount] = useState<number>(Number.NaN);
  const [note, setNote] = useState('');
  const [key, setKey] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPaidOn(vnToday());
    setDirection(suggestedDirection);
    setAmount(Number.NaN);
    setNote('');
    // Một khoá cho mỗi lần mở hộp thoại: bấm lại sau lỗi mạng không ghi trùng.
    setKey(crypto.randomUUID());
    setErrors({});
    setServerError(null);
  }, [open, suggestedDirection]);

  const submit = async () => {
    const e: Record<string, string> = {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) e.paidOn = 'Chọn ngày thanh toán.';
    if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(amount)) e.amount = 'Nhập số tiền nguyên đồng lớn hơn 0.';
    if (note.trim().length > 500) e.note = 'Ghi chú tối đa 500 ký tự.';
    setErrors(e);
    setServerError(null);
    if (Object.keys(e).length > 0) return;
    try {
      await add.mutateAsync({ buildingId, paidOn, direction, amount, note: note.trim() || null, idempotencyKey: key });
      toast.success('Đã ghi nhận thanh toán');
      onOpenChange(false);
    } catch (err) {
      setServerError(landlordErrorMessage(err, 'Chưa ghi nhận được thanh toán'));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Ghi nhận thanh toán quyết toán</DialogTitle>
          <DialogDescription>Khoản chủ nhà và quản lý đã chuyển cho nhau để tất toán. Chỉ ghi ở trang này — không sinh phiếu thu/chi.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <RadioGroup value={direction} onValueChange={(v) => setDirection(v as PaymentDirection)} className="gap-2">
            {(['LANDLORD_TO_MANAGER', 'MANAGER_TO_LANDLORD'] as const).map((d) => (
              <label key={d} className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm">
                <RadioGroupItem value={d} />{PAYMENT_DIRECTION_LABEL[d]}
              </label>
            ))}
          </RadioGroup>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="pay-date">Ngày</Label>
              <DateInput id="pay-date" value={paidOn} onChange={setPaidOn} />
              {errors.paidOn && <p className="text-xs text-destructive">{errors.paidOn}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pay-amount">Số tiền</Label>
              <CurrencyInput id="pay-amount" value={Number.isFinite(amount) ? amount : null} onChange={setAmount} />
              {errors.amount && <p className="text-xs text-destructive">{errors.amount}</p>}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pay-note">Ghi chú</Label>
            <Textarea id="pay-note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="vd: chủ nhà chuyển khoản quyết toán tháng 10" />
            {errors.note && <p className="text-xs text-destructive">{errors.note}</p>}
          </div>
          <ServerError message={serverError} />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Đóng</Button>
          <Button type="button" onClick={submit} disabled={add.isPending}>{add.isPending ? 'Đang ghi…' : 'Ghi nhận'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function VoidPaymentDialog({
  payment, onOpenChange,
}: {
  payment: SettlementPayment | null;
  onOpenChange: (open: boolean) => void;
}) {
  const voidPayment = useVoidLandlordPayment();
  const [reason, setReason] = useState('');
  const [serverError, setServerError] = useState<string | null>(null);
  useEffect(() => { setReason(''); setServerError(null); }, [payment]);

  const submit = async () => {
    if (!payment?.id) return;
    if (reason.trim().length < 8) { setServerError('Lý do huỷ từ 8 ký tự trở lên.'); return; }
    try {
      await voidPayment.mutateAsync({ paymentId: payment.id, reason: reason.trim() });
      toast.success('Đã huỷ khoản thanh toán');
      onOpenChange(false);
    } catch (err) {
      setServerError(landlordErrorMessage(err, 'Chưa huỷ được khoản thanh toán'));
    }
  };

  return (
    <Dialog open={!!payment} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Huỷ khoản thanh toán</DialogTitle>
          <DialogDescription>
            {payment ? `${PAYMENT_DIRECTION_LABEL[payment.direction]} ${formatVND(payment.amount)}. ` : ''}
            Khoản bị huỷ vẫn hiện (gạch ngang) để giữ vết.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="void-reason">Lý do huỷ</Label>
          <Textarea id="void-reason" rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <ServerError message={serverError} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Đóng</Button>
          <Button type="button" variant="destructive" onClick={submit} disabled={voidPayment.isPending}>
            {voidPayment.isPending ? 'Đang huỷ…' : 'Huỷ khoản này'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────── chốt / mở chốt ───────────────────────────────

export function CloseMonthDialog({
  open, onOpenChange, buildingId, month,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  buildingId: string;
  month: SettlementMonth;
}) {
  const close = useCloseLandlordMonth();
  const [note, setNote] = useState('');
  const [serverError, setServerError] = useState<string | null>(null);
  useEffect(() => { if (open) { setNote(''); setServerError(null); } }, [open]);

  const t = month.statement?.totals;
  const net = t ? describeNet(t.landlord_owes_manager) : null;

  const submit = async () => {
    if (!month.live_hash) { setServerError('Chưa đọc được số liệu mới nhất — tải lại màn rồi chốt.'); return; }
    if (note.trim().length > 1000) { setServerError('Ghi chú tối đa 1000 ký tự.'); return; }
    try {
      await close.mutateAsync({ buildingId, month: month.period_month.slice(0, 10), expectedHash: month.live_hash, note: note.trim() || null });
      toast.success(`Đã chốt ${monthLabel(month.period_month).toLowerCase()}`);
      onOpenChange(false);
    } catch (err) {
      setServerError(landlordErrorMessage(err, 'Chưa chốt được tháng'));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Chốt quyết toán {monthLabel(month.period_month).toLowerCase()}</DialogTitle>
          <DialogDescription>
            Chụp lại toàn bộ số của tháng. Phiếu đổi sau khi chốt sẽ được báo trên màn; muốn cập nhật phải mở chốt rồi chốt lại.
          </DialogDescription>
        </DialogHeader>
        {t && net && (
          <dl className="space-y-1 rounded-md border p-3 text-sm">
            <div className="flex justify-between"><dt>Lợi nhuận</dt><dd className="tabular-nums">{formatVND(t.profit)}</dd></div>
            <div className="flex justify-between"><dt>Phần quản lý</dt><dd className="tabular-nums">{formatVND(t.manager_share)}</dd></div>
            <div className="flex justify-between font-semibold"><dt>{NET_DIRECTION_LABEL[net.direction]}</dt><dd className="tabular-nums">{formatVND(net.amount)}</dd></div>
          </dl>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="close-note">Ghi chú (không bắt buộc)</Label>
          <Textarea id="close-note" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <ServerError message={serverError} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Đóng</Button>
          <Button type="button" onClick={submit} disabled={close.isPending}>{close.isPending ? 'Đang chốt…' : 'Chốt tháng'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ReopenMonthDialog({
  open, onOpenChange, buildingId, month,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  buildingId: string;
  month: SettlementMonth;
}) {
  const reopen = useReopenLandlordMonth();
  const [reason, setReason] = useState('');
  const [serverError, setServerError] = useState<string | null>(null);
  useEffect(() => { if (open) { setReason(''); setServerError(null); } }, [open]);

  const submit = async () => {
    if (reason.trim().length < 8) { setServerError('Lý do mở chốt từ 8 ký tự trở lên.'); return; }
    try {
      await reopen.mutateAsync({ buildingId, month: month.period_month.slice(0, 10), reason: reason.trim() });
      toast.success(`Đã mở chốt ${monthLabel(month.period_month).toLowerCase()}`);
      onOpenChange(false);
    } catch (err) {
      setServerError(landlordErrorMessage(err, 'Chưa mở chốt được tháng'));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Mở chốt {monthLabel(month.period_month).toLowerCase()}</DialogTitle>
          <DialogDescription>Tháng quay về tạm tính theo phiếu hiện tại. Lần chốt cũ vẫn được giữ trong lịch sử.</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="reopen-reason">Lý do mở chốt</Label>
          <Textarea id="reopen-reason" rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="vd: duyệt bổ sung phiếu chi sửa chữa tháng 10" />
        </div>
        <ServerError message={serverError} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Đóng</Button>
          <Button type="button" variant="destructive" onClick={submit} disabled={reopen.isPending}>
            {reopen.isPending ? 'Đang mở…' : 'Mở chốt'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
