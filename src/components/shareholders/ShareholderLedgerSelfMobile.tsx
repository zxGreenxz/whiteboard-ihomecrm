// Cổ đông TỰ XEM theo SỔ TỔNG (E3) — điện thoại. Bản thu gọn của ShareholderLedgerSelfView, cùng dữ
// liệu và cùng luật: chỉ tiền của chính mình; tỷ lệ % / số toà chỉ khi có quyền VÀ máy chủ gửi kèm.

import { useMemo, useState } from 'react';
import ShareholderPeriodStatement from './ShareholderPeriodStatement';
import { flowTotal, overviewVouchers } from '@/lib/profitLedger/overviewFlows';
import { HistoricalAdvanceList } from './HistoricalAdvanceList';
import { postedCash } from '@/lib/profitLedger/periodStatement';
import { HandCoins } from 'lucide-react';
import { useMyPositionView } from '@/hooks/profit-ledger/useMyPositionView';
import type { MyProfitLedger } from '@/lib/profitLedger/ledgerReaders';
import {
  advancePendingText, isUnpaidNegative, POSITION_LABELS, settlementCashPendingText, UNPAID_NEGATIVE_NOTE,
} from '@/lib/profitLedger/positionView';
import {
  amountsByBuilding, buildingColumns, buildingMatrix, monthlyAmounts, monthsInScope, newestFirst, payoutStatusLabel,
  periodLabel, periodMonthNumber, periodYear, salaryNet, selfAdvanceBlockedNote,
} from '@/lib/profitLedger/selfView';
import { cancelTargetFromMyPayout, type ProfitPayoutCancelTarget } from '@/lib/profitLedger/vouchers';
import { formatISODateVN } from '@/lib/vnDate';
import { ProfitPayoutCancelDialog } from './ProfitPayoutCancelDialog';
import ProfitSelfAdvanceDialog from './ProfitSelfAdvanceDialog';
import type { ShareholderSelfAccess } from './ShareholderLedgerSelfView';
import { MyFundBreakdown, MyPositionError, MySettlementsMobile } from './ShareholderSelfPosition';
import { BuildingMatrix, CARD, fmtShort, MonthBars, uniformPercent, YearMonthRow } from './profitMobileShared';
import { colorAt } from './shareholderUtils';

const ALL = 'all';
const KPI_VAL = 'font-mono font-bold text-[17px] tracking-[-0.4px] mt-1 whitespace-nowrap leading-none';
const KPI_LABEL = 'text-[10px] font-bold tracking-wide text-[#8d8678] uppercase';
const KPI_SUB = 'text-[10.5px] text-[#b6b0a3] font-semibold mt-1';
const TITLE = 'text-[13.5px] font-extrabold tracking-[-0.1px] text-[#1b1813]';
const SUB = 'text-[11px] font-semibold text-[#8d8678]';
const EMPTY = 'm-0 px-[15px] py-3.5 text-[12.5px] font-semibold text-[#8d8678]';

