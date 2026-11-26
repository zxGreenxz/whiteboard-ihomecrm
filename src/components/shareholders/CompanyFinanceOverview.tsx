import { ProfitHubSlot } from '@/pages/reports/finance/ProfitHubShell';
import { useState, type ReactNode } from 'react';
import { useQueries } from '@tanstack/react-query';
import { useOrganization } from '@/contexts/OrganizationContext';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import {
  shareholderEntryOptions,
  useShareholderProfitLedger,
  useShareholderProfitPositions,
} from '@/hooks/profit-ledger/useProfitLedgerQueries';
import { useHousePool } from '@/hooks/profit-ledger/useHousePool';
import { useSharedFund } from '@/hooks/profit-ledger/useSharedFund';
import {
  closingExplanation,
  inOverviewPeriod,
  flowTotal,
  overviewBalances,
  overviewVouchers,
  type OverviewFlow,
} from '@/lib/profitLedger/overviewFlows';
import { periodLabel } from '@/lib/profitLedger/selfView';
import {
  FinanceOverview,
  OverviewLines,
  OverviewPeriod,
  overviewMoney,
  type OverviewItems,
  type OverviewLine,
} from './FinanceOverview';
import { currentYear } from './shareholderUtils';

type CompanyOverviewProps = { year?: number; onYearChange?: (n: number) => void; children: ReactNode };
export function CompanyFinanceOverview(props: CompanyOverviewProps) {
  const { selectedOrganizationId } = useOrganization();
  return <CompanyOverviewBody key={selectedOrganizationId} {...props} />;
}
function CompanyOverviewBody({ year: externalYear, onYearChange, children }: CompanyOverviewProps) {
  const { selectedOrganizationId: org, organization } = useOrganization();
  const { data: permissions } = useMyPermissions();
  const [localYear, setYear] = useState(currentYear);
  const year = externalYear ?? localYear;
  const [month, setMonth] = useState<number | null>(null);
  const [chosen, setChosen] = useState('');
  const ledger = useShareholderProfitLedger(org);
  const positions = useShareholderProfitPositions(org, {
    enabled: !!ledger.data && ledger.data.route !== 'LEGACY',
  });
  const holders = ledger.data?.shareholders ?? [];
  const selected = holders.filter((h) => !chosen || h.shareholder_id === chosen);
  const entries = useQueries({
    queries: selected.map((h) => shareholderEntryOptions(org, h.shareholder_id)),
  });
  const canFund =
    !!org &&
    organization?.id === org &&
    organization.memberType === 'OWNER' &&
    canUse(permissions, 'shareholder_profit', 'distribute');
  const shared = useSharedFund(canFund ? org : '');
  const pool = useHousePool(canFund ? org : '', canFund ? 10000 : 0);
  const scope = month ? 'T' + month + '/' + year : 'Năm ' + year;
  const inScope = (s: string | null | undefined) => !!s && inOverviewPeriod(s, year, month);
  const complete =
    !!ledger.data && ledger.data.route !== 'LEGACY' && entries.every((q) => q.data && !q.isError);
  const profit: OverviewFlow[] = [],
    payout: OverviewFlow[] = [],
    advance: OverviewFlow[] = [];
  const balances: OverviewLine[] = [];
  const availableYears = new Set([year, currentYear()]);
  const alerts = [ledger, positions, ...entries, ...(canFund ? [shared, pool] : [])].filter((q) => q.isError);
  for (const { data: doc } of entries) {
    if (!doc) continue;
    const name = doc.shareholder.name;
    const history = doc.historical_advances ?? [];
    const allocations = doc.entries
      .filter((e) => e.kind === 'ALLOCATION' && e.period_month)
      .map((e) => ({
        key: e.key,
        period: e.period_month!,
        title: name,
        note: periodLabel(e.period_month!) + ' · ' + (e.building_name ?? 'Phân bổ đã chốt'),
        amount: e.amount,
        counted: true,
      }));
    for (const r of history)
      if (r.external_profit !== null && !allocations.some((a) => a.period === r.period_month))
        allocations.push({
          key: r.id,
          period: r.period_month,
          title: name,
          note: periodLabel(r.period_month) + ' · theo đối chiếu',
          amount: r.external_profit,
          counted: true,
        });
    const settledMonths = new Map(doc.settlement_periods?.map(s => [s.voucher_id,s.month]));
    const vouchers = doc.entries
      .filter((e) => e.kind === 'PAYOUT' && e.voucher_id)
      .map((e) => ({
        voucher_id: e.voucher_id!,
        settlementMonth: settledMonths.get(e.voucher_id!),
        voucher_code: e.voucher_code,
        voucher_date: e.voucher_date,
        amount: -e.amount,
        status: e.voucher_status,
        posting_status: e.posting_status,
        is_advance: e.is_advance,
        is_mine: e.is_mine,
        is_mine_pending: false,
        excluded_by_marker: e.excluded_by_marker,
      }));
    const flows = overviewVouchers(vouchers, history, []);
    const salary = doc.entries
      .filter((e) => e.period_month && (e.kind === 'SALARY' || e.kind === 'SALARY_OFFSET'))
      .map((e) => ({
        period_month: e.period_month!,
        investment: e.kind === 'SALARY' ? -e.amount : 0,
        advance_offset: e.kind === 'SALARY_OFFSET' ? e.amount : 0,
        excluded_by_marker: e.excluded_by_marker,
      }));
    for (const r of [...allocations, ...flows.profit, ...flows.advances])
      if (r.period) availableYears.add(Number(r.period.slice(0, 4)));
    profit.push(...allocations.filter((r) => inScope(r.period)));
    for (const [target, rows] of [
      [payout, flows.profit],
      [advance, flows.advances],
    ] as const)
      target.push(
        ...rows.filter((r) => inScope(r.period)).map((r) => ({ ...r, note: name + ' · ' + r.note })),
      );
    const pos = positions.data?.shareholders.find((p) => p.shareholder_id === doc.shareholder.shareholder_id);
    const amounts = overviewBalances(
      { marker: doc.marker, salary, historical_advances: history },
      pos ?? null,
      allocations,
      flows.profit,
      flows.advances,
    );
    const observed = [...allocations, ...flows.profit, ...flows.advances]
      .map((r) => r.period)
      .concat(
        salary.map((s) => s.period_month),
        [...amounts.keys()],
      )
      .filter(inScope)
      .sort();
    const cutoff = observed.at(-1);
    const end = cutoff ? amounts.get(cutoff) : undefined;
    const origin = closingExplanation(
      end,
      cutoff,
      doc.marker?.settled_through_month,
      pos?.components.opening_advance,
      flows.advances,
      allocations,
    );
    balances.push({
      key: doc.shareholder.shareholder_id,
      title: name,
      amount: end ?? null,
      note:
        (cutoff ? 'Hết ' + periodLabel(cutoff) + ' · ' : '') +
        (origin
          ? 'Dư do ứng ' +
            overviewMoney(origin.fromAdvance) +
            ' · ' +
            (origin.negativeProfit ? 'lợi nhuận âm hoặc chi vượt ' : 'chi vượt ') +
            overviewMoney(origin.fromOther) +
            ' · '
          : '') +
        (pos
          ? 'Sổ hiện tại · lợi nhuận chưa chốt ' +
            overviewMoney(pos.unpaid_profit) +
            ' · ứng chưa cấn ' +
            overviewMoney(pos.advance_outstanding) +
            ' · ứng chờ duyệt ' +
            overviewMoney(pos.advance_pending)
          : 'Chưa đọc được vị thế'),
    });
  }
  const totals = (rows: OverviewFlow[]) => (complete ? flowTotal(rows) : null);
  const items: OverviewItems = {
    profit: {
      amount: totals(profit),
      caption: scope + ' · lợi nhuận phân bổ',
      detail: <OverviewLines rows={profit} />,
    },
    payout: {
      amount: totals(payout),
      caption: scope + ' · phiếu lợi nhuận đã ghi chi',
      detail: <OverviewLines rows={payout} />,
    },
    advance: {
      amount: totals(advance),
      caption: scope + ' · ứng theo kỳ lợi nhuận',
      detail: <OverviewLines rows={advance} />,
    },
    balance: {
      amount:
        complete && balances.length && balances.every((r) => r.amount != null)
          ? balances.reduce((n, r) => n + r.amount!, 0)
          : null,
      caption: scope + ' · số dư cuối kỳ đã đối chiếu',
      detail: <OverviewLines rows={balances} empty="Chưa có số dư kỳ để đối chiếu." />,
    },
  };
  if (canFund) {
    const fund = shared.data;
    const houses = pool.data;
    const batches = houses?.batches ?? [];
    const matched = fund?.expense_vouchers ?? [];
    const linked = new Set(matched.map((v) => v.source_id));
    const batchIds = new Set(batches.map((b) => b.voucher_id));
    const expenses = houses?.expenses ?? [];
    const poolVoucherIds = new Set([...batchIds, ...expenses.map((e) => e.id)]);
    const distinct = new Map(matched.filter((v) => !poolVoucherIds.has(v.id)).map((v) => [v.id, v]));
    const charges = expenses.filter((e) => !batchIds.has(e.id) && inScope(e.date));
    const posted = [...distinct.values()].filter((v) => inScope(v.date));
    const fundBatches = batches.filter((b) => inScope(b.date));
    const cashTotal =
      posted.reduce((n, v) => n + (v.status === 'APPROVED' && v.posting === 'POSTED' ? v.amount : 0), 0) +
      charges.reduce((n, e) => n + (e.live ? e.amount : 0), 0) +
      fundBatches.reduce((n, b) => n + (b.state === 'PAID' ? b.total : 0), 0);
    const activity: OverviewLine[] = [
      ...posted.map((v) => ({
        key: v.id,
        title: (v.code ?? 'Phiếu chi') + ' · ' + v.name,
        date: v.date,
        amount: v.amount,
        note:
          (v.account ?? 'Chưa xác định sổ') +
          ' · ' +
          (v.status === 'APPROVED' && v.posting === 'POSTED' ? 'Đã ghi chi' : 'Chưa ghi chi'),
      })),
      ...charges.map((e) => ({
        key: e.id, date: e.date, title: e.code ?? 'Phiếu chi từ quỹ góp',
        amount: e.amount, note: e.live ? 'Chi từ quỹ góp · đã ghi sổ' : 'Liên kết quỹ đã hết hiệu lực',
      })),
      ...fundBatches.map((b) => ({
        key: b.id,
        title: b.code ?? 'Phiếu hoàn quỹ',
        date: b.date,
        amount: b.total,
        note:
          'Hoàn quỹ góp · ' +
          { PAID: 'Đã ghi chi', RESERVED: 'Chờ ghi chi', RELEASED: 'Đã giải phóng khoản giữ' }[b.state],
      })),
    ].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
    const sourceDebits =
      fund?.sources.filter((s) => s.kind === 'DEBIT' && inScope(s.effective_date) && !linked.has(s.id)) ?? [];
    const houseAvailable = houses?.quote.lines.reduce((n, l) => n + l.available, 0);
    items.fund = {
      amount: houses?.rules.length
        ? (houseAvailable ?? null)
        : fund?.has_opening
          ? fund.available_amount
          : null,
      caption: houses?.rules.length ? 'Hiện tại · quỹ góp theo nhà' : 'Hiện tại · nguồn quỹ khả dụng',
      detail: (
        <>
          <OverviewLines
            rows={[
              {
                key: 'source',
                title: 'Nguồn quỹ đã đối chiếu',
                amount: fund?.has_opening ? fund.available_amount : null,
              },
              ...(houses?.quote.lines ?? []).map((l) => ({
                key: l.shareholder_id,
                title: l.name,
                amount: l.available,
                note:
                  'Quỹ góp theo nhà · đã góp ' +
                  overviewMoney(l.contributed) +
                  ' · chờ hoàn ' +
                  overviewMoney(l.reserved),
              })),
            ]}
          />
          <h4 className="font-semibold">Phân phối quỹ trong kỳ</h4>
          <OverviewLines
            rows={
              fund?.distributions
                .filter((d) => inScope(d.effective_date))
                .map((d) => ({
                  key: d.id,
                  title: d.reference,
                  date: d.effective_date,
                  amount: d.amount,
                  note:
                    'Cấn ứng ' +
                    overviewMoney(d.advance_offset_amount) +
                    ' · còn phải trả ' +
                    overviewMoney(d.payable_amount),
                })) ?? []
            }
          />
        </>
      ),
    };
    items.expenses = {
      amount: fund?.expense_vouchers && houses ? cashTotal : null,
      caption: scope + ' · phiếu chi của toàn quỹ',
      detail: (
        <>
          <OverviewLines rows={activity} />
          {sourceDebits.length > 0 && (
            <>
              <h4 className="font-semibold">Ghi giảm nguồn chưa khớp phiếu tiền</h4>
              <OverviewLines
                rows={sourceDebits.map((s) => ({
                  key: s.id,
                  date: s.effective_date,
                  title: s.reference,
                  note: s.evidence,
                  amount: s.amount,
                }))}
              />
            </>
          )}
          {!fund?.expense_vouchers && (
            <p className="text-sm text-muted-foreground">
              Chưa có dữ liệu liên kết phiếu chi với chứng từ ghi giảm nguồn.
            </p>
          )}
        </>
      ),
    };
  }
  return (
    <>
      <ProfitHubSlot name="overview">
        <FinanceOverview
          title="Tổng quan lợi nhuận cổ đông"
          items={items}
          controls={
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={chosen}
                aria-label="Cổ đông đối chiếu"
                onChange={(e) => setChosen(e.target.value)}
                className="rounded-md border bg-background px-2 py-2 text-sm"
              >
                <option value="">Tất cả cổ đông</option>
                {holders.map((h) => (
                  <option key={h.shareholder_id} value={h.shareholder_id}>
                    {h.name}
                  </option>
                ))}
              </select>
              <OverviewPeriod
                year={year}
                month={month}
                years={[...availableYears].sort((a, b) => b - a)}
                onYear={onYearChange ?? setYear}
                onMonth={setMonth}
              />
            </div>
          }
        >
          {alerts.length > 0 && (
            <p role="alert">
              Một phần sổ chưa tải được.{' '}
              <button className="underline" onClick={() => alerts.forEach((q) => void q.refetch())}>
                Tải lại
              </button>
            </p>
          )}
          {!complete && !alerts.length && (
            <p role="status">
              {ledger.data?.route === 'LEGACY'
                ? 'Sổ tổng chưa bật. Có thể mở báo cáo phân bổ bên dưới.'
                : 'Đang đối chiếu sổ cổ đông…'}
            </p>
          )}
        </FinanceOverview>
      </ProfitHubSlot>
      {children}
    </>
  );
}
