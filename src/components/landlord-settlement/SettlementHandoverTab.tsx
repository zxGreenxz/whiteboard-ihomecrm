// Tab "Bàn giao" của Quyết toán vận hành v3: ghi chú bàn giao của quản lý (sửa được sau khi chốt) và xác
// nhận "đã xem số liệu" của chủ nhà trên link /qt/:token. Cả hai gắn với ĐÚNG lần chốt đang hiện
// (closed.revision): bên quản lý mở chốt / chốt lại thì server từ chối (40001) và trang nạp lại.
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useConfirmLandlordMonth, useUpdateLandlordHandoverNote } from '@/hooks/useLandlordSettlement';
import {
  HANDOVER_NOTE_MAX,
  LANDLORD_CONFIRM_NOTE_MAX,
  landlordErrorMessage,
  monthLabel,
  monthToDate,
  vnDateTime,
  type SettlementMonth,
} from '@/lib/landlordSettlement';
import { Eyebrow, SectionCard } from './SettlementParts';

const errCode = (e: unknown) => (e && typeof e === 'object' ? (e as { code?: unknown }).code : undefined);

/** Màn quản trị, tháng đã chốt: sửa ghi chú bàn giao của lần chốt `revision`. */
function AdminNoteEditor({ month, buildingId, revision }: { month: SettlementMonth; buildingId: string; revision: number }) {
  const saved = month.closed?.note ?? '';
  const [draft, setDraft] = useState(saved);
  // ghi chú server mà ô đang dựa vào: người khác chốt lại / sửa ghi chú (lần chốt đổi) ⇒ chưa gõ gì thì nạp
  // ghi chú mới, đã gõ thì giữ chữ đang gõ (không âm thầm ghi đè ghi chú mới bằng ghi chú cũ)
  const [base, setBase] = useState(saved);
  if (saved !== base) {
    setBase(saved);
    if (draft === base) setDraft(saved);
  }
  const [error, setError] = useState<string | null>(null);
  const save = useUpdateLandlordHandoverNote();
  const changed = draft.trim() !== saved.trim();
  const tooLong = draft.trim().length > HANDOVER_NOTE_MAX;

  const submit = async () => {
    if (!changed || tooLong || save.isPending) return;
    setError(null);
    try {
      const r = await save.mutateAsync({
        buildingId, month: monthToDate(month.period_month), revision, note: draft.trim() || null,
      });
      if (r.status === 'UNCHANGED') toast.info('Ghi chú bàn giao không đổi');
      else toast.success('Đã lưu ghi chú bàn giao');
    } catch (e) {
      const msg = landlordErrorMessage(e, 'Chưa lưu được ghi chú bàn giao');
      setError(errCode(e) === '40001' ? `${msg} Trang đang nạp lại số mới.` : msg);
    }
  };

  return (
    <div className="space-y-2">
      <Textarea id="qt-handover-note" aria-label="Ghi chú bàn giao của quản lý" rows={5} maxLength={HANDOVER_NOTE_MAX}
        value={draft} onChange={(e) => setDraft(e.target.value)}
        placeholder="Ghi những điểm chủ nhà cần biết trong tháng" />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-muted-foreground">
          Chủ nhà đọc được ghi chú này trên link quyết toán. {draft.trim().length}/{HANDOVER_NOTE_MAX}
          {month.closed?.note_updated_at && <> · sửa lúc {vnDateTime(month.closed.note_updated_at)}</>}
        </p>
        <Button type="button" size="sm" onClick={submit} disabled={!changed || tooLong || save.isPending}>
          {save.isPending ? 'Đang lưu…' : 'Lưu ghi chú'}
        </Button>
      </div>
      {error && <p role="alert" className="rounded-md border border-destructive/40 p-2 text-sm text-destructive">{error}</p>}
    </div>
  );
}

