// Cổ đông TỰ XEM theo SỔ TỔNG (E3) — máy tính. Chỉ mount khi máy chủ báo sổ tổng đã chạy (`ready`).
// Hiện TIỀN CỦA CHÍNH MÌNH: được chia (sau mốc đã trả đủ), đã nhận, đang chờ duyệt, trả qua lương,
// còn được nhận / đang tạm ứng, lịch sử phiếu. Tỷ lệ % và doanh thu / lợi nhuận toà CHỈ hiện khi chủ
// cấp quyền riêng VÀ máy chủ gửi kèm mảng tương ứng (thiếu quyền ⇒ máy chủ bỏ hẳn khoá).

import { useMemo, useState } from 'react';
import { HandCoins } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatCurrency } from '@/lib/utils';
import { formatISODateVN } from '@/lib/vnDate';
import { ProfitHubSlot } from '@/pages/reports/finance/ProfitHubShell';
import type { MyProfitLedger } from '@/lib/profitLedger/ledgerReaders';
import {
  amountsByBuilding, buildingColumns, buildingMatrix, ledgerYears, monthlyAmounts, monthsInScope, newestFirst,
  payoutStatusLabel, periodLabel, periodMonthNumber, periodYear, salaryNet, selfAdvanceBlockedNote, selfBalanceView,
} from '@/lib/profitLedger/selfView';
import { cancelTargetFromMyPayout, type ProfitPayoutCancelTarget } from '@/lib/profitLedger/vouchers';
import { DonutBreakdown, MiniBars } from './profitCharts';
import ProfitDistributeDialog from './ProfitDistributeDialog';
import { ProfitPayoutCancelDialog } from './ProfitPayoutCancelDialog';
import { currentYear } from './shareholderUtils';

const ALL = 'all';
const MUTED = { color: 'var(--ph-ink-4)' } as const;

export interface ShareholderSelfAccess {
  /** shareholder_profit.view_percent — thẻ "Tỷ lệ của bạn". */
  canViewPercent: boolean;
  /** shareholder_profit.view_building_totals — thẻ doanh thu / lợi nhuận toà đã chốt. */
  canViewBuildingTotals: boolean;
  /** shareholder_profit.advance_own_cashbook — nút "Chi tạm ứng cho tôi". */
  canAdvanceOwn: boolean;
}

const dash = (value: number | null) => (value === null ? '—' : formatCurrency(value));

