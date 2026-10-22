// Các thao tác ghi của màn quyết toán: ghi nhận thanh toán, huỷ thanh toán, chốt tháng,
// mở chốt. Server là hàng rào thật; hộp thoại chỉ kiểm hình thức và hiện lỗi server.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
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
import { hasUnconfirmedResponse } from '@/lib/operationOutcome';
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

interface PaymentPayload { paidOn: string; direction: PaymentDirection; amount: number; note: string }
const samePayload = (a: PaymentPayload, b: PaymentPayload) =>
  a.paidOn === b.paidOn && a.direction === b.direction && a.amount === b.amount && a.note === b.note;

// Lần gửi CHƯA XÁC NHẬN (mạng rớt / treo — server có thể đã ghi), nhớ THEO TOÀ ở mức module: sống qua
// đóng hộp, đổi toà, rời trang. Đổi / thoát tài khoản thì trang nạp lại hẳn nên không sang tài khoản khác.
interface PendingPayment { payload: PaymentPayload; key: string }
const chuaXacNhan = new Map<string, PendingPayment>();
const ngheChuaXacNhan = new Set<() => void>();
function datChuaXacNhan(buildingId: string, v: PendingPayment | null) {
  if (v) chuaXacNhan.set(buildingId, v);
  else chuaXacNhan.delete(buildingId);
  ngheChuaXacNhan.forEach((f) => f());
}
function theoDoiChuaXacNhan(f: () => void) {
  ngheChuaXacNhan.add(f);
  return () => { ngheChuaXacNhan.delete(f); };
}
const ngayVn = (iso: string) => iso.split('-').reverse().join('/');
// Chỉ lỗi server trả MÃ (SQLSTATE / PGRST) mà không thuộc loại "chưa xác nhận" mới chắc chắn là chưa
// ghi. Lỗi đọc biên nhận (zod) xảy ra SAU khi server đã ghi ⇒ vẫn là chưa xác nhận.
function serverTuChoiHan(err: unknown): boolean {
  const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^([0-9A-Z]{5}|PGRST\d{3})$/.test(code) && !hasUnconfirmedResponse(err);
}