/** Link chủ nhà, tháng đã chốt chưa xác nhận: ghi chú (không bắt buộc) + nút xác nhận. */
function LandlordConfirmForm({ month, token, revision, disabled }: {
  month: SettlementMonth; token: string; revision: number; disabled: boolean;
}) {
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirmLandlordMonth();
  // chặn bấm đôi trước khi isPending kịp vẽ lại
  const dangGui = useRef(false);
  const tooLong = note.trim().length > LANDLORD_CONFIRM_NOTE_MAX;

  const submit = async () => {
    if (dangGui.current || tooLong || disabled) return;
    dangGui.current = true;
    setError(null);
    try {
      const r = await confirm.mutateAsync({ token, month: monthToDate(month.period_month), revision, note: note.trim() || null });
      // đã xác nhận từ trước (máy khác / bấm lại): server giữ xác nhận đầu, ghi chú lần này KHÔNG lưu — nói rõ
      if (r.status === 'ALREADY_CONFIRMED') {
        toast.info(`Tháng này đã được xác nhận trước đó lúc ${vnDateTime(r.confirmed_at)} — ghi chú lần này không được lưu.`);
      } else {
        toast.success(`Đã xác nhận đã xem số liệu ${monthLabel(month.period_month).toLowerCase()}`);
      }
    } catch (e) {
      setError(errCode(e) === '40001'
        ? 'Bên quản lý vừa mở chốt hoặc chốt lại tháng này — trang đang tải lại số mới, xem lại rồi xác nhận.'
        : landlordErrorMessage(e, 'Chưa xác nhận được'));
    } finally {
      dangGui.current = false;
    }
  };

  return (
    <div className="flex flex-col items-start gap-2.5">
      <p className="text-[12.5px] leading-relaxed text-foreground/80">
        Xem lại số liệu {monthLabel(month.period_month).toLowerCase()}. Nếu đúng, bấm xác nhận — bên quản lý sẽ thấy thời điểm bạn xác nhận.
      </p>
      <div className="w-full space-y-1.5">
        <Label htmlFor="qt-landlord-note">Ghi chú của chủ nhà (không bắt buộc)</Label>
        <Textarea id="qt-landlord-note" rows={3} maxLength={LANDLORD_CONFIRM_NOTE_MAX} value={note}
          onChange={(e) => setNote(e.target.value)} placeholder="Ví dụ: phòng 302 đã trả tiền mặt cho tôi" />
        <p className="text-[11px] text-muted-foreground">Bên quản lý đọc được ghi chú này cùng lúc với xác nhận.</p>
      </div>
      <Button type="button" size="lg" onClick={submit} disabled={confirm.isPending || tooLong || disabled}>
        {confirm.isPending ? 'Đang gửi…' : 'Xác nhận đã xem số liệu'}
      </Button>
      <p className="text-[11px] text-muted-foreground">Có điểm chưa đúng? Ghi vào ô trên hoặc báo bên quản lý trước khi xác nhận.</p>
      {error && <p role="alert" className="w-full rounded-md border border-destructive/40 p-2 text-sm text-destructive">{error}</p>}
    </div>
  );
}