export default function ShareholderLedgerSelfMobile({ ledger, access, year, onYearChange }: {
  ledger: MyProfitLedger;
  access: ShareholderSelfAccess;
  year: number;
  onYearChange: (y: number) => void;
}) {
  const [month, setMonth] = useState<string>(ALL); // "all" | "1".."12"
  const [advanceOpen, setAdvanceOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<ProfitPayoutCancelTarget | null>(null);
  const shiftYear = (delta: number) => {
    onYearChange(year + delta);
    setMonth(ALL);
  };

  const monthNumber = month === ALL ? null : Number(month);
  // Hai con số của vị thế (R2) + các lần chốt. Chưa có số ⇒ "…" / "—", không hiện 0.
  const positionView = useMyPositionView(ledger.organization_id);
  const position = positionView.position;
  const positionMissing = positionView.pending ? '…' : '—';
  const advancePending = position ? advancePendingText(position, fmtShort) : null;
  const cashPending = position ? settlementCashPendingText(position, fmtShort) : null;
  const viaSalary = salaryNet(ledger);
  const advanceNote = selfAdvanceBlockedNote(ledger.route);
  const yearMonths = useMemo(() => monthsInScope(ledger.months, year, null), [ledger.months, year]);
  const scoped = useMemo(() => monthsInScope(ledger.months, year, monthNumber), [ledger.months, year, monthNumber]);
  const yearTotal = yearMonths.reduce((s, m) => s + m.amount, 0);
  const monthVals = useMemo(() => monthlyAmounts(ledger.months, year).map((v) => v ?? 0), [ledger.months, year]);
  const columns = useMemo(() => buildingColumns(scoped), [scoped]);
  const matrix = useMemo(() => buildingMatrix(scoped, columns), [scoped, columns]);
  const bldRows = useMemo(() => {
    const vals = amountsByBuilding(scoped);
    const sum = vals.reduce((t, x) => t + x.value, 0) || 1;
    const max = Math.max(...vals.map((x) => x.value), 1);
    return vals.map((x, i) => ({ ...x, pct: (x.value / sum) * 100, fill: Math.max(0, (x.value / max) * 100), color: colorAt(i) }));
  }, [scoped]);
  const buildingsEver = useMemo(() => buildingColumns(ledger.months).length, [ledger.months]);
  const payouts = useMemo(() => newestFirst(ledger.payouts), [ledger.payouts]);
  const voucherTotals = useMemo(() => {
    const flows = overviewVouchers(ledger.payouts, ledger.historical_advances ?? [], positionView.position?.settlements ?? []);
    return { advance: flowTotal(flows.advances), cash: flowTotal(flows.profit) };
  }, [ledger.payouts, ledger.historical_advances, positionView.position]);
  // Hai phần nhạy cảm: cần CẢ quyền của người xem LẪN khoá máy chủ gửi.
  const percentRows = access.canViewPercent ? ledger.percent_rows : undefined;
  const pct = percentRows ? uniformPercent(percentRows) : null;
  const buildingTotals = access.canViewBuildingTotals && ledger.building_totals
    ? ledger.building_totals.filter((t) => periodYear(t.period_month) === year && (monthNumber === null || periodMonthNumber(t.period_month) === monthNumber))
    : undefined;
  const marker = ledger.marker ? periodLabel(ledger.marker.settled_through_month) : null;
  const scopeLabel = monthNumber === null ? `năm ${year}` : `T${monthNumber}/${year}`;
  const initial = (ledger.shareholder.name || '?').trim().charAt(0).toUpperCase();

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-[20px] px-4 py-[15px] text-white flex items-center gap-3" style={{ background: 'linear-gradient(155deg,#1f7a52,#1a6645)' }}>
        <div className="w-11 h-11 rounded-full bg-white/15 border border-white/30 grid place-items-center font-extrabold text-[17px] shrink-0">{initial}</div>
        <div className="flex flex-col gap-0.5 min-w-0 flex-1">
          <span className="text-[15px] font-extrabold tracking-[-0.2px] truncate">{ledger.shareholder.name}</span>
          {/* Xuống dòng thay vì cắt: khối số bên phải chiếm chỗ, câu ngắn vẫn có thể dài hơn một dòng. */}
          <span className="text-[11.5px] font-semibold leading-snug text-white/80 [overflow-wrap:anywhere]" data-testid="self-mobile-hero-sub">
            Cổ đông{pct ? ` · tỷ lệ ${pct}` : ''}{buildingsEver ? ` · ${buildingsEver} toà nhà` : ''}
          </span>
        </div>
        <div className="text-right shrink-0" data-testid="self-mobile-balance">
          <div className="text-[10px] font-bold tracking-wide text-white/75 uppercase">Lợi nhuận chưa chốt chi</div>
          <div className="font-mono text-[18px] font-bold tracking-[-0.4px]">{position ? fmtShort(position.unpaid_profit) : positionMissing}</div>
          {cashPending && <div className="text-[10.5px] font-semibold text-white/80">{cashPending}</div>}
          <div className="mt-0.5 text-[10.5px] font-semibold text-white/85" data-testid="self-mobile-advance">
            {POSITION_LABELS.advance}: <span className="font-mono font-bold">{position ? fmtShort(position.advance_outstanding) : positionMissing}</span>
          </div>
          {advancePending && <div className="text-[10.5px] font-semibold text-white/80">{advancePending}</div>}
        </div>
      </div>
      <MyPositionError view={positionView} />
      <MyFundBreakdown view={positionView} />
      {position && isUnpaidNegative(position) && (
        <p role="note" className="m-0 text-[11.5px] font-semibold leading-snug text-[#8d8678]">{UNPAID_NEGATIVE_NOTE}</p>
      )}

      {access.canAdvanceOwn && (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            disabled={advanceNote !== null}
            onClick={() => setAdvanceOpen(true)}
            className="flex items-center justify-center gap-2 rounded-2xl bg-[#1a6645] px-4 py-3 text-[13.5px] font-bold text-white disabled:opacity-50"
          >
            <HandCoins className="h-4 w-4" />Chi tạm ứng cho tôi
          </button>
          {advanceNote && <p role="note" className="m-0 text-center text-[11.5px] font-semibold text-[#8d8678]">{advanceNote}</p>}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2.5">
        <div className={`${CARD} !rounded-2xl px-3 py-3`}>
          <span className={KPI_LABEL}>Được chia từ tòa</span>
          <div className={`${KPI_VAL} text-[#0e7a47]`}>{fmtShort(ledger.allocated)}</div>
          <div className={KPI_SUB}>{marker ? `Sau mốc hết ${marker}` : 'Luỹ kế đã chốt'}</div>
        </div>
        <div className={`${CARD} !rounded-2xl px-3 py-3`}>
          <span className={KPI_LABEL}>Đã chi qua phiếu</span>
          <div className={`${KPI_VAL} text-[#c97a10]`}>{fmtShort(postedCash(ledger.payouts))}</div>
          <div className={KPI_SUB}>{marker ? 'Phiếu tiền ghi sổ sau mốc đối chiếu' : 'Gồm ứng và chi lợi nhuận đã ghi sổ'}</div>
        </div>
        {viaSalary !== null && (
          <div className={`${CARD} !rounded-2xl px-3 py-3`}>
            <span className={KPI_LABEL}>Qua lương</span>
            <div className={`${KPI_VAL} text-[#1b1813]`}>{fmtShort(viaSalary)}</div>
            <div className={KPI_SUB}>{ledger.advance_recovered > 0 ? `Trừ tạm ứng ${fmtShort(ledger.advance_recovered)}` : 'Trong phiếu lương'}</div>
          </div>
        )}
        <div className={`${CARD} !rounded-2xl px-3 py-3`}>
          <span className={KPI_LABEL}>Từ các tòa năm {year}</span>
          <div className={`${KPI_VAL} text-[#1b1813]`}>{fmtShort(yearTotal)}</div>
          <div className={KPI_SUB}>{yearMonths.length > 0 ? `${yearMonths.length} tháng đã chốt` : 'Chưa có dữ liệu'}</div>
        </div>
      </div>

      <YearMonthRow year={year} month={month} onYearShift={shiftYear} onMonthChange={setMonth} />
      <ShareholderPeriodStatement ledger={ledger} view={positionView} year={year} month={monthNumber} />

      <div className={`${CARD} !rounded-2xl px-[15px] py-3.5`}>
        <div className="flex items-baseline gap-1.5">
          <span className={TITLE}>Lợi nhuận từ các tòa theo tháng</span>
          <span className={SUB}>năm {year}</span>
          <span className="ml-auto font-mono text-[12px] font-bold text-[#0e7a47]">{fmtShort(yearTotal)}</span>
        </div>
        <div className="mt-3.5">
          <MonthBars values={monthVals} month={month} onMonthChange={setMonth} areaHeight={120} barMax={76} />
        </div>
      </div>

      <div className={`${CARD} !rounded-2xl px-[15px] py-3.5`}>
        <div className="flex flex-col">
          <span className={TITLE}>Theo nhà</span>
          <span className={SUB}>{scopeLabel}</span>
        </div>
        {bldRows.length === 0 ? (
          <p className="mt-3 mb-0 text-[12.5px] font-semibold text-[#8d8678]">Chưa có dữ liệu trong {scopeLabel}.</p>
        ) : (
          <div className="flex flex-col gap-2.5 mt-3">
            {bldRows.map((b) => (
              <div key={b.key} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-[3px] shrink-0" style={{ background: b.color }} />
                  <span className="font-mono text-[12.5px] font-bold text-[#1b1813] flex-1 min-w-0 truncate">{b.name}</span>
                  <span className="font-mono text-[12.5px] font-bold text-[#1b1813]">{fmtShort(b.value)}</span>
                  <span className="font-mono text-[11px] font-bold text-[#8d8678] w-12 text-right">{b.pct.toFixed(1)}%</span>
                </div>
                <div className="h-[7px] rounded-full bg-[#efece4] overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${b.fill}%`, background: b.color }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={`${CARD} !rounded-2xl overflow-hidden`}>
        <div className="flex items-baseline gap-1.5 px-[15px] pt-3.5 pb-2.5">
          <span className={TITLE}>Được chia Nhà × Tháng</span>
          <span className="ml-auto text-[10px] font-bold text-[#8d8678] bg-[#faf8f4] border border-[#efece4] rounded-md px-1.5 py-0.5">triệu ₫</span>
        </div>
        {matrix.length > 0 ? (
          <BuildingMatrix
            heads={columns.map((c) => c.name)}
            rows={matrix.map((r) => ({ m: r.excluded ? `T${r.month}*` : `T${r.month}`, cells: r.cells, total: r.total }))}
          />
        ) : (
          <p className="m-0 px-[15px] pb-4 pt-1 text-[12.5px] font-semibold text-[#8d8678]">Chưa có phần chia trong {scopeLabel}.</p>
        )}
        {marker && matrix.some((r) => r.excluded) && (
          <p className="m-0 px-[15px] pb-3 text-[11px] font-semibold text-[#8d8678]">* Đã đối chiếu đến hết {marker}.</p>
        )}
      </div>

      <MySettlementsMobile view={positionView} />

      <div className={`${CARD} !rounded-2xl overflow-hidden`}>
        <div className="flex items-center gap-2 px-[15px] py-3.5 border-b border-[#efece4]">
          <span className={TITLE}>Phiếu chi lợi nhuận và tạm ứng</span>
          <span className="ml-auto font-mono text-[12px] font-bold text-[#c97a10]">ứng {fmtShort(voucherTotals.advance)} · chi lợi nhuận {fmtShort(voucherTotals.cash)}</span>
        </div>
        {payouts.length === 0 && !ledger.historical_advances?.length && <p className={EMPTY}>Chưa có phiếu chi lợi nhuận hay tạm ứng nào.</p>}
        {payouts.map((p) => {
          const target = cancelTargetFromMyPayout(p, { organizationId: ledger.organization_id, subjectName: ledger.shareholder.name });
          return (
            <div key={p.voucher_id} className={`flex items-center gap-[11px] px-[15px] py-[11px] border-b border-[#f4f1ea] last:border-b-0${p.excluded_by_marker ? ' opacity-60' : ''}`}>
              <span className="w-8 h-8 rounded-[10px] bg-[#fbf1da] text-[#c97a10] grid place-items-center shrink-0">
                <HandCoins className="h-[15px] w-[15px]" />
              </span>
              <div className="flex-1 min-w-0 flex flex-col gap-px">
                {/* Xuống dòng thay vì cắt "· Tạm ứng" (chữ mang nghĩa). */}
                <span className="text-[12.5px] font-bold leading-snug text-[#1b1813] [overflow-wrap:anywhere]">
                  {p.voucher_code ?? 'Phiếu chi'} · {payoutStatusLabel(p)}{p.is_advance ? ' · Tạm ứng' : ''}
                </span>
                <span className="font-mono text-[10.5px] font-bold text-[#8d8678]">{formatISODateVN(p.voucher_date)}{p.excluded_by_marker ? ' · trước mốc' : ''}</span>
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0">
                <span className="font-mono text-[13px] font-bold text-[#c97a10] whitespace-nowrap">{fmtShort(p.amount)}</span>
                {target && (
                  <button
                    type="button"
                    onClick={() => { setCancelTarget(target); setCancelOpen(true); }}
                    className="rounded-lg border border-[#e7e3da] bg-white px-2 py-0.5 text-[11px] font-bold text-[#514c42]"
                  >
                    Huỷ yêu cầu
                  </button>
                )}
              </div>
            </div>
          );
        })}
        <HistoricalAdvanceList receipts={ledger.historical_advances} />
      </div>
      {ledger.salary.length > 0 && (
        <div className={`${CARD} !rounded-2xl overflow-hidden`}>
          <div className="px-[15px] py-3.5 border-b border-[#efece4]"><span className={TITLE}>Lợi nhuận trả qua lương</span></div>
          {ledger.salary.map((s) => (
            <div key={s.period_month} className={`flex items-center gap-2 px-[15px] py-[10px] border-b border-[#f4f1ea] last:border-b-0${s.excluded_by_marker ? ' opacity-60' : ''}`}>
              <span className="font-mono text-[12px] font-bold text-[#514c42] flex-1">{periodLabel(s.period_month)}</span>
              <span className="font-mono text-[12.5px] font-bold text-[#1b1813]">{fmtShort(s.investment)}</span>
              {s.advance_offset > 0 && <span className="font-mono text-[11px] font-bold text-[#8d8678]">trừ ứng {fmtShort(s.advance_offset)}</span>}
            </div>
          ))}
        </div>
      )}

      {percentRows && (
        <div className={`${CARD} !rounded-2xl overflow-hidden`} data-testid="self-percent-card">
          <div className="px-[15px] py-3.5 border-b border-[#efece4]"><span className={TITLE}>Tỷ lệ của bạn</span></div>
          {percentRows.length === 0 && <p className={EMPTY}>Chưa có tỷ lệ chia ở toà nào.</p>}
          {percentRows.map((r) => (
            <div key={r.building_id} className="flex items-center gap-2 px-[15px] py-[10px] border-b border-[#f4f1ea] last:border-b-0">
              <span className="text-[12.5px] font-bold text-[#1b1813] flex-1 min-w-0 truncate">{r.building_name ?? '—'}</span>
              <span className="font-mono text-[12.5px] font-bold text-[#2b5aa0]">{r.percent.toLocaleString('vi-VN', { maximumFractionDigits: 2 })}%</span>
            </div>
          ))}
        </div>
      )}

      {buildingTotals && (
        <div className={`${CARD} !rounded-2xl overflow-hidden`} data-testid="self-building-totals-card">
          <div className="px-[15px] py-3.5 border-b border-[#efece4] flex flex-col">
            <span className={TITLE}>Doanh thu · lợi nhuận toà đã chốt</span>
            <span className={SUB}>{scopeLabel}</span>
          </div>
          {buildingTotals.length === 0 && <p className={EMPTY}>Chưa có tháng nào đã chốt trong {scopeLabel}.</p>}
          {buildingTotals.map((t) => (
            <div key={`${t.period_month}:${t.building_id}`} className="flex flex-col gap-0.5 px-[15px] py-[10px] border-b border-[#f4f1ea] last:border-b-0">
              <div className="flex items-center gap-2">
                <span className="text-[12.5px] font-bold text-[#1b1813] flex-1 min-w-0 truncate">{t.building_name ?? '—'}</span>
                <span className="font-mono text-[10.5px] font-bold text-[#8d8678]">{periodLabel(t.period_month)}</span>
              </div>
              <span className="font-mono text-[11px] font-bold text-[#514c42]">
                Thu {t.revenue === null ? '—' : fmtShort(t.revenue)} · Chi {t.expense === null ? '—' : fmtShort(t.expense)} · LN {fmtShort(t.profit)}
              </span>
            </div>
          ))}
        </div>
      )}

      {access.canAdvanceOwn && (
        <ProfitSelfAdvanceDialog
          open={advanceOpen}
          onOpenChange={setAdvanceOpen}
          organizationId={ledger.organization_id}
          me={{ shareholderId: ledger.shareholder.id, name: ledger.shareholder.name }}
        />
      )}
      <ProfitPayoutCancelDialog open={cancelOpen} onOpenChange={setCancelOpen} target={cancelTarget} />
    </div>
  );
}