export function PaymentDialog({
  open, onOpenChange, buildingId, buildingName, suggestedDirection,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  buildingId: string;
  /** Nêu trong toast: kết quả có thể về khi người dùng đã sang toà khác. */
  buildingName: string;
  suggestedDirection: PaymentDirection;
}) {
  const add = useAddLandlordPayment();
  const [paidOn, setPaidOn] = useState('');
  const [direction, setDirection] = useState<PaymentDirection>(suggestedDirection);
  const [amount, setAmount] = useState<number>(Number.NaN);
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  // Gửi lại CÙNG nội dung với lần chưa xác nhận của toà này thì dùng lại khoá ⇒ server chỉ đọc lại kết
  // quả cũ, không ghi thêm.
  const pending = useSyncExternalStore(theoDoiChuaXacNhan, () => chuaXacNhan.get(buildingId) ?? null);
  const wasOpen = useRef(false);
  // hộp đang hiện gì (toà + nội dung): kết quả của một lần gửi chỉ đóng hộp / ghi lỗi vào hộp khi hộp
  // còn mở và đang hiện ĐÚNG khoản đó; còn lại báo bằng toast (đã đóng, sang toà khác, sửa thành khoản khác)
  const dangHien = useRef<{ buildingId: string; payload: PaymentPayload } | null>(null);
  useEffect(() => {
    dangHien.current = { buildingId, payload: { paidOn, direction, amount, note: note.trim() } };
  });
  const hienDungKhoan = (b: string, p: PaymentPayload) => {
    const h = dangHien.current;
    return wasOpen.current && h !== null && h.buildingId === b && samePayload(h.payload, p);
  };

  // Khởi tạo đúng MỘT lần mỗi lần mở (đóng → mở). Chiều gợi ý đổi khi dữ liệu nạp lại nền thì không xoá
  // số đang gõ. Còn một lần gửi chưa xác nhận của chính toà này thì điền lại đúng nội dung đó.
  useEffect(() => {
    if (open && !wasOpen.current) {
      if (pending) {
        setPaidOn(pending.payload.paidOn);
        setDirection(pending.payload.direction);
        setAmount(pending.payload.amount);
        setNote(pending.payload.note);
      } else {
        setPaidOn(vnToday());
        setDirection(suggestedDirection);
        setAmount(Number.NaN);
        setNote('');
      }
      setErrors({});
      setServerError(null);
    }
    wasOpen.current = open;
  }, [open, suggestedDirection, pending]);

  const requestClose = (next: boolean) => onOpenChange(next);

  const submit = async () => {
    const e: Record<string, string> = {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) e.paidOn = 'Chọn ngày thanh toán.';
    if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(amount)) e.amount = 'Nhập số tiền nguyên đồng lớn hơn 0.';
    if (note.trim().length > 500) e.note = 'Ghi chú tối đa 500 ký tự.';
    setErrors(e);
    setServerError(null);
    if (Object.keys(e).length > 0) return;
    const payload: PaymentPayload = { paidOn, direction, amount, note: note.trim() };
    const b = buildingId;
    const khoan = `${buildingName} — ${formatVND(payload.amount)} ngày ${ngayVn(payload.paidOn)}`;
    // khoá theo NỘI DUNG: giống lần chưa xác nhận thì dùng lại khoá cũ, khác thì là một khoản khác
    const key = pending && samePayload(pending.payload, payload) ? pending.key : crypto.randomUUID();
    // ghi lại lần gửi TRƯỚC khi chờ: đóng hộp giữa chừng (mạng treo) rồi mở lại vẫn dùng đúng khoá này
    datChuaXacNhan(b, { payload, key });
    const xoaNeuCuaMinh = () => { if (chuaXacNhan.get(b)?.key === key) datChuaXacNhan(b, null); };
    try {
      const r = await add.mutateAsync({
        buildingId: b, paidOn, direction, amount, note: payload.note || null, idempotencyKey: key,
      });
      xoaNeuCuaMinh();
      if (r.status === 'REPLAYED') toast.info(`${khoan}: khoản này đã được ghi trước đó — không ghi thêm`);
      else toast.success(`Đã ghi nhận thanh toán ${khoan}`);
      // đóng cả phiên mở lại đang hiện đúng khoản này (để nguyên thì bấm lại sẽ sinh khoá mới, ghi trùng);
      // hộp đã sửa thành khoản khác thì để nguyên cho người dùng ghi tiếp
      if (hienDungKhoan(b, payload)) onOpenChange(false);
    } catch (err) {
      const msg = landlordErrorMessage(err, 'Chưa ghi nhận được thanh toán');
      // server từ chối hẳn ⇒ chắc chắn chưa ghi, không còn gì "chưa xác nhận" để giữ khoá
      const chuaRo = !serverTuChoiHan(err);
      if (!chuaRo) xoaNeuCuaMinh();
      if (hienDungKhoan(b, payload)) setServerError(msg);
      // hộp đã đóng / đang mở cho toà khác / đã sửa sang khoản khác: vẫn phải báo, nêu đúng khoản
      else toast.error(`${khoan}: ${msg}`
        + (chuaRo ? ` Mở lại "Ghi nhận thanh toán" ở toà ${buildingName}: hộp điền sẵn khoản này, bấm Ghi nhận để thử lại (không ghi trùng).` : ''));
    }
  };

  return (
    <Dialog open={open} onOpenChange={requestClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Ghi nhận thanh toán quyết toán</DialogTitle>
          <DialogDescription>
            Khoản chủ nhà và quản lý đã chuyển cho nhau để tất toán. Chỉ ghi ở trang này — không sinh phiếu thu/chi.
            Đừng lập thêm phiếu chi/thu tính KQKD cho khoản này ở toà: phiếu đó sẽ bị tính là chi phí/doanh thu của toà.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {pending && !add.isPending && (
            <p className="rounded-md border border-amber-400 p-2 text-xs">
              Lần ghi trước chưa xác nhận được. Kiểm danh sách "Hai bên đã trả nhau" — chưa có thì bấm Ghi nhận với
              đúng nội dung này để thử lại (không ghi trùng). Sửa nội dung thì là một khoản mới.
            </p>
          )}
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
            <Label htmlFor="pay-note">Ghi chú <span className="font-normal text-muted-foreground">(chủ nhà xem được qua link)</span></Label>
            <Textarea id="pay-note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="vd: chủ nhà chuyển khoản quyết toán tháng 10" />
            {errors.note && <p className="text-xs text-destructive">{errors.note}</p>}
          </div>
          <ServerError message={serverError} />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => requestClose(false)}>Đóng</Button>
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
          <Label htmlFor="close-note">Ghi chú (không bắt buộc · chủ nhà xem được qua link)</Label>
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
