import type { ReactNode } from 'react';
import { Loader2, Pencil, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { CurrencyInput } from '@/components/ui/currency-input';
import { NumberInput } from '@/components/ui/number-input';
import { DateInput } from '@/components/ui/date-input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { DiscountNoteTrigger } from '../DiscountNoteTrigger';
import {
  customLineAmount,
  formatVnd,
  formatVndSuffix,
  monthLabel,
  shortDay,
  type EntryItemType,
  type EntryStructuredField,
} from '@/lib/invoiceEntry';

type ExtraKind = Exclude<EntryItemType, 'RENT'>;
const EXTRA_KIND_LABEL: Record<ExtraKind, string> = {
  SERVICE: 'Dịch vụ',
  OTHER: 'Khác',
  PENALTY: 'Phạt',
  DISCOUNT: 'Giảm giá',
};
/** Chỉ hai loại thường dùng; Phạt/Giảm giá chỉ hiện khi dòng đã mang loại đó. */
const extraKinds = (kind: ExtraKind): ExtraKind[] =>
  kind === 'SERVICE' || kind === 'OTHER' ? ['SERVICE', 'OTHER'] : ['SERVICE', 'OTHER', kind];
import type { InvoiceEntryProps } from './types';
import { dueBadge } from './dueBadge';

const MUTED = 'text-[hsl(210_10%_45%)]';
const LINE = 'border-[hsl(210_20%_88%)]';
const LINE_SOFT = 'border-[hsl(210_20%_92%)]';
const FOCUS =
  'focus-visible:ring-2 focus-visible:ring-primary/35 focus-visible:ring-offset-0 focus-visible:border-primary';
const CELL_INPUT = cn('h-8 rounded-md px-2 text-right text-[13px] tabular-nums', LINE, FOCUS);
const TINY_LABEL = cn('text-[10px] font-bold uppercase tracking-[.06em]', MUTED);
const FIELD_LABEL = 'text-xs font-semibold text-[hsl(160_30%_18%)]';

function GridHead({ children, first }: { children: ReactNode; first?: boolean }) {
  return (
    <div
      className={cn(
        'px-2 py-1.5 text-right text-[10px] font-bold uppercase tracking-[.04em] text-slate-600',
        !first && 'border-l border-[hsl(210_20%_90%)]',
      )}
    >
      {children}
    </div>
  );
}

function Cell({
  changed,
  first,
  children,
}: {
  changed: boolean;
  first?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn('relative p-[5px]', !first && cn('border-l', LINE_SOFT))}>
      {children}
      {changed && (
        <div
          aria-hidden
          className="pointer-events-none absolute bottom-[1px] left-[5px] right-[5px] h-0.5 rounded bg-amber-500"
        />
      )}
    </div>
  );
}

function CurrentStat({ label, value, sub, last }: { label: string; value: string; sub?: string; last?: boolean }) {
  return (
    <div className={cn('px-[11px] py-2', !last && 'border-r border-[hsl(210_20%_93%)]')}>
      <div className={TINY_LABEL}>{label}</div>
      <div className="mt-0.5 text-sm font-semibold tabular-nums text-slate-500">{value}</div>
      {sub && <div className="mt-px text-[11px] tabular-nums text-slate-400">{sub}</div>}
    </div>
  );
}

