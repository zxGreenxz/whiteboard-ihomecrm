// Cổ đông TỰ XEM theo SỔ TỔNG (E3) — máy tính. Chỉ mount khi máy chủ báo sổ tổng đã chạy (`ready`).
// Hiện TIỀN CỦA CHÍNH MÌNH: được chia (sau mốc đã trả đủ), đã nhận, đang chờ duyệt, trả qua lương, hai con
// số của vị thế (R2) "Lợi nhuận chưa chi" · "Tạm ứng đang có", các lần chủ chốt chi lợi nhuận, lịch sử
// phiếu. Tỷ lệ % CHỈ hiện khi chủ cấp quyền riêng VÀ máy chủ gửi
// kèm mảng tương ứng (thiếu quyền ⇒ máy chủ bỏ hẳn khoá). Thẻ "Doanh thu và lợi nhuận toà đã chốt" đã bỏ
// khỏi màn máy tính (chủ yêu cầu 16/11/2026); bảng Nhà × Tháng có bộ lọc nhà người xem tự tạo.

import { useMemo, useState } from 'react';
import ShareholderPeriodStatement from './ShareholderPeriodStatement';
import { flowTotal, overviewVouchers } from '@/lib/profitLedger/overviewFlows';
import { HistoricalAdvanceList } from './HistoricalAdvanceList';
import { periodStatement, postedCash } from '@/lib/profitLedger/periodStatement';
import { HandCoins } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useMyPositionView } from '@/hooks/profit-ledger/useMyPositionView';
import { useBuildingFilterState } from '@/hooks/useBuildingFilterState';
import { formatCurrency } from '@/lib/utils';
import { formatISODateVN } from '@/lib/vnDate';
import { ProfitHubSlot } from '@/pages/reports/finance/ProfitHubShell';
import { activeBuildingFilter, applyBuildingFilter } from '@/lib/profitLedger/buildingFilters';
import type { MyProfitLedger } from '@/lib/profitLedger/ledgerReaders';
import {
  advancePendingText, isUnpaidNegative, POSITION_LABELS, settlementCashPendingText, UNPAID_NEGATIVE_NOTE,
} from '@/lib/profitLedger/positionView';
import {
  amountsByBuilding, buildingColumns, buildingMatrix, ledgerYears, monthlyAmounts, monthsInScope, newestFirst,
  payoutStatusLabel, periodLabel, salaryNet, selfAdvanceBlockedNote,
} from '@/lib/profitLedger/selfView';
import { cancelTargetFromMyPayout, type ProfitPayoutCancelTarget } from '@/lib/profitLedger/vouchers';
import { BuildingFilterBar } from './BuildingFilterBar';
import { DonutBreakdown, MiniBars } from './profitCharts';
import { ProfitPayoutCancelDialog } from './ProfitPayoutCancelDialog';
import ProfitSelfAdvanceDialog from './ProfitSelfAdvanceDialog';
import { MyFundBreakdown, MyPositionError, MySettlementsCard } from './ShareholderSelfPosition';
import { currentYear } from './shareholderUtils';

const ALL = 'all';
const MUTED = { color: 'var(--ph-ink-4)' } as const;

export interface ShareholderSelfAccess {
  /** shareholder_profit.view_percent — thẻ "Tỷ lệ của bạn". */
  canViewPercent: boolean;
  /** shareholder_profit.view_building_totals — thẻ số toà ở màn điện thoại (màn máy tính đã bỏ thẻ này). */
  canViewBuildingTotals: boolean;
  /** shareholder_profit.advance_own_cashbook — nút "Chi tạm ứng cho tôi". */
  canAdvanceOwn: boolean;
}