export default function ShareholderLedgerSelfView({ ledger, access }: { ledger: MyProfitLedger; access: ShareholderSelfAccess }) {
  const [year, setYear] = useState(currentYear());
  const [month, setMonth] = useState<string>(ALL); // "all" | "1".."12"
  const [advanceOpen, setAdvanceOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<ProfitPayoutCancelTarget | null>(null);

  const monthNumber = month === ALL ? null : Number(month);
  const balance = selfBalanceView(ledger);
  const viaSalary = salaryNet(ledger);
  const advanceNote = selfAdvanceBlockedNote(ledger.route);
  const years = useMemo(() => ledgerYears(ledger, currentYear()), [ledger]);
  const yearMonths = useMemo(() => monthsInScope(ledger.months, year, null), [ledger.months, year]);
  const scopedMonths = useMemo(() => monthsInScope(ledger.months, year, monthNumber), [ledger.months, year, monthNumber]);
  const yearTotal = yearMonths.reduce((s, m) => s + m.amount, 0);
  const buildingsEver = useMemo(() => buildingColumns(ledger.months).length, [ledger.months]);

  const monthlyChart = useMemo(
    () => monthlyAmounts(ledger.months, year).map((value, i) => ({ label: `T${i + 1}`, value: value ?? 0, empty: value === null || value === 0 })),
    [ledger.months, year],
  );
  const highlightMonth = monthNumber !== null ? monthNumber - 1 : year === currentYear() ? new Date().getMonth() : undefined;
  const byBuilding = useMemo(() => amountsByBuilding(scopedMonths).map(({ name, value }) => ({ name, value })), [scopedMonths]);
  const columns = useMemo(() => buildingColumns(scopedMonths), [scopedMonths]);
  const matrix = useMemo(() => buildingMatrix(scopedMonths, columns), [scopedMonths, columns]);

  const payouts = useMemo(() => newestFirst(ledger.payouts), [ledger.payouts]);
  const counted = ledger.payouts.filter((p) => !p.excluded_by_marker);
  // Hai thẻ nhạy cảm: cần CẢ quyền của người xem LẪN khoá máy chủ gửi (thiếu một trong hai ⇒ không thẻ).
  const percentRows = access.canViewPercent ? ledger.percent_rows : undefined;
  const buildingTotals = access.canViewBuildingTotals && ledger.building_totals
    ? ledger.building_totals.filter((t) => periodYear(t.period_month) === year && (monthNumber === null || periodMonthNumber(t.period_month) === monthNumber))
    : undefined;
  const marker = ledger.marker ? periodLabel(ledger.marker.settled_through_month) : null;
  const scopeText = monthNumber === null ? `năm ${year}` : `tháng ${monthNumber}/${year}`;

  const openCancel = (target: ProfitPayoutCancelTarget) => { setCancelTarget(target); setCancelOpen(true); };

  return (
    <>
      <ProfitHubSlot name="kpis">
        <div className="ph-kpi ph-kpi--flex">
          <div className="ph-kpi__label">Cổ đông</div>
          <div className="ph-kpi__value">{ledger.shareholder.name}</div>
          <div className="ph-kpi__sub">{buildingsEver > 0 ? `${buildingsEver} nhà có phần chia` : 'chưa có phần chia'}</div>
        </div>
        <div className="ph-kpi__div" />
        <div className="ph-kpi ph-kpi--flex" data-testid="self-kpi-allocated">
          <div className="ph-kpi__label">Được chia</div>
          <div className="ph-kpi__value ph-kpi__value--mint">{formatCurrency(ledger.allocated)}</div>
          <div className="ph-kpi__sub">{marker ? `sau mốc đã trả đủ hết ${marker}` : 'luỹ kế các tháng đã chốt'}</div>
          <div className="ph-kpi__sub ph-kpi__sub--mint">Năm {year}: {formatCurrency(yearTotal)}</div>
        </div>
        <div className="ph-kpi__div" />
        <div className="ph-kpi ph-kpi--flex" data-testid="self-kpi-paid">
          <div className="ph-kpi__label">Đã nhận</div>
          <div className="ph-kpi__value ph-kpi__value--gold">{formatCurrency(ledger.paid)}</div>
          <div className="ph-kpi__sub">
            {ledger.paid_pending > 0 ? `+ chờ duyệt ${formatCurrency(ledger.paid_pending)}` : `${counted.length} phiếu chi`}
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
        <div className="ph-kpi ph-kpi--flex" data-testid="self-kpi-balance">
          <div className="ph-kpi__label">{balance.label}</div>
          <div className={`ph-kpi__value${balance.status === 'ADVANCE' ? ' ph-kpi__value--peach' : ''}`}>{formatCurrency(balance.amount)}</div>
          <div className="ph-kpi__sub">{balance.note}</div>
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

        <div className="ph-grid-2">
          <div className="ph-card ph-card__pad">
            <div className="ph-card__title">Lợi nhuận được chia theo tháng — {year}</div>
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
          </div>
          {matrix.length === 0 ? (
            <div className="ph-empty">Chưa có phần chia trong {scopeText}.</div>
          ) : (
            <div className="ph-tbl__scroll">
              <table className="ph-tbl">
                <thead>
                  <tr>
                    <th style={{ width: 110 }}>Tháng</th>
                    {columns.map((c) => <th key={c.key} className="num">{c.name}</th>)}
                    <th className="num">Tổng chia</th>
                  </tr>
                </thead>
                <tbody>
                  {matrix.map((row) => (
                    <tr key={row.period} className={row.month === (highlightMonth ?? -1) + 1 ? 'is-current' : undefined}>
                      <td className="name">
                        T{row.month}
                        {row.excluded && <span className="ph-inline ph-inline--soft" title="Nằm trong mốc đã trả đủ — không tính vào số còn được nhận">đã trả đủ</span>}
                      </td>
                      {row.cells.map((v, i) => (
                        <td key={columns[i]?.key ?? i} className="num">{v === null ? <span style={MUTED}>—</span> : formatCurrency(v)}</td>
                      ))}
                      <td className="num strong">{formatCurrency(row.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {marker && <div className="ph-card__note" style={{ padding: '0 18px 12px' }}>Các tháng đến hết {marker} đã trả đủ theo mốc — không tính vào số còn được nhận.</div>}
        </div>

        <div className="ph-card">
          <div className="ph-card__head">
            <div className="ph-card__title">Phiếu chi lợi nhuận của bạn</div>
          </div>
          <div className="ph-tbl__scroll">
            <table className="ph-tbl">
              <thead>
                <tr>
                  <th style={{ width: 110 }}>Ngày</th>
                  <th>Phiếu</th>
                  <th>Trạng thái</th>
                  <th className="num" style={{ width: 140 }}>Số tiền</th>
                  <th style={{ width: 120 }} aria-label="Thao tác" />
                </tr>
              </thead>
              <tbody>
                {payouts.length === 0 && (
                  <tr><td colSpan={5} style={{ textAlign: 'center', ...MUTED }}>Chưa có phiếu chi lợi nhuận nào</td></tr>
                )}
                {payouts.map((p) => {
                  const target = cancelTargetFromMyPayout(p, { organizationId: ledger.organization_id, subjectName: ledger.shareholder.name });
                  return (
                    <tr key={p.voucher_id} style={p.excluded_by_marker ? { opacity: 0.6 } : undefined}>
                      <td>{formatISODateVN(p.voucher_date)}</td>
                      <td>
                        {p.voucher_code ?? '—'}
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
              </tbody>
            </table>
          </div>
          {payouts.length > 0 && (
            <div className="ph-card__foot">
              <b>Đã nhận {formatCurrency(ledger.paid)}{ledger.paid_pending > 0 ? ` · chờ duyệt ${formatCurrency(ledger.paid_pending)}` : ''}</b>
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

        {buildingTotals && (
          <div className="ph-card" data-testid="self-building-totals-card">
            <div className="ph-card__head">
              <div className="ph-card__title">Doanh thu và lợi nhuận toà đã chốt — {scopeText}</div>
            </div>
            {buildingTotals.length === 0 ? (
              <div className="ph-empty">Chưa có tháng nào đã chốt trong {scopeText}.</div>
            ) : (
              <div className="ph-tbl__scroll">
                <table className="ph-tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 90 }}>Tháng</th>
                      <th>Toà</th>
                      <th className="num">Doanh thu</th>
                      <th className="num">Chi phí</th>
                      <th className="num">Lợi nhuận</th>
                    </tr>
                  </thead>
                  <tbody>
                    {buildingTotals.map((t) => (
                      <tr key={`${t.period_month}:${t.building_id}`}>
                        <td>{periodLabel(t.period_month)}</td>
                        <td className="name">{t.building_name ?? '—'}</td>
                        <td className="num">{dash(t.revenue)}</td>
                        <td className="num">{dash(t.expense)}</td>
                        <td className="num strong">{formatCurrency(t.profit)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {access.canAdvanceOwn && (
        <ProfitDistributeDialog
          open={advanceOpen}
          onOpenChange={setAdvanceOpen}
          organizationId={ledger.organization_id}
          mode="SELF_ADVANCE"
          me={{ shareholderId: ledger.shareholder.id, name: ledger.shareholder.name }}
        />
      )}
      <ProfitPayoutCancelDialog open={cancelOpen} onOpenChange={setCancelOpen} target={cancelTarget} />
    </>
  );
}
