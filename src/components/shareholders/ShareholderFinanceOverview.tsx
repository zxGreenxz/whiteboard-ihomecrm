import { useState, type ReactNode } from 'react';
import type { MyProfitLedger } from '@/lib/profitLedger/ledgerReaders';
import type { MyPositionView } from '@/hooks/profit-ledger/useMyPositionView';
import { useMyPositionView } from '@/hooks/profit-ledger/useMyPositionView';
import {
  closingExplanation,
  flowTotal,
  inOverviewPeriod,
  overviewBalances,
  overviewProfit,
  overviewVouchers,
} from '@/lib/profitLedger/overviewFlows';
import { ledgerYears, periodLabel } from '@/lib/profitLedger/selfView';
import { ProfitHubSlot } from '@/pages/reports/finance/ProfitHubShell';
import { currentYear } from './shareholderUtils';
import {
  FinanceOverview,
  OverviewLines,
  OverviewPeriod,
  overviewMoney,
  type OverviewItems,
} from './FinanceOverview';

export function ShareholderOverviewContent({
  ledger,
  view,
  year,
  month,
  onYear,
  onMonth,
  children,
}: {
  ledger: MyProfitLedger;
  view: MyPositionView;
  year: number;
  month: number | null;
  onYear: (n: number) => void;
  onMonth: (n: number | null) => void;
  children?: ReactNode;
}) {
  const position = view.position;
  const scope = month ? 'T' + month + '/' + year : 'Năm ' + year;
  const matches = (row: { period: string }) => inOverviewPeriod(row.period, year, month);
  const allocations = overviewProfit(ledger);
  const flows = overviewVouchers(
    ledger.payouts,
    ledger.historical_advances ?? [],
    position?.settlements ?? [],
  );
  const profits = allocations.filter(matches);
  const payouts = flows.profit.filter(matches).sort((a, b) => b.period.localeCompare(a.period));
  const advances = flows.advances.filter(matches).sort((a, b) => b.period.localeCompare(a.period));
  const balances = overviewBalances(ledger, position, allocations, flows.profit, flows.advances);
  const observed = [
    ...new Set(
      [...allocations, ...flows.advances, ...flows.profit]
        .filter(matches)
        .map((r) => r.period)
        .concat(
          ledger.salary
            .filter((s) => inOverviewPeriod(s.period_month, year, month))
            .map((s) => s.period_month),
          [...balances.keys()].filter((k) => inOverviewPeriod(k, year, month)),
        ),
    ),
  ].sort();
  const cutoff = observed.at(-1);
  const balance = cutoff ? balances.get(cutoff) : undefined;
  const origin = closingExplanation(
    balance,
    cutoff,
    ledger.marker?.settled_through_month,
    position?.components.opening_advance,
    flows.advances,
    allocations,
    flows.profit,
    ledger.salary.filter(s => s.investment || s.advance_offset).map(s => s.period_month)
      .concat((position?.settlements ?? []).filter(s => s.advance_offset_amount > 0).map(s => s.through_month)),
  );
  const pool = position?.house_pool;
  const fundPayments = position?.fund_payments?.filter((r) => inOverviewPeriod(r.date, year, month));
  const charges = (position?.fund_charges ?? []).filter((r) => inOverviewPeriod(r.date, year, month));
  const expenseTotal = fundPayments && fundPayments.reduce((sum, r) => sum + (r.state === 'PAID' ? r.amount : 0), 0)
    + charges.reduce((sum, r) => sum + (r.live ? r.amount : 0), 0);
  const years = [
    ...new Set([
      ...ledgerYears(ledger, currentYear()),
      year,
      ...(position?.fund_charges ?? []).map((r) => Number(r.date.slice(0, 4))),
      ...(position?.fund_payments ?? []).map((r) => Number(r.date.slice(0, 4))),
    ]),
  ].sort((a, b) => b - a);
  const balanceRows = observed
    .slice()
    .reverse()
    .map((k) => {
      const pick = (items: typeof profits) => flowTotal(items.filter((r) => r.period === k));
      const netSalary = ledger.salary
        .filter((s) => s.period_month === k)
        .reduce((n, s) => n + s.investment - s.advance_offset, 0);
      return {
        key: k,
        title: 'Cuối kỳ ' + periodLabel(k),
        amount: balances.get(k) ?? null,
        note:
          'Lợi nhuận ' +
          overviewMoney(pick(allocations)) +
          ' · chi ' +
          overviewMoney(pick(flows.profit)) +
          ' · ứng ' +
          overviewMoney(pick(flows.advances)) +
          (netSalary ? ' · qua lương ' + overviewMoney(netSalary) : ''),
      };
    });
  const items: OverviewItems = {
    profit: {
      amount: profits.length ? flowTotal(profits) : null,
      caption: scope + ' · phần của cổ đông',
      detail: <OverviewLines rows={profits} empty="Chưa có phân bổ hoặc chứng từ lợi nhuận cho kỳ này." />,
    },
    payout: {
      amount: position ? flowTotal(payouts) : null,
      caption: scope + ' · phiếu đã ghi chi',
      detail: <OverviewLines rows={payouts} />,
    },
    advance: {
      amount: position ? flowTotal(advances) : null,
      caption: scope + ' · theo kỳ lợi nhuận',
      detail: <OverviewLines rows={advances} />,
    },
    balance: {
      amount: balance ?? null,
      caption:
        balance == null
          ? scope + ' · chưa đủ căn cứ kết chuyển'
          : 'Hết ' +
            periodLabel(cutoff!) +
            ' · ' +
            (balance < 0 ? 'cần cấn kỳ sau' : balance > 0 ? 'còn được nhận' : 'đã cân đối'),
      detail: (
        <>
          {origin && (
            <OverviewLines
              rows={[
                { key: 'from-advance', title: 'Dư do tạm ứng', amount: origin.fromAdvance },
                {
                  key: 'from-other',
                  title: origin.negativeProfit
                    ? 'Phần thiếu do lợi nhuận âm hoặc chi vượt'
                    : 'Dư do chi vượt phần lợi nhuận',
                  amount: origin.fromOther,
                },
              ]}
            />
          )}
          <OverviewLines rows={balanceRows} empty="Chưa có kỳ đối chiếu." />
          {balance == null && (
            <p className="text-sm text-muted-foreground">
              Chưa đủ chứng từ để xác định số dư ở cuối kỳ đã chọn.
            </p>
          )}
          {position && (
            <>
              <h4 className="mt-4 font-semibold">Số dư sổ hiện tại</h4>
              <OverviewLines
                rows={[
                  {
                    key: 'unpaid',
                    title:
                      position.unpaid_profit < 0
                        ? 'Phần lợi nhuận âm cần đối chiếu'
                        : 'Lợi nhuận chưa chốt chi',
                    amount: position.unpaid_profit,
                  },
                  { key: 'advance', title: 'Trừ tạm ứng chưa cấn', amount: -position.advance_outstanding },
                  {
                    key: 'pending',
                    title: 'Trừ phiếu ứng chờ duyệt theo sổ',
                    amount: -position.advance_pending,
                  },
                  { key: 'net', title: 'Số dư ròng hiện tại', amount: position.balance },
                ]}
              />
            </>
          )}
        </>
      ),
    },
    fund: {
      amount: pool?.available ?? null,
      caption: 'Hiện tại · phần góp còn khả dụng',
      detail: (
        <OverviewLines
          rows={[
            { key: 'contributed', title: 'Đã góp vào quỹ', amount: pool?.contributed ?? null },
            { key: 'reserved', title: 'Đang giữ chỗ cho phiếu hoàn', amount: pool?.reserved ?? null },
            { key: 'paid', title: 'Đã hoàn qua phiếu chi', amount: pool?.paid ?? null },
            { key: 'available', title: 'Phần còn khả dụng', amount: pool?.available ?? null },
            {
              key: 'offset',
              title: 'Phân phối quỹ dùng để cấn ứng',
              amount: position?.components?.shared_fund_offset ?? null,
            },
            {
              key: 'payable',
              title: 'Phân phối quỹ vào lợi nhuận chưa chi',
              amount: position?.components?.shared_fund_payable ?? null,
            },
          ]}
        />
      ),
    },
    expenses: {
      amount: expenseTotal ?? null,
      caption: scope + ' · phần của bạn trong chi quỹ',
      detail: fundPayments ? (
        <OverviewLines
          rows={[...charges.map((r) => ({
            key: r.id, date: r.date, title: r.code ?? 'Phiếu chi từ quỹ góp', amount: r.amount,
            note: r.live ? 'Chi từ phần quỹ góp của bạn' : 'Liên kết quỹ đã hết hiệu lực',
          })), ...fundPayments.map((r) => ({
            key: r.id,
            date: r.date,
            title: r.code ?? 'Phiếu hoàn quỹ',
            amount: r.amount,
            note: { PAID: 'Đã ghi chi', RESERVED: 'Chờ ghi chi', RELEASED: 'Đã giải phóng khoản giữ' }[
              r.state
            ],
          }))].sort((a, b) => b.date.localeCompare(a.date))}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          Chưa có dữ liệu chi tiết theo phiếu cho phần quỹ của bạn.
        </p>
      ),
    },
  };
  return (
    <>
      <ProfitHubSlot name="overview">
        <FinanceOverview
          title={'Tổng quan · ' + ledger.shareholder.name}
          items={items}
          controls={<OverviewPeriod year={year} month={month} years={years} onYear={onYear} onMonth={onMonth} />}
        />
      </ProfitHubSlot>
      {children}
    </>
  );
}

export function ShareholderFinanceOverview({
  ledger,
  year: externalYear,
  onYearChange,
  children,
}: {
  ledger: MyProfitLedger;
  year?: number;
  onYearChange?: (year: number) => void;
  children: ReactNode;
}) {
  const view = useMyPositionView(ledger.organization_id);
  const [year, setYear] = useState(currentYear);
  const [month, setMonth] = useState<number | null>(null);
  return (
    <ShareholderOverviewContent
      ledger={ledger}
      view={view}
      year={externalYear ?? year}
      month={month}
      onYear={onYearChange ?? setYear}
      onMonth={setMonth}
    >
      {children}
    </ShareholderOverviewContent>
  );
}