export function SettlementHandoverTab({ month, mode, buildingId, token, busy = false }: {
  month: SettlementMonth;
  mode: 'admin' | 'public';
  /** Màn quản trị. */
  buildingId?: string;
  /** Link chủ nhà. */
  token?: string;
  /** Đang đổi tháng (số đang hiện là của tháng trước) — tạm khoá xác nhận. */
  busy?: boolean;
}) {
  const closed = month.status === 'CLOSED' ? month.closed : null;
  const conf = closed ? month.confirmation : null;
  const thang = monthLabel(month.period_month).toLowerCase();

  return (
    <SectionCard title={`Bàn giao ${thang}`} testId="settlement-handover"
      description="Ghi chú của bên quản lý và xác nhận của chủ nhà được lưu cùng bản chốt tháng.">
      <div className="grid gap-3.5 px-4 pb-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr))]">
        <div className="min-w-0">
          <Eyebrow className="mb-2">Ghi chú bàn giao của quản lý</Eyebrow>
          {mode === 'admin' ? (
            closed && buildingId
              // key theo THÁNG (không theo lần chốt): lỗi 40001 nạp lại lần chốt mới mà không mất chữ đang gõ
              ? <AdminNoteEditor key={month.period_month} month={month} buildingId={buildingId} revision={closed.revision} />
              : (
                <p className="rounded-[9px] border border-dashed p-3.5 text-center text-[12.5px] text-muted-foreground">
                  Ghi chú nhập khi chốt tháng (ô "Ghi chú" trong hộp Chốt tháng); sau khi chốt vẫn sửa được ở đây.
                </p>
              )
          ) : closed?.note ? (
            <p className="whitespace-pre-wrap rounded-[9px] border bg-muted/30 px-3 py-2.5 text-[12.5px] leading-relaxed" data-testid="settlement-handover-note">
              {closed.note}
            </p>
          ) : (
            <p className="rounded-[9px] border border-dashed p-3.5 text-center text-[12.5px] text-muted-foreground">
              {closed ? 'Bên quản lý không để lại ghi chú cho tháng này.' : 'Bên quản lý ghi chú khi chốt tháng.'}
            </p>
          )}
        </div>

        <div className="min-w-0">
          <Eyebrow className="mb-2">Xác nhận của chủ nhà</Eyebrow>
          {!closed ? (
            <div className="flex flex-col items-start gap-2.5">
              <p className="text-[12.5px] leading-relaxed text-muted-foreground">
                Tháng đang tạm tính, số liệu còn thay đổi. Chủ nhà xác nhận sau khi bên quản lý chốt tháng.
              </p>
              {mode === 'public' && <Button type="button" variant="outline" size="lg" disabled>Xác nhận đã xem số liệu</Button>}
            </div>
          ) : conf ? (
            <div className="flex items-start gap-2.5 rounded-[9px] border border-green-500/30 bg-green-50 px-3 py-2.5 text-green-800 dark:bg-green-950/40 dark:text-green-300"
              data-testid="settlement-confirmed">
              <CheckCircle2 className="mt-px h-[18px] w-[18px] shrink-0" aria-hidden />
              <div className="min-w-0">
                <p className="text-[13px] font-bold">{month.landlord_name} đã xác nhận đã xem số liệu {thang}</p>
                <p className="mt-0.5 text-xs">Lúc {vnDateTime(conf.confirmed_at)}</p>
                {conf.note && (
                  <div className="mt-2 rounded-lg border border-green-500/30 bg-card px-2.5 py-2 text-[12.5px] leading-normal text-foreground">
                    <Eyebrow className="mb-0.5">Ghi chú của chủ nhà</Eyebrow>
                    <p className="whitespace-pre-wrap">{conf.note}</p>
                  </div>
                )}
              </div>
            </div>
          ) : mode === 'public' && token ? (
            // key theo THÁNG: bên quản lý chốt lại (40001) thì form giữ ghi chú đang gõ, gửi lại với lần chốt mới
            <LandlordConfirmForm key={month.period_month} month={month} token={token} revision={closed.revision} disabled={busy} />
          ) : (
            <p className="flex items-start gap-2.5 rounded-[9px] border bg-slate-50 px-3 py-2.5 text-[12.5px] leading-normal text-slate-700 dark:bg-slate-900 dark:text-slate-300"
              data-testid="settlement-not-confirmed">
              <Clock className="mt-px h-4 w-4 shrink-0" aria-hidden />
              <span>Chủ nhà chưa xác nhận. Chủ nhà bấm xác nhận trên link quyết toán; thời điểm xác nhận hiện ở đây.</span>
            </p>
          )}
        </div>
      </div>
    </SectionCard>
  );
}