/** Layout desktop của bộ nhập liệu hoá đơn — dựng theo "Hóa đơn - Sửa & Tạo lẻ.dc.html". */
export function InvoiceEntryDesktop(props: InvoiceEntryProps) {
  const {
    mode, ctl, header, current, selectors, selectorsNotice, duplicate, pricing, meterId, debt,
    creditBalance, defaultDepositAmount, ready, onResetAll, onCancel, footNote, submit,
    lockedDates, busy, reason, notice, validationError,
  } = props;
  const isEdit = mode === 'edit';
  const { v, totals, diff, kwh, deposit, extras, set } = ctl;
  const changed = (f: EntryStructuredField) => diff.fields.has(f);
  const due = dueBadge(v.due_date, isEdit);
  const delta = current ? totals.total - current.total : 0;
  const sel = selectors?.('desktop');
  const belowPaid = current?.paid != null && totals.total < current.paid;
  const blocker = totals.overDiscount
    ? 'Giảm trừ lớn hơn tạm tính cộng nợ cũ — giảm bớt số giảm trừ.'
    : belowPaid
      ? 'Tổng mới thấp hơn tiền đã thu — cần đảo giao dịch trong Lịch sử thanh toán trước khi điều chỉnh.'
      : null;

  const breakdown = [
    `Phòng ${formatVnd(totals.rent)}`,
    `Điện ${formatVnd(totals.electric)}`,
    `Nước ${formatVnd(totals.water)}`,
    `PDV ${formatVnd(totals.pdv)}`,
    totals.extras ? `Thu thêm ${formatVnd(totals.extras)}` : '',
    totals.deposit ? `Cọc ${formatVnd(totals.deposit)}` : '',
  ]
    .filter(Boolean)
    .join(' · ')
    + (v.discount_amount ? ` − Giảm trừ ${formatVnd(v.discount_amount)}` : '')
    + (v.previous_debt ? ` + Nợ cũ ${formatVnd(v.previous_debt)}` : '');

  return (
    <fieldset disabled={busy} className="m-0 min-w-0 border-0 p-0 text-foreground">
      {/* ===== Header ===== */}
      <div className={cn('border-b bg-gradient-to-b from-[hsl(152_20%_97%)] to-white px-[18px] pb-3 pt-[13px]', LINE_SOFT)}>
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex h-[26px] w-[26px] items-center justify-center rounded-[7px] bg-primary text-[13px] font-bold text-white">₫</div>
          <div className="text-base font-bold tracking-[-.01em]">{header.title}</div>
          <div className="rounded-md bg-[hsl(152_20%_93%)] px-2 py-[3px] text-xs font-bold tabular-nums text-[hsl(152_69%_25%)]">
            {header.invoiceNo}
          </div>
          <div className="flex-1" />
          <button
            type="button"
            aria-label="Đóng"
            onClick={onCancel}
            className={cn('flex h-7 w-7 items-center justify-center rounded-md hover:bg-[hsl(210_20%_94%)]', MUTED)}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {sel && (
          <div className="mt-[11px] grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.6fr)]">
            <div className="flex flex-col gap-[3px]">
              <span className={TINY_LABEL}>Toà nhà</span>
              {sel.building}
            </div>
            <div className="flex flex-col gap-[3px]">
              <span className={TINY_LABEL}>Phòng</span>
              {sel.room}
            </div>
            <div className="flex flex-col gap-[3px]">
              <span className={TINY_LABEL}>Hợp đồng *</span>
              {sel.contract}
            </div>
            {selectorsNotice && (
              <div className="flex items-start gap-2 rounded-[7px] border border-red-200 bg-red-50 px-[11px] py-2 text-xs leading-relaxed text-red-700 sm:col-span-3">
                <span className="font-bold">⚠</span>
                <span>{selectorsNotice}</span>
              </div>
            )}
          </div>
        )}

        <div className="mt-[11px] flex flex-wrap items-center gap-[7px] text-[13px]">
          <span className="inline-flex items-center gap-1.5 rounded-[7px] bg-[hsl(160_30%_12%)] px-[9px] py-[3px] font-bold tracking-[-.01em] text-white">
            {header.building || '—'}
            <span className="opacity-45">/</span>
            {header.room || '—'}
          </span>
          {header.rep && <span className="font-semibold">{header.rep}</span>}
          <span className="text-[hsl(210_16%_78%)]">·</span>
          <span className="text-[hsl(210_10%_40%)]">Kỳ</span>
          <span className="font-bold tabular-nums">{monthLabel(v.billing_month)}</span>
          <span className="text-[hsl(210_16%_78%)]">·</span>
          <span className="text-[hsl(210_10%_40%)]">PH</span>
          <span className="font-semibold tabular-nums">{shortDay(v.issue_date)}</span>
          <span className="text-[hsl(210_10%_55%)]">→</span>
          <span className="text-[hsl(210_10%_40%)]">Hạn</span>
          <span className="font-semibold tabular-nums">{shortDay(v.due_date)}</span>
          {due && (
            <span className={cn('rounded-[5px] px-[7px] py-0.5 text-[11px] font-bold', due.tone === 'danger' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700')}>
              {due.label}
            </span>
          )}
        </div>
        <div className="mt-[5px] text-[11px] text-[hsl(210_10%_52%)]">{header.lockNote}</div>
      </div>

      {/* ===== Hoá đơn hiện tại (chỉ đối chiếu) ===== */}
      {isEdit && current && (
        <div className={cn('mx-[18px] mt-3.5 overflow-hidden rounded-[9px] border bg-slate-50', LINE)}>
          <div className={cn('flex items-center gap-2 border-b bg-slate-100 px-[11px] py-[7px]', LINE_SOFT)}>
            <span className="text-[11px] font-bold uppercase tracking-[.05em] text-slate-500">Hoá đơn hiện tại</span>
            <span className="text-[11px] text-slate-400">chỉ để đối chiếu — không sửa ở đây</span>
            <div className="flex-1" />
            <span className="text-[11px] font-bold tabular-nums text-slate-500">Tổng hiện tại {formatVndSuffix(current.total)}</span>
          </div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(112px,1fr))]">
            <CurrentStat label="Giá phòng" value={formatVnd(current.rentPrice)} />
            <CurrentStat label="Tiền phòng" value={formatVnd(current.rentAmount)} />
            {current.deposit > 0 && <CurrentStat label="Tiền cọc" value={formatVnd(current.deposit)} />}
            <CurrentStat
              label="Tiền điện"
              value={formatVnd(current.electric)}
              sub={`${formatVnd(current.prev)} → ${current.curr == null ? '—' : formatVnd(current.curr)} · ${formatVnd(Math.max(0, (current.curr ?? current.prev) - current.prev))} kWh`}
            />
            <CurrentStat label="Số người" value={formatVnd(current.occupants)} />
            <CurrentStat label="Tiền nước" value={formatVnd(current.water)} />
            <CurrentStat label="Phí dịch vụ" value={formatVnd(current.pdv)} last />
          </div>
        </div>
      )}

      {/* ===== Nhập lại hoá đơn ===== */}
      <div className="flex flex-wrap items-center gap-[9px] px-[18px] pt-3.5">
        <div className="text-[13px] font-bold">Nhập lại hoá đơn</div>
        <div className="text-[11.5px] text-[hsl(210_10%_48%)]">
          {isEdit
            ? 'điền sẵn giá trị hoá đơn hiện tại — sửa ô nào thì chỉ ô đó thay đổi'
            : 'điền sẵn theo hợp đồng và đơn giá toà'}
        </div>
        <div className="flex-1" />
        {diff.count > 0 && (
          <span className="rounded-[5px] border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-bold text-amber-800">
            {diff.count} thay đổi
          </span>
        )}
        <button
          type="button"
          onClick={onResetAll}
          disabled={!ready}
          className={cn(
            'inline-flex h-[27px] items-center gap-1 rounded-md border bg-white px-2.5 text-xs font-semibold text-[hsl(210_10%_35%)] hover:bg-[hsl(152_20%_95%)] hover:text-[hsl(152_69%_25%)] disabled:opacity-50',
            LINE,
          )}
        >
          <RotateCcw className="h-3 w-3" /> Về giá trị gốc
        </button>
      </div>

      {!lockedDates && <div className="grid grid-cols-1 gap-2.5 px-[18px] pt-2.5 sm:grid-cols-3">
        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL}>Kỳ thanh toán *</span>
          <Input
            type="month"
            aria-label="Kỳ thanh toán"
            value={v.billing_month}
            onChange={(e) => set.billingMonth(e.target.value)}
            className={cn('h-[34px] rounded-md px-[9px] text-[13px]', LINE, FOCUS)}
          />
        </label>
        <div className="flex flex-col gap-1">
          <span className={FIELD_LABEL}>Ngày phát hành *</span>
          <DateInput
            value={v.issue_date || ''}
            onChange={set.issueDate}
            inputClassName={cn('h-[34px] rounded-md text-[13px] tabular-nums', LINE, FOCUS)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className={FIELD_LABEL}>Hạn thanh toán *</span>
          <DateInput
            value={v.due_date || ''}
            onChange={set.dueDate}
            inputClassName={cn('h-[34px] rounded-md text-[13px] tabular-nums', LINE, FOCUS)}
          />
        </div>
      </div>}

      {duplicate && (
        <div className="mx-[18px] mt-2.5 flex gap-2 rounded-[7px] border border-red-200 bg-red-50 px-[11px] py-2 text-xs leading-relaxed text-red-700">
          <span className="font-bold">⚠</span>
          <span>
            Hợp đồng này đã có hoá đơn kỳ <b>{monthLabel(duplicate.period)}</b> ({duplicate.invoiceNo}). Hệ thống chỉ cho phép 1 hoá đơn / hợp đồng / kỳ — chọn kỳ khác hoặc huỷ/sửa hoá đơn cũ trước.
          </span>
        </div>
      )}

      {!ready && (
        <div className={cn('mx-[18px] mt-3 rounded-[9px] border border-dashed bg-slate-50 px-4 py-6 text-center text-[13px]', LINE, MUTED)}>
          Chọn hợp đồng ở trên để nạp giá phòng, chỉ số điện và đơn giá dịch vụ.
        </div>
      )}

      {ready && (
        <>
          {/* ===== Hàng cấu trúc ===== */}
          <div className={cn('mx-[18px] mt-3 min-w-0 overflow-x-auto rounded-[9px] border', LINE)}>
            <div className={cn('grid min-w-[760px] grid-cols-[1.25fr_.75fr_1fr_1fr_1.1fr_1fr_1.1fr] border-b bg-slate-100', LINE)}>
              <GridHead first>Giá phòng</GridHead>
              <GridHead>Số người</GridHead>
              <GridHead>Chỉ số đầu</GridHead>
              <GridHead>Chỉ số cuối</GridHead>
              <GridHead>Tiền điện</GridHead>
              <GridHead>Nước</GridHead>
              <GridHead>Phí dịch vụ</GridHead>
            </div>
            <div className="grid min-w-[760px] grid-cols-[1.25fr_.75fr_1fr_1fr_1.1fr_1fr_1.1fr]">
              <Cell first changed={changed('rent_price')}>
                <CurrencyInput aria-label="Giá phòng" suffix={false} className={cn(CELL_INPUT, 'font-semibold')} value={v.rent_price} onChange={set.rent} />
              </Cell>
              <Cell changed={changed('occupants')}>
                <NumberInput aria-label="Số người" className={CELL_INPUT} value={v.occupants} onChange={set.occupants} />
              </Cell>
              <Cell changed={changed('prev_reading')}>
                <div className="relative">
                  <NumberInput
                    aria-label="Chỉ số đầu"
                    allowDecimal
                    disabled={!meterId}
                    title={meterId ? (v.prev_reading_overridden ? 'Đã sửa tay chỉ số đầu' : 'Chỉ số chốt gần nhất') : 'Phòng chưa gắn công tơ điện'}
                    placeholder={meterId ? undefined : '—'}
                    className={cn(CELL_INPUT, 'bg-slate-50 text-slate-600 focus-visible:bg-white', v.prev_reading_overridden && 'pr-6')}
                    value={v.prev_reading}
                    onChange={set.prev}
                  />
                  {v.prev_reading_overridden && (
                    <Pencil aria-hidden className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-amber-600" />
                  )}
                </div>
              </Cell>
              <Cell changed={changed('current_reading')}>
                <NumberInput
                  aria-label="Chỉ số cuối"
                  allowDecimal
                  disabled={!meterId}
                  title={meterId ? undefined : 'Phòng chưa gắn công tơ điện'}
                  placeholder={meterId ? undefined : '—'}
                  className={cn(CELL_INPUT, 'font-semibold')}
                  value={v.current_reading}
                  onChange={set.curr}
                />
              </Cell>
              <Cell changed={changed('electric_amount')}>
                <CurrencyInput aria-label="Tiền điện" suffix={false} className={CELL_INPUT} value={Math.round(v.electric_amount)} onChange={set.electric} />
              </Cell>
              <Cell changed={changed('water_amount')}>
                <CurrencyInput aria-label="Tiền nước" suffix={false} className={CELL_INPUT} value={Math.round(v.water_amount)} onChange={set.water} />
              </Cell>
              <Cell changed={changed('pdv_amount')}>
                <CurrencyInput aria-label="Phí dịch vụ" suffix={false} className={CELL_INPUT} value={v.pdv_amount} onChange={set.pdv} />
              </Cell>
            </div>
            <div className={cn('flex min-w-[760px] flex-wrap gap-2.5 border-t bg-slate-50 px-[9px] py-[5px] text-[11px]', LINE_SOFT, MUTED)}>
              <span>
                {pricing.sourceLabel ?? (pricing.hasContractServices ? 'Đơn giá HĐ' : 'Đơn giá toà')}: điện{' '}
                <b className="text-slate-600">{formatVnd(pricing.elec)}đ/kWh</b>
              </span>
              <span>
                nước{' '}
                <b className="text-slate-600">{pricing.waterApplicable ? `${formatVnd(pricing.water)}đ/người` : 'HĐ không đăng ký'}</b>
              </span>
              <span>
                PDV{' '}
                <b className="text-slate-600">{pricing.pdvApplicable ? `${formatVnd(pricing.pdv)}đ/phòng` : 'HĐ không đăng ký'}</b>
              </span>
              <span className="font-semibold text-primary">
                Điện: {kwh > 0 ? `${formatVnd(kwh)} kWh × ${formatVnd(pricing.elec)}đ = ${formatVndSuffix(kwh * pricing.elec)}` : 'chưa có chỉ số cuối'}
              </span>
            </div>
          </div>

          {/* ===== Tiền cọc ===== */}
          <div className={cn('mx-[18px] mt-2.5 flex flex-wrap items-center gap-[11px] rounded-[9px] border px-[11px] py-[9px]', LINE, deposit ? 'bg-[hsl(152_20%_97%)]' : 'bg-white')}>
            <label className="flex cursor-pointer items-center gap-[7px] text-[13px] font-semibold">
              <input
                type="checkbox"
                className="h-[15px] w-[15px] cursor-pointer accent-primary"
                checked={!!deposit}
                onChange={(e) => set.depositToggle(e.target.checked, defaultDepositAmount)}
              />
              Tiền cọc (nếu có)
            </label>
            <span className="text-[11.5px] text-[hsl(210_10%_48%)]">Hạch toán riêng — không tính vào doanh thu</span>
            <div className="flex-1" />
            {deposit && (
              <div className="flex items-center gap-[7px]">
                <Input
                  aria-label="Mô tả cọc"
                  placeholder="Mô tả cọc"
                  value={deposit.description}
                  onChange={(e) => set.depositNote(e.target.value)}
                  className={cn('h-8 w-[150px] rounded-md px-2 text-[13px]', LINE, FOCUS)}
                />
                <CurrencyInput
                  aria-label="Số tiền cọc"
                  suffix={false}
                  value={customLineAmount(deposit)}
                  onChange={set.depositAmount}
                  className={cn(CELL_INPUT, 'w-[130px] font-semibold')}
                />
              </div>
            )}
          </div>

          {/* ===== Ngày thuê thực tế ===== */}
          <div className="mx-[18px] mt-2.5 rounded-[9px] border border-dashed border-[hsl(210_20%_82%)] bg-slate-50 px-[11px] py-2.5">
            <div className="flex flex-wrap items-center gap-[9px]">
              <span className="text-[12.5px] font-semibold">Ngày thuê thực tế</span>
              <span className="text-[11.5px] text-[hsl(210_10%_48%)]">prorate giá phòng + nước + PDV</span>
              <div className="flex-1" />
              {totals.isProrated && (
                <span className="rounded-[5px] bg-emerald-100 px-2 py-0.5 text-[11px] font-bold text-emerald-700">
                  Đã prorate {totals.days}/30 ngày
                </span>
              )}
            </div>
            <div className="mt-2 grid grid-cols-1 items-end gap-[9px] sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
              <label className="flex flex-col gap-[3px]">
                <span className={cn('text-[11px]', MUTED)}>Ngày bắt đầu</span>
                <DateInput value={v.period_start_date || ''} onChange={set.periodStart} inputClassName={cn('h-8 rounded-md bg-white text-[13px] tabular-nums', LINE, FOCUS)} />
              </label>
              <label className="flex flex-col gap-[3px]">
                <span className={cn('text-[11px]', MUTED)}>Ngày kết thúc</span>
                <DateInput value={v.period_end_date || ''} onChange={set.periodEnd} inputClassName={cn('h-8 rounded-md bg-white text-[13px] tabular-nums', LINE, FOCUS)} />
              </label>
              <button
                type="button"
                onClick={set.clearPeriod}
                disabled={!v.period_start_date && !v.period_end_date}
                className={cn('h-8 rounded-md border bg-white px-3 text-xs font-semibold text-[hsl(210_10%_35%)] hover:bg-[hsl(210_20%_94%)] disabled:opacity-50', LINE)}
              >
                Xoá ngày
              </button>
            </div>
            {totals.isProrated && (
              <div className={cn('mt-[7px] grid grid-cols-3 gap-[9px] text-[11.5px]', MUTED)}>
                <div>Tiền phòng: <b className="tabular-nums text-slate-700">{formatVndSuffix(totals.rent)}</b></div>
                <div>Nước: <b className="tabular-nums text-slate-700">{formatVndSuffix(totals.water)}</b></div>
                <div>PDV: <b className="tabular-nums text-slate-700">{formatVndSuffix(totals.pdv)}</b></div>
              </div>
            )}
          </div>

          {/* ===== Khoản thu thêm ===== */}
          <div className="mx-[18px] mt-3">
            <div className="flex items-center gap-[9px]">
              <span className="text-[12.5px] font-semibold">Khoản thu thêm</span>
              <div className="flex-1" />
              <button
                type="button"
                onClick={set.addExtra}
                className={cn('inline-flex h-7 items-center gap-1 rounded-md border bg-white px-[11px] text-xs font-semibold text-[hsl(152_69%_25%)] hover:bg-[hsl(152_20%_95%)]', LINE)}
              >
                <Plus className="h-3.5 w-3.5" /> Thêm
              </button>
            </div>
            {extras.length > 0 && (
              <div className={cn('mt-[7px] min-w-0 overflow-x-auto rounded-[9px] border', LINE)}>
                <div className="grid min-w-[560px] grid-cols-[120px_minmax(0,1fr)_70px_120px_120px_34px] border-b border-[hsl(210_20%_90%)] bg-slate-50">
                  {['Loại', 'Mô tả', 'SL', 'Đơn giá', 'Thành tiền'].map((h, i) => (
                    <div key={h} className={cn('px-2 py-1.5 text-[10px] font-bold uppercase tracking-[.04em] text-slate-600', i >= 2 && 'text-right')}>{h}</div>
                  ))}
                  <div />
                </div>
                {extras.map(({ item, index, key }) => {
                  const kind: ExtraKind = item.type === 'RENT' ? 'OTHER' : item.type;
                  return (
                    <div key={key} data-extra-row className="grid min-w-[560px] grid-cols-[120px_minmax(0,1fr)_70px_120px_120px_34px] items-center border-b border-[hsl(210_20%_94%)] last:border-b-0">
                      <div className="p-[5px]">
                        <Select value={kind} onValueChange={(val) => set.extraKind(index, val as ExtraKind)}>
                          <SelectTrigger aria-label="Loại khoản thu" className={cn('h-[30px] rounded-md px-1.5 text-[12.5px]', LINE)}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {extraKinds(kind).map((k) => <SelectItem key={k} value={k}>{EXTRA_KIND_LABEL[k]}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="p-[5px]">
                        <Input aria-label="Mô tả khoản thu" placeholder="VD: phí gửi xe" value={item.description} onChange={(e) => set.extraDescription(index, e.target.value)} className={cn('h-[30px] rounded-md px-2 text-[13px]', LINE, FOCUS)} />
                      </div>
                      <div className="p-[5px]">
                        <NumberInput aria-label="Số lượng" allowDecimal value={item.quantity} onChange={(n) => set.extraQuantity(index, n)} className={cn(CELL_INPUT, 'h-[30px] px-1.5')} />
                      </div>
                      <div className="p-[5px]">
                        <CurrencyInput aria-label="Đơn giá" suffix={false} value={item.unit_price} onChange={(n) => set.extraPrice(index, n)} className={cn(CELL_INPUT, 'h-[30px]')} />
                      </div>
                      <div className="px-2 py-[5px] text-right text-[13px] font-semibold tabular-nums">
                        {formatVnd(customLineAmount(item))}
                        {item.coefficient != null && item.coefficient !== 1 && (
                          <span className={cn('block text-[10px] font-normal', MUTED)}>hệ số {item.coefficient}</span>
                        )}
                      </div>
                      <div className="p-[5px] text-center">
                        <button type="button" aria-label="Xóa khoản thu" onClick={() => set.removeExtra(index)} className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-[5px] text-red-600 hover:bg-red-50">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* ===== Giảm trừ · Nợ cũ ===== */}
          <div className="mx-[18px] mt-[11px] grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-2.5">
            <div className="rounded-[9px] border border-amber-200 bg-amber-50 px-[11px] py-[9px]">
              <div className="flex items-center gap-[9px]">
                <span className="whitespace-nowrap text-[12.5px] font-semibold text-amber-900">Giảm trừ</span>
                <div className="flex-1" />
                <div className="relative w-[140px]">
                  <CurrencyInput
                    aria-label="Giảm trừ"
                    suffix={false}
                    value={v.discount_amount}
                    onChange={set.discount}
                    className={cn(CELL_INPUT, 'border-amber-300 bg-white pr-8 font-semibold focus-visible:border-amber-500 focus-visible:ring-amber-500/35')}
                  />
                  <DiscountNoteTrigger value={v.discount_notes || ''} onChange={set.discountNotes} disabled={v.discount_amount <= 0} />
                </div>
              </div>
              {creditBalance > 0 && (
                <p className="mt-1 text-right text-[11px] text-amber-700">Tiền nợ khách hiện có: {formatVndSuffix(creditBalance)}</p>
              )}
            </div>
            <div className="rounded-[9px] border border-red-200 bg-red-50 px-[11px] py-[9px]">
              <div className="flex items-center gap-[9px]">
                <span className="whitespace-nowrap text-[12.5px] font-semibold text-red-800">Nợ cũ kỳ trước</span>
                <div className="flex-1" />
                {debt.locked ? (
                  <span className="text-[13px] font-semibold tabular-nums text-red-700" title="Nguồn nợ giữ cố định">{formatVndSuffix(v.previous_debt)}</span>
                ) : (<>
                <CurrencyInput
                  aria-label="Nợ cũ kỳ trước"
                  suffix={false}
                  value={v.previous_debt}
                  onChange={set.debt}
                  className={cn(CELL_INPUT, 'w-[120px] border-red-300 bg-white font-semibold focus-visible:border-red-500 focus-visible:ring-red-500/30', v.previous_debt > 0 && 'text-red-700')}
                />
                <button
                  type="button"
                  title="Tải lại nợ cũ tự động"
                  aria-label="Tải lại nợ cũ"
                  onClick={debt.onReload}
                  disabled={!debt.canReload || debt.loading}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-[5px] text-red-700 hover:bg-red-100 disabled:opacity-50"
                >
                  {debt.loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                </button>
                </>)}
              </div>
              {v.previous_debt_overridden ? (
                <p className="mt-1 text-right text-[11px] text-amber-700">Đã chỉnh tay — hoá đơn cũ sẽ KHÔNG tự tất toán khi thu đủ.</p>
              ) : debt.sources.length > 0 ? (
                <ul className="mt-1 space-y-0.5 text-[11px] text-red-700">
                  {debt.sources.map((s, i) => (
                    <li key={i} className="flex justify-between gap-2">
                      <span className="truncate">{s.type === 'deposit' ? '🏠' : '📄'} {s.label}</span>
                      <span className="tabular-nums">{formatVndSuffix(s.amount)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>

          {/* ===== Tổng cộng ===== */}
          <div className="mx-[18px] mt-[11px] rounded-[9px] border border-blue-200 bg-blue-50 px-3.5 py-[11px]">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="text-sm font-semibold text-blue-900">Tổng cộng</span>
              {isEdit && current && delta !== 0 && (
                <span className="rounded-[5px] border border-blue-200 bg-white px-2 py-0.5 text-[11.5px] font-bold tabular-nums text-blue-700">
                  {delta > 0 ? '+' : ''}{formatVnd(delta)} đ so với hiện tại
                </span>
              )}
              <div className="flex-1" />
              <span data-testid="invoice-entry-total" className="text-[22px] font-extrabold tracking-[-.02em] tabular-nums text-blue-900">
                {formatVndSuffix(totals.total)}
              </span>
            </div>
            <div className="mt-[5px] text-[11.5px] tabular-nums text-[#3b5bdb]">{breakdown}</div>
            {blocker && <div role="alert" className="mt-1 text-[11.5px] font-semibold text-red-700">{blocker}</div>}
            {current?.paid != null && (
              <div className="mt-1 text-[11.5px] tabular-nums text-[#3b5bdb]">
                Đã thu {formatVndSuffix(current.paid)} · Còn phải thu dự tính {formatVndSuffix(totals.total - current.paid)}
              </div>
            )}
          </div>
        </>
      )}

      {reason && (
        <div className="mx-[18px] mt-[11px]">
          <label htmlFor="issued-reason" className={cn('mb-1 block after:ml-0.5 after:text-red-600 after:content-["*"]', FIELD_LABEL)}>Lý do điều chỉnh</label>
          <Textarea
            id="issued-reason"
            rows={2}
            value={reason.value}
            onChange={(e) => reason.onChange(e.target.value)}
            placeholder="Nêu lý do thay đổi (3–1000 ký tự)"
            className={cn('min-h-0 rounded-md px-[9px] py-[7px] text-[13px]', reason.error ? 'border-red-400' : LINE, FOCUS)}
          />
          {reason.error && <p role="alert" className="mt-1 text-xs text-red-600">{reason.error}</p>}
        </div>
      )}

      {/* ===== Ghi chú ===== */}
      <div className="mx-[18px] mt-[11px]">
        <label htmlFor="invoice-entry-notes" className={cn('mb-1 block', FIELD_LABEL)}>Ghi chú</label>
        <Textarea
          id="invoice-entry-notes"
          rows={2}
          value={v.notes || ''}
          onChange={(e) => set.notes(e.target.value)}
          placeholder={isEdit ? 'Lý do sửa hoá đơn, thoả thuận với khách...' : 'Ghi chú về hoá đơn...'}
          className={cn('min-h-0 rounded-md px-[9px] py-[7px] text-[13px]', LINE, FOCUS)}
        />
      </div>

      {validationError && <div role="alert" className="mx-[18px] mt-[11px] rounded-[7px] border border-red-200 bg-red-50 px-[11px] py-2 text-xs text-red-700">{validationError}</div>}
      {notice && <div className="mx-[18px] mt-[11px]">{notice}</div>}

      {/* ===== Footer ===== */}
      <div className={cn('mt-[13px] flex flex-wrap items-center gap-2.5 border-t bg-slate-50 px-[18px] py-[11px]', LINE_SOFT)}>
        <span className={cn('text-[11.5px]', MUTED)}>{footNote}</span>
        <div className="flex-1" />
        <button type="button" onClick={onCancel} className={cn('h-9 rounded-[7px] border bg-white px-[15px] text-[13px] font-semibold hover:bg-[hsl(210_20%_94%)]', LINE)}>
          Hủy
        </button>
        <button
          type="submit"
          disabled={submit.disabled || submit.pending || !!blocker}
          className="h-9 rounded-[7px] bg-primary px-[18px] text-[13px] font-bold text-white shadow-sm hover:bg-[hsl(152_69%_26%)] disabled:opacity-50"
        >
          {submit.pending ? submit.pendingLabel : submit.label}
        </button>
      </div>
    </fieldset>
  );
}
