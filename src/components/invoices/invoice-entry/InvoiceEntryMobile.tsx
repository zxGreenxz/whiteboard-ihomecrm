import { ArrowLeft, Loader2, RotateCcw } from 'lucide-react';
import '@/styles/mobileApp.css';
import '@/styles/invoiceEntryMobile.css';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { CurrencyInput } from '@/components/ui/currency-input';
import { NumberInput } from '@/components/ui/number-input';
import { DateInput } from '@/components/ui/date-input';
import { DiscountNoteTrigger } from '../DiscountNoteTrigger';
import {
  customLineAmount,
  formatVnd,
  formatVndSuffix,
  fullDay,
  monthLabel,
  type EntryItemType,
} from '@/lib/invoiceEntry';

type ExtraKind = Exclude<EntryItemType, 'RENT'>;
const EXTRA_KIND_LABEL: Record<ExtraKind, string> = {
  SERVICE: 'Dịch vụ',
  OTHER: 'Khác',
  PENALTY: 'Phạt',
  DISCOUNT: 'Giảm giá',
};
const extraKinds = (kind: ExtraKind): ExtraKind[] =>
  kind === 'SERVICE' || kind === 'OTHER' ? ['SERVICE', 'OTHER'] : ['SERVICE', 'OTHER', kind];
import type { InvoiceEntryProps } from './types';
import { dueBadge } from './dueBadge';

function Money({
  label, value, onChange, changedFrom,
}: { label: string; value: number; onChange: (n: number) => void; changedFrom?: string }) {
  return (
    <label className="block">
      <span className="ien-lbl">{label}</span>
      <div className="ien-money">
        <CurrencyInput aria-label={label} suffix={false} className="ien-in num" value={value} onChange={onChange} />
        <i>đ</i>
      </div>
      {changedFrom && <div className="ien-changed">đã đổi · gốc {changedFrom}</div>}
    </label>
  );
}