export default function ShareholderLedgerSelfView({ ledger, access }: { ledger: MyProfitLedger; access: ShareholderSelfAccess }) {
  const [year, setYear] = useState(currentYear());
  const [month, setMonth] = useState<string>(ALL); // "all" | "1".."12"
  const [advanceOpen, setAdvanceOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<ProfitPayoutCancelTarget | null>(null);

  const monthNumber = month === ALL ? null : Number(month);
  // Hai con số của vị thế (R2) + các lần chốt. Chưa có số ⇒ "—", không hiện 0.
  const positionView = useMyPositionView(ledger.organization_id);
  const position = positionView.position;
  const unpaidNegative = !!position && isUnpaidNegative(position);
  const viaSalary = salaryNet(ledger);
  const advanceNote = selfAdvanceBlockedNote(ledger.route);
  const years = useMemo(() => ledgerYears(ledger, currentYear()), [ledger]);
  const yearMonths = useMemo(() => monthsInScope(ledger.months, year, null), [ledger.months, year]);
  const scopedMonths = useMemo(() => monthsInScope(ledger.months, year, monthNumber), [ledger.months, year, monthNumber]);
  const yearTotal = yearMonths.reduce((s, m) => s + m.amount, 0);
  const allBuildings = useMemo(() => buildingColumns(ledger.months), [ledger.months]);
  const buildingsEver = allBuildings.length;
  const filterStore = useBuildingFilterState(ledger.organization_id, ledger.shareholder.id);
  const filters = filterStore.state;
  const activeFilter = activeBuildingFilter(filters);

  const monthlyChart = useMemo(
    () => monthlyAmounts(ledger.months, year).map((value, i) => ({ label: `T${i + 1}`, value: value ?? 0, empty: value === null || value === 0 })),
    [ledger.months, year],
  );
  const highlightMonth = monthNumber !== null ? monthNumber - 1 : year === currentYear() ? new Date().getMonth() : undefined;
  const byBuilding = useMemo(() => amountsByBuilding(scopedMonths).map(({ name, value }) => ({ name, value })), [scopedMonths]);
  const columns = useMemo(() => buildingColumns(scopedMonths), [scopedMonths]);
  const matrix = useMemo(() => buildingMatrix(scopedMonths, columns), [scopedMonths, columns]);
  // Bộ lọc nhà chỉ đổi cột được bày ở bảng Nhà × Tháng; KPI, biểu đồ và phiếu giữ nguyên toàn bộ.
  const shown = useMemo(() => applyBuildingFilter(columns, matrix, activeFilter?.keys ?? null), [columns, matrix, activeFilter]);

  const periodStatus = useMemo(() => position ? periodStatement(ledger, position).periods : null, [ledger, position]);
  const selection = activeFilter ? { name: activeFilter.name, amounts: new Map(shown.rows.map(r => [r.period, r.total])) } : undefined;
  const payouts = useMemo(() => newestFirst(ledger.payouts), [ledger.payouts]);
  const voucherTotals = useMemo(() => {
    const flows = overviewVouchers(ledger.payouts, ledger.historical_advances ?? [], positionView.position?.settlements ?? []);
    return { advance: flowTotal(flows.advances), cash: flowTotal(flows.profit) };
  }, [ledger.payouts, ledger.historical_advances, positionView.position]);
  // Thẻ nhạy cảm: cần CẢ quyền của người xem LẪN khoá máy chủ gửi (thiếu một trong hai ⇒ không thẻ).
  const percentRows = access.canViewPercent ? ledger.percent_rows : undefined;
  const marker = ledger.marker ? periodLabel(ledger.marker.settled_through_month) : null;
  const scopeText = monthNumber === null ? `năm ${year}` : `tháng ${monthNumber}/${year}`;

  const openCancel = (target: ProfitPayoutCancelTarget) => { setCancelTarget(target); setCancelOpen(true); };

  return (
    <>
      <ProfitHubSlot name="kpis">
        <div className="ph-kpi ph-kpi--flex">
          <div className="ph-kpi__label">Cổ đông</div>
          <div className="ph-kpi__value">{ledger.shareholder.name}</div>
          <div className="ph-kpi__sub">{buildingsEver > 0 ? `${buildingsEver} nhà có phần chia` : 'chưa có phần chia từ tòa'}</div>
        </div>
        <div className="ph-kpi__div" />
        <div className="ph-kpi ph-kpi--flex" data-testid="self-kpi-allocated">
          <div className="ph-kpi__label">Được chia từ tòa</div>
          <div className="ph-kpi__value ph-kpi__value--mint">{formatCurrency(ledger.allocated)}</div>
          <div className="ph-kpi__sub">{marker ? `sau mốc đối chiếu hết ${marker}` : 'luỹ kế các tháng đã chốt'}</div>
          <div className="ph-kpi__sub ph-kpi__sub--mint">Năm {year}: {formatCurrency(yearTotal)}</div>
        </div>
        <div className="ph-kpi__div" />
        <div className="ph-kpi ph-kpi--flex" data-testid="self-kpi-paid">
          <div className="ph-kpi__label">Đã chi qua phiếu</div>
          <div className="ph-kpi__value ph-kpi__value--gold">{formatCurrency(postedCash(ledger.payouts))}</div>
          <div className="ph-kpi__sub">
            {marker ? 'Phiếu tiền ghi sổ sau mốc đối chiếu' : 'Gồm tiền ứng và chi lợi nhuận đã ghi sổ'}
          </div>
        </div>
        {viaSalary !== null && (
          <>
            <div className="ph-kpi__div" />
            <div className="ph-kpi ph-kpi--flex" data-testid="self-kpi-salary">
              <div className="ph-kpi__label">Qua lương</div>
              <div className="ph-kpi__value">{formatCurrency(viaSalary)}</div>
              <div className="ph-kpi__sub">
                {ledger.advance_recovered > 0
                  ? `trả qua lương ${formatCurrency(ledger.paid_via_salary)} · trừ tạm ứng ${formatCurrency(ledger.advance_recovered)}`
                  : 'phần lợi nhuận trong phiếu lương'}
              </div>
            </div>
          </>
        )}
        <div className="ph-kpi__div" />
        <div className="ph-kpi ph-kpi--flex" data-testid="self-kpi-unpaid" title={unpaidNegative ? UNPAID_NEGATIVE_NOTE : undefined}>
          <div className="ph-kpi__label">Lợi nhuận chưa chốt chi</div>
          <div className={`ph-kpi__value${unpaidNegative ? ' ph-kpi__value--peach' : ''}`}>
            {position ? formatCurrency(position.unpaid_profit) : positionView.pending ? <span className="ph-kpi__skel" aria-label="Đang tải lợi nhuận chưa chi" /> : '—'}
          </div>
          <div className="ph-kpi__sub">
            {position
              ? settlementCashPendingText(position, formatCurrency) ?? (unpaidNegative ? 'đã nhận nhiều hơn phần được chia' : 'chờ chủ chốt chi')
              : positionView.pending ? '' : 'chưa tải được'}
          </div>
        </div>
        <div className="ph-kpi__div" />
        <div className="ph-kpi ph-kpi--flex" data-testid="self-kpi-advance">
          <div className="ph-kpi__label">{POSITION_LABELS.advance}</div>
          <div className="ph-kpi__value ph-kpi__value--gold">
            {position ? formatCurrency(position.advance_outstanding) : positionView.pending ? <span className="ph-kpi__skel" aria-label="Đang tải tạm ứng đang có" /> : '—'}
          </div>
          <div className="ph-kpi__sub">
            {position
              ? advancePendingText(position, formatCurrency) ?? 'khấu trừ khi chủ chốt chi'
              : positionView.pending ? '' : 'chưa tải được'}
          </div>
        </div>
      </ProfitHubSlot>

      <div className="ph-stack">
        <div className="ph-toolbar">
          <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
            <SelectTrigger className="ph-control" aria-label="Chọn năm"><SelectValue /></SelectTrigger>
            <SelectContent>{years.map((y) => <SelectItem key={y} value={String(y)}>Năm {y}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={month} onValueChange={setMonth}>
            <SelectTrigger className="ph-control" aria-label="Chọn tháng"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Cả năm</SelectItem>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <SelectItem key={m} value={String(m)}>Tháng {m}</SelectItem>)}
            </SelectContent>
          </Select>
          {access.canAdvanceOwn && (
            <Button
              className="ph-btn-primary ml-auto"
              disabled={advanceNote !== null}
              title={advanceNote ?? undefined}
              onClick={() => setAdvanceOpen(true)}
            >
              <HandCoins className="h-4 w-4" />Chi tạm ứng cho tôi
            </Button>
          )}
        </div>
        {access.canAdvanceOwn && advanceNote && <div className="ph-hint" role="note">{advanceNote}</div>}
        <MyPositionError view={positionView} />
        <MyFundBreakdown view={positionView} />
        {unpaidNegative && <div className="ph-hint" role="note">{UNPAID_NEGATIVE_NOTE}</div>}

        <ShareholderPeriodStatement ledger={ledger} view={positionView} year={year} month={monthNumber} selection={selection} />
        <div className="ph-grid-2">
          <div className="ph-card ph-card__pad">
            <div className="ph-card__title">Lợi nhuận từ các tòa theo tháng — {year}</div>
            <MiniBars data={monthlyChart} highlight={highlightMonth} footnote="Đơn vị: triệu ₫ · phần của bạn sau khi trừ lương điều hành" />
          </div>
          <div className="ph-card ph-card__pad">
            <div className="ph-card__title">Theo nhà — {year}{monthNumber === null ? '' : ` · T${monthNumber}`}</div>
            <DonutBreakdown data={byBuilding} caption="ĐƯỢC CHIA" />
          </div>
        </div>

        <div className="ph-card">
          <div className="ph-card__head">
            <div className="ph-card__title">LN được chia Nhà × Tháng — {year}</div>
            <BuildingFilterBar
              buildings={allBuildings}
              state={filters}
              onChange={filterStore.update}
              syncError={filterStore.syncError}
              onRetry={filterStore.retry}
            />
          </div>
          {matrix.length === 0 ? (
            <div className="ph-empty">Chưa có phần chia trong {scopeText}.</div>
          ) : shown.rows.length === 0 ? (
            <div className="ph-empty">Bộ lọc “{activeFilter?.name}” không có nhà nào có phần chia trong {scopeText}.</div>
          ) : (
            <div className="ph-tbl__scroll">
              <table className="ph-tbl">
                <thead>
                  <tr>
                    <th style={{ width: 110 }}>Tháng</th>
                    {shown.columns.map((c) => <th key={c.key} className="num">{c.name}</th>)}
                    <th className="num" title={activeFilter ? 'Tổng của các nhà đang hiện theo bộ lọc' : undefined}>
                      {activeFilter ? `Tổng ${shown.columns.length} nhà` : 'Tổng chia'}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.rows.map((row) => (
                    <tr key={row.period} className={row.month === (highlightMonth ?? -1) + 1 ? 'is-current' : undefined}>
                      <td className="name">
                        T{row.month}
                        {!row.excluded && periodStatus?.get(row.period) && <span className="ml-2 text-xs font-normal text-muted-foreground">{periodStatus.get(row.period)?.status}</span>}
                        {row.excluded && <span className="ph-inline ph-inline--soft">đã đối chiếu</span>}
                      </td>
                      {row.cells.map((v, i) => (
                        <td key={shown.columns[i]?.key ?? i} className="num">{v === null ? <span style={MUTED}>—</span> : formatCurrency(v)}</td>
                      ))}
                      <td className="num strong">{formatCurrency(row.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {marker && <div className="ph-card__note" style={{ padding: '0 18px 12px' }}>Số dư chuyển sang sau khi đối chiếu đến hết {marker}.</div>}
        </div>

        <MySettlementsCard view={positionView} />

        <div className="ph-card">
          <div className="ph-card__head">
            <div className="ph-card__title">Phiếu chi lợi nhuận và tạm ứng của bạn</div>
          </div>
          <div className="ph-tbl__scroll">
            <table className="ph-tbl">
              <thead>
                <tr>
                  <th style={{ width: 110 }}>Ngày / tháng chi</th>
                  <th>Phiếu</th>
                  <th>Trạng thái</th>
                  <th className="num" style={{ width: 140 }}>Số tiền</th>
                  <th style={{ width: 120 }} aria-label="Thao tác" />
                </tr>
              </thead>
              <tbody>
                {payouts.length === 0 && !ledger.historical_advances?.length && (
                  <tr><td colSpan={5} style={{ textAlign: 'center', ...MUTED }}>Chưa có phiếu chi lợi nhuận hay tạm ứng nào</td></tr>
                )}
                {payouts.map((p) => {
                  const target = cancelTargetFromMyPayout(p, { organizationId: ledger.organization_id, subjectName: ledger.shareholder.name });
                  return (
                    <tr key={p.voucher_id} style={p.excluded_by_marker ? { opacity: 0.6 } : undefined}>
                      <td>{formatISODateVN(p.voucher_date)}</td>
                      <td>
                        {/* Mã phiếu đứng riêng một phần tử: nhãn "Tạm ứng" là chú thích kèm, không dính vào mã (tìm / chép mã được). */}
                        <span>{p.voucher_code ?? '—'}</span>
                        {p.is_advance && <span className="ph-inline ph-inline--first">Tạm ứng</span>}
                        {p.excluded_by_marker && <span className="ph-keep" style={{ marginLeft: 4 }}>trước mốc</span>}
                      </td>
                      <td>{payoutStatusLabel(p)}</td>
                      <td className="num neg strong">{formatCurrency(p.amount)}</td>
                      <td>
                        {target && (
                          <button type="button" className="ph-mini-btn" onClick={() => openCancel(target)}>Huỷ yêu cầu</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                <HistoricalAdvanceList receipts={ledger.historical_advances} table />
              </tbody>
            </table>
          </div>
          {(payouts.length > 0 || !!ledger.historical_advances?.length) && (
            <div className="ph-card__foot">
              <b>Tổng tạm ứng {formatCurrency(voucherTotals.advance)} · Chi lợi nhuận {formatCurrency(voucherTotals.cash)}</b>
            </div>
          )}
        </div>

        {ledger.salary.length > 0 && (
          <div className="ph-card">
            <div className="ph-card__head">
              <div className="ph-card__title">Lợi nhuận trả qua lương</div>
            </div>
            <div className="ph-tbl__scroll">
              <table className="ph-tbl">
                <thead>
                  <tr>
                    <th style={{ width: 110 }}>Kỳ lương</th>
                    <th className="num">Trả qua lương</th>
                    <th className="num">Trừ tạm ứng</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.salary.map((s) => (
                    <tr key={s.period_month} style={s.excluded_by_marker ? { opacity: 0.6 } : undefined}>
                      <td className="name">
                        {periodLabel(s.period_month)}
                        {s.excluded_by_marker && <span className="ph-keep" style={{ marginLeft: 4 }}>trước mốc</span>}
                      </td>
                      <td className="num">{formatCurrency(s.investment)}</td>
                      <td className="num">{formatCurrency(s.advance_offset)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {percentRows && (
          <div className="ph-card" data-testid="self-percent-card">
            <div className="ph-card__head">
              <div className="ph-card__title">Tỷ lệ của bạn</div>
            </div>
            {percentRows.length === 0 ? (
              <div className="ph-empty">Chưa có tỷ lệ chia ở toà nào.</div>
            ) : (
              <table className="ph-tbl">
                <tbody>
                  {percentRows.map((r) => (
                    <tr key={r.building_id}>
                      <td className="name">{r.building_name ?? '—'}</td>
                      <td className="num strong">{r.percent.toLocaleString('vi-VN', { maximumFractionDigits: 2 })}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {access.canAdvanceOwn && (
        <ProfitSelfAdvanceDialog
          open={advanceOpen}
          onOpenChange={setAdvanceOpen}
          organizationId={ledger.organization_id}
          me={{ shareholderId: ledger.shareholder.id, name: ledger.shareholder.name }}
        />
      )}
      <ProfitPayoutCancelDialog open={cancelOpen} onOpenChange={setCancelOpen} target={cancelTarget} />
    </>
  );
}