/** Layout điện thoại của bộ nhập liệu hoá đơn — theo "Hóa đơn mobile - Sửa & Tạo lẻ.dc.html". */
export function InvoiceEntryMobile(props: InvoiceEntryProps) {
  const {
    mode, ctl, header, current, selectors, selectorsNotice, duplicate, pricing, meterId, debt,
    creditBalance, defaultDepositAmount, ready, onResetAll, onCancel, footNote, submit,
    lockedDates, busy, reason, notice,
  } = props;
  const isEdit = mode === 'edit';
  const { v, totals, diff, kwh, deposit, extras, set } = ctl;
  const due = dueBadge(v.due_date, isEdit);
  const delta = current ? totals.total - current.total : 0;
  const sel = selectors?.('mobile');

  return (
    <>
      <div className="mtop">
        <button type="button" className="mback" onClick={onCancel} aria-label="Quay lại">
          <ArrowLeft />
        </button>
        <div className="mtitle">
          <h1>{header.title}</h1>
          <p className="ien-mono">{header.invoiceNo}</p>
        </div>
        <div className="mtop-act">
          <button type="button" className="mtop-btn ghost" onClick={onResetAll} disabled={!ready} aria-label="Về giá trị gốc">
            <RotateCcw /> Gốc
          </button>
        </div>
      </div>

      <div className="ien-body">
        <fieldset disabled={busy} className="contents">
        {/* Ngữ cảnh */}
        <div className="ien-card ien-card-ctx">
          <div className="flex flex-wrap items-center gap-[9px]">
            <span className="ien-chip">{header.building || '—'}<i>/</i>{header.room || '—'}</span>
            {header.rep && <span className="ien-rep">{header.rep}</span>}
          </div>
          <div className="ien-ctx-row">
            <span className="ien-pill">Kỳ <span className="ien-mono">{monthLabel(v.billing_month)}</span></span>
            <span className="ien-dates">{fullDay(v.issue_date)}<i>→</i>{fullDay(v.due_date)}</span>
            {due && <span className={cn('ien-pill', due.tone === 'danger' ? 'danger' : 'warn')}>{due.label}</span>}
          </div>
          <div className="ien-note" style={{ marginTop: 8 }}>{header.lockNote}</div>
        </div>

        {sel && (
          <div className="flex flex-col gap-[9px] ien-gap">
            <div className="ien-grid2" style={{ gap: 9 }}>
              <div><span className="ien-lbl">Toà nhà</span>{sel.building}</div>
              <div><span className="ien-lbl">Phòng</span>{sel.room}</div>
            </div>
            <div><span className="ien-lbl">Hợp đồng *</span>{sel.contract}</div>
            {selectorsNotice && <div className="ien-alert" style={{ marginBottom: 0 }}><span>⚠</span><span>{selectorsNotice}</span></div>}
          </div>
        )}
        {duplicate && (
          <div className="ien-alert">
            <span>⚠</span>
            <span>Hợp đồng đã có hoá đơn kỳ {monthLabel(duplicate.period)} ({duplicate.invoiceNo}). Chỉ 1 hoá đơn / hợp đồng / kỳ.</span>
          </div>
        )}

        {isEdit && current && (
          <div className="ien-cur">
            <div className="ien-cur-hd"><b>Hoá đơn hiện tại</b><span>chưa sửa</span></div>
            <div className="ien-cur-grid">
              <div className="ien-cur-l">Giá phòng</div><div className="ien-cur-v">{formatVndSuffix(current.rentPrice)}</div>
              <div className="ien-cur-l">Tiền phòng</div><div className="ien-cur-v">{formatVndSuffix(current.rentAmount)}</div>
              {current.deposit > 0 && (<><div className="ien-cur-l">Tiền cọc</div><div className="ien-cur-v">{formatVndSuffix(current.deposit)}</div></>)}
              <div className="ien-cur-l">Tiền điện</div>
              <div className="ien-cur-v">
                {formatVndSuffix(current.electric)}
                <small>{formatVnd(current.prev)} → {current.curr == null ? '—' : formatVnd(current.curr)} · {formatVnd(Math.max(0, (current.curr ?? current.prev) - current.prev))} kWh</small>
              </div>
              <div className="ien-cur-l">Số người</div><div className="ien-cur-v">{formatVnd(current.occupants)} người</div>
              <div className="ien-cur-l">Tiền nước</div><div className="ien-cur-v">{formatVndSuffix(current.water)}</div>
              <div className="ien-cur-l">Phí dịch vụ</div><div className="ien-cur-v">{formatVndSuffix(current.pdv)}</div>
              <div className="ien-cur-l tot">Tổng</div><div className="ien-cur-v tot">{formatVndSuffix(current.total)}</div>
            </div>
          </div>
        )}

        <div className="flex items-center gap-2" style={{ marginBottom: 10 }}>
          <span className="ien-h">Nhập lại hoá đơn</span>
          {diff.count > 0 && <span className="ien-pill warn">{diff.count} thay đổi</span>}
        </div>

        {!lockedDates && <div className="ien-card">
          <label className="block ien-gap">
            <span className="ien-lbl">Kỳ thanh toán *</span>
            <Input type="month" aria-label="Kỳ thanh toán" className="ien-in month" value={v.billing_month} onChange={(e) => set.billingMonth(e.target.value)} />
          </label>
          <div className="ien-grid2">
            <div>
              <span className="ien-lbl">Ngày phát hành *</span>
              <DateInput className="ien-datewrap" inputClassName="ien-in date" value={v.issue_date || ''} onChange={set.issueDate} />
            </div>
            <div>
              <span className="ien-lbl">Hạn thanh toán *</span>
              <DateInput className="ien-datewrap" inputClassName="ien-in date" value={v.due_date || ''} onChange={set.dueDate} />
            </div>
          </div>
        </div>}

        {!ready && <div className="ien-empty">Chọn hợp đồng ở trên để nạp giá phòng, chỉ số điện và đơn giá dịch vụ.</div>}

        {ready && (
          <>
            <div className="ien-card">
              <div className="ien-h" style={{ marginBottom: 12 }}>Phòng &amp; người</div>
              <div className="ien-gap">
                <Money label="Giá phòng" value={v.rent_price} onChange={set.rent} changedFrom={current && diff.fields.has('rent_price') ? formatVndSuffix(current.rentPrice) : undefined} />
              </div>
              <span className="ien-lbl">Số người</span>
              <div className="ien-step">
                <button type="button" className="ien-step-btn" aria-label="Giảm số người" onClick={() => set.stepOccupants(-1)}>−</button>
                <div className="ien-step-box">
                  <NumberInput aria-label="Số người" value={v.occupants} onChange={set.occupants} />
                  <span>người</span>
                </div>
                <button type="button" className="ien-step-btn" aria-label="Tăng số người" onClick={() => set.stepOccupants(1)}>+</button>
              </div>
            </div>

            <div className="ien-card">
              <div className="ien-h-row">
                <span className="ien-h">Điện</span>
                <span className="ien-pill ien-mono" style={{ marginLeft: 'auto' }}>{formatVnd(pricing.elec)}đ/kWh</span>
              </div>
              <div className="ien-grid2">
                <label className="block">
                  <span className="ien-lbl">Chỉ số đầu</span>
                  <NumberInput aria-label="Chỉ số đầu" allowDecimal disabled={!meterId} placeholder={meterId ? undefined : '—'} className="ien-in num soft" value={v.prev_reading} onChange={set.prev} />
                </label>
                <label className="block">
                  <span className="ien-lbl">Chỉ số cuối</span>
                  <NumberInput aria-label="Chỉ số cuối" allowDecimal disabled={!meterId} placeholder="—" className="ien-in num" value={v.current_reading} onChange={set.curr} />
                </label>
              </div>
              {!meterId && <div className="ien-note">Phòng chưa gắn công tơ điện — gõ thẳng tiền điện bên dưới.</div>}
              {v.prev_reading_overridden && meterId && <div className="ien-changed">Chỉ số đầu đã sửa tay</div>}
              <div style={{ marginTop: 12 }}>
                <Money label="Tiền điện" value={Math.round(v.electric_amount)} onChange={set.electric} />
              </div>
              <div className="ien-note mono">
                {kwh > 0 ? `${formatVnd(kwh)} kWh × ${formatVnd(pricing.elec)} = ${formatVndSuffix(kwh * pricing.elec)}` : 'chưa có chỉ số cuối'}
              </div>
            </div>

            <div className="ien-card">
              <div className="ien-h" style={{ marginBottom: 12 }}>Nước &amp; dịch vụ</div>
              <div className="ien-grid2">
                <label className="block">
                  <span className="ien-lbl">Tiền nước</span>
                  <CurrencyInput aria-label="Tiền nước" suffix={false} className="ien-in num" value={Math.round(v.water_amount)} onChange={set.water} />
                </label>
                <label className="block">
                  <span className="ien-lbl">Phí dịch vụ</span>
                  <CurrencyInput aria-label="Phí dịch vụ" suffix={false} className="ien-in num" value={v.pdv_amount} onChange={set.pdv} />
                </label>
              </div>
              <div className="ien-note">
                {pricing.sourceLabel ?? (pricing.hasContractServices ? 'Đơn giá HĐ' : 'Đơn giá toà')}: nước {pricing.waterApplicable ? `${formatVnd(pricing.water)}đ/người` : 'HĐ không đăng ký'} · PDV {pricing.pdvApplicable ? `${formatVnd(pricing.pdv)}đ/phòng` : 'HĐ không đăng ký'}
              </div>
            </div>

            <div className={cn('ien-card', deposit && 'dep-on')}>
              <div className="flex items-center gap-3">
                <div className="min-w-0">
                  <div className="ien-h">Tiền cọc (nếu có)</div>
                  <div className="ien-sub" style={{ marginTop: 3 }}>Hạch toán riêng, không vào doanh thu</div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={!!deposit}
                  aria-label="Tiền cọc (nếu có)"
                  className={cn('ien-switch', deposit && 'on')}
                  onClick={() => set.depositToggle(!deposit, defaultDepositAmount)}
                >
                  <i />
                </button>
              </div>
              {deposit && (
                <div className="grid gap-2.5" style={{ gridTemplateColumns: '1fr 132px', marginTop: 12 }}>
                  <Input aria-label="Mô tả cọc" placeholder="Mô tả cọc" className="ien-in" value={deposit.description} onChange={(e) => set.depositNote(e.target.value)} />
                  <CurrencyInput aria-label="Số tiền cọc" suffix={false} className="ien-in num" value={customLineAmount(deposit)} onChange={set.depositAmount} />
                </div>
              )}
            </div>

            <div className="ien-card">
              <div className="ien-h-row">
                <span className="ien-h">Ngày thuê thực tế</span>
                {totals.isProrated && <span className="ien-pill ok" style={{ marginLeft: 'auto' }}>Prorate {totals.days}/30</span>}
              </div>
              <div className="ien-grid2">
                <div>
                  <span className="ien-lbl">Bắt đầu</span>
                  <DateInput className="ien-datewrap" inputClassName="ien-in date" value={v.period_start_date || ''} onChange={set.periodStart} />
                </div>
                <div>
                  <span className="ien-lbl">Kết thúc</span>
                  <DateInput className="ien-datewrap" inputClassName="ien-in date" value={v.period_end_date || ''} onChange={set.periodEnd} />
                </div>
              </div>
              {totals.isProrated && (
                <div className="ien-pr">
                  <div>Tiền phòng<b>{formatVndSuffix(totals.rent)}</b></div>
                  <div>Nước<b>{formatVndSuffix(totals.water)}</b></div>
                  <div>PDV<b>{formatVndSuffix(totals.pdv)}</b></div>
                </div>
              )}
              <button type="button" className="ien-btn full" onClick={set.clearPeriod} disabled={!v.period_start_date && !v.period_end_date}>Xoá ngày</button>
            </div>

            <div className="ien-card">
              <div className="flex items-center gap-2">
                <span className="ien-h">Khoản thu thêm</span>
                <button type="button" className="ien-btn add" onClick={set.addExtra}>+ Thêm</button>
              </div>
              {extras.map(({ item, index, key }) => {
                const kind: ExtraKind = item.type === 'RENT' ? 'OTHER' : item.type;
                return (
                  <div key={key} className="ien-extra" data-extra-row>
                    <div className="ien-extra-r1">
                      <select aria-label="Loại khoản thu" className="ien-in ien-select sm" value={kind} onChange={(e) => set.extraKind(index, e.target.value as ExtraKind)}>
                        {extraKinds(kind).map((k) => <option key={k} value={k}>{EXTRA_KIND_LABEL[k]}</option>)}
                      </select>
                      <Input aria-label="Mô tả khoản thu" placeholder="Mô tả" className="ien-in sm" value={item.description} onChange={(e) => set.extraDescription(index, e.target.value)} />
                      <button type="button" className="ien-btn del" aria-label="Xóa khoản thu" onClick={() => set.removeExtra(index)}>✕</button>
                    </div>
                    <div className="ien-extra-r2">
                      <NumberInput aria-label="Số lượng" allowDecimal className="ien-in sm num" value={item.quantity} onChange={(n) => set.extraQuantity(index, n)} />
                      <CurrencyInput aria-label="Đơn giá" suffix={false} className="ien-in sm num" value={item.unit_price} onChange={(n) => set.extraPrice(index, n)} />
                      <span className="ien-extra-tot">{formatVndSuffix(customLineAmount(item))}{item.coefficient != null && item.coefficient !== 1 ? ` ×${item.coefficient}` : ''}</span>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="ien-adj">
              <div className="ien-adj-row disc">
                <b>Giảm trừ</b>
                <div className="ien-adj-in">
                  <CurrencyInput aria-label="Giảm trừ" suffix={false} className="ien-in" value={v.discount_amount} onChange={set.discount} />
                  <DiscountNoteTrigger value={v.discount_notes || ''} onChange={set.discountNotes} disabled={v.discount_amount <= 0} />
                </div>
              </div>
              {creditBalance > 0 && <div className="ien-adj-sub">Tiền nợ khách hiện có: {formatVndSuffix(creditBalance)}</div>}
              <div className="ien-adj-row debt">
                <b>Nợ cũ kỳ trước</b>
                {debt.locked ? (
                  <span className="ien-mono" style={{ marginLeft: 'auto', fontWeight: 700, color: '#c0392f' }}>{formatVndSuffix(v.previous_debt)}</span>
                ) : (<>
                <CurrencyInput aria-label="Nợ cũ kỳ trước" suffix={false} className="ien-in" value={v.previous_debt} onChange={set.debt} />
                <button type="button" className="ien-btn reload" aria-label="Tải lại nợ cũ" onClick={debt.onReload} disabled={!debt.canReload || debt.loading}>
                  {debt.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                </button>
                </>)}
              </div>
              {v.previous_debt_overridden ? (
                <div className="ien-adj-sub">Đã chỉnh tay — hoá đơn cũ sẽ KHÔNG tự tất toán khi thu đủ.</div>
              ) : debt.sources.length > 0 ? (
                <ul className="ien-adj-src">
                  {debt.sources.map((s, i) => (
                    <li key={i}><span className="truncate">{s.type === 'deposit' ? '🏠' : '📄'} {s.label}</span><span className="ien-mono">{formatVndSuffix(s.amount)}</span></li>
                  ))}
                </ul>
              ) : null}
            </div>
          </>
        )}

        {reason && (
          <div className="ien-card">
            <label htmlFor="issued-reason" className="ien-lbl req">Lý do điều chỉnh</label>
            <textarea id="issued-reason" className="ien-in" rows={2} value={reason.value} onChange={(e) => reason.onChange(e.target.value)} placeholder="Nêu lý do thay đổi (3–1000 ký tự)" />
            {reason.error && <div role="alert" className="ien-changed" style={{ color: '#c0392f' }}>{reason.error}</div>}
          </div>
        )}

        <div className="ien-card" style={{ marginBottom: 8 }}>
          <label htmlFor="invoice-entry-notes" className="ien-lbl">Ghi chú</label>
          <textarea
            id="invoice-entry-notes"
            className="ien-in"
            rows={2}
            value={v.notes || ''}
            onChange={(e) => set.notes(e.target.value)}
            placeholder={isEdit ? 'Lý do sửa, thoả thuận với khách...' : 'Ghi chú về hoá đơn...'}
          />
        </div>
        <div className="ien-note" style={{ margin: '0 4px 4px' }}>{footNote}</div>
        </fieldset>
        {notice && <div style={{ marginTop: 10 }}>{notice}</div>}
      </div>

      <div className="ien-foot">
        <div className="ien-foot-row">
          <div className="min-w-0">
            <div className="ien-foot-l">Tổng cộng</div>
            {isEdit && current && delta !== 0 && (
              <div className="ien-foot-delta">{delta > 0 ? '+' : ''}{formatVnd(delta)}đ so với hiện tại</div>
            )}
            {current?.paid != null && (
              <div className="ien-foot-delta" style={{ color: '#8d8678' }}>Đã thu {formatVnd(current.paid)} · còn {formatVnd(totals.total - current.paid)}</div>
            )}
          </div>
          <div className="ien-foot-tot" data-testid="invoice-entry-total">{ready ? formatVndSuffix(totals.total) : '—'}</div>
        </div>
        <button type="submit" className="ien-submit" disabled={submit.disabled || submit.pending}>
          {submit.pending ? submit.pendingLabel : submit.label}
        </button>
      </div>
    </>
  );
}
