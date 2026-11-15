import { QueryRegion } from "@/components/errors/QueryRegion";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatCurrency } from "@/lib/utils";
import { ProfitHubSlot } from "@/pages/reports/finance/ProfitHubShell";
import { DonutBreakdown, HBars, MiniBars } from "./profitCharts";
import { currentYear } from "./shareholderUtils";
import { useShareholders } from "@/hooks/useShareholders";
import { useBuildings } from "@/hooks/useBuildings";
import { useProfitOverviewCoverage } from "@/hooks/useProfitOverviewCoverage";
import {
  lockedSplitTitle,
  retainedKpiSub,
  splitLockedProfit,
  splitOpenNetByMonthEnd,
} from "@/lib/profitOverviewCoverage";
import { ProfitCoverageCard } from "./ProfitCoverageCard";
import {
  useProfitMonthly,
  useProfitAllocations,
  useShareholderDistributions,
  computeShareholderSummary,
} from "@/hooks/useShareholderProfit";
import { useShareholderProfitLedger } from "@/hooks/profit-ledger/useProfitLedgerQueries";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import { canUse } from "@/lib/permissionPages";
import { isProfitLedgerForbidden } from "@/lib/profitLedger/errors";
import type { ShareholderLedgerRow } from "@/lib/profitLedger/ledgerReaders";
import { ownerLedgerMode, summarizeShareholderLedger } from "@/lib/profitLedger/ownerLedgerView";
import { profitLedgerRouteState } from "@/lib/profitLedger/route";
import ProfitDistributeDialog from "./ProfitDistributeDialog";
import { ManagerLedgerSection } from "./ManagerLedgerSection";
import { ProfitLedgerMarkerDialog, type ProfitLedgerMarkerSubject } from "./ProfitLedgerMarkerDialog";
import { ProfitLedgerReadError, ProfitLedgerRouteBanner } from "./ProfitLedgerRouteBanner";
import { ShareholderLedgerSheet } from "./ShareholderLedgerSheet";
import { ShareholderLedgerTable } from "./ShareholderLedgerTable";
import { useOrganization } from "@/contexts/OrganizationContext";

const ALL = "all";

export default function ProfitOverviewTab() {
  // Sổ tổng (E1/E10) theo công ty đang chọn; biểu đồ + ma trận vẫn đọc phân bổ như cũ.
  const { selectedOrganizationId } = useOrganization();
  const [year, setYear] = useState(currentYear());
  const [month, setMonth] = useState<string>(ALL); // "all" | "1".."12"
  const [shId, setShId] = useState<string>(ALL); // "all" | shareholder_id
  const [distOpen, setDistOpen] = useState(false);
  const [distShareholder, setDistShareholder] = useState<string | null>(null);
  const [entriesFor, setEntriesFor] = useState<{ id: string; name: string } | null>(null);
  const [markerFor, setMarkerFor] = useState<ProfitLedgerMarkerSubject | null>(null);

  const { data: perms } = useMyPermissions();
  const canDistribute = canUse(perms, "shareholder_profit", "distribute");
  const canPayManager = canUse(perms, "shareholder_profit", "pay_manager");

  const shareholdersQuery = useShareholders();
  const { data: shareholders = [] } = shareholdersQuery;
  const buildingsQuery = useBuildings();
  const { data: buildings = [] } = buildingsQuery;
  const profitMonthlyQuery = useProfitMonthly();
  const { data: profitMonthly = [] } = profitMonthlyQuery;
  const allocationsQuery = useProfitAllocations();
  const { data: allocations = [] } = allocationsQuery;
  // Cách tính cũ (phiếu chi theo cổ đông) — số đầu trang khi sổ tổng còn đang xem thử.
  const distributionsQuery = useShareholderDistributions();
  const { data: distributions = [] } = distributionsQuery;

  // Sổ tổng lợi nhuận cổ đông (E1) — lỗi hiện tại chỗ trong khối sổ tổng, không chặn cả tab.
  const ledgerQuery = useShareholderProfitLedger(selectedOrganizationId);
  const ledger = ledgerQuery.data;
  const ledgerRows = useMemo<readonly ShareholderLedgerRow[]>(() => ledger?.shareholders ?? [], [ledger]);
  const routeState = profitLedgerRouteState(ledger?.route);
  const ledgerForbidden = ledgerQuery.isError && isProfitLedgerForbidden(ledgerQuery.error);
  const kpiMode = ownerLedgerMode({
    organizationId: selectedOrganizationId,
    route: ledger?.route,
    hasLedger: !!ledger,
    loading: ledgerQuery.isLoading,
    forbidden: ledgerForbidden,
  });

  const buildingName = (id: string) => buildings.find((b: any) => b.id === id)?.name ?? "—";
  const monthOf = (period?: string) => Number((period ?? "").slice(5, 7));

  // Chỉ tính phần của cổ đông CÒN HIỆU LỰC: phân bổ/phiếu chi gắn cổ đông đã xoá
  // (vd "Green") không được cộng vào tổng — nếu không "Tổng được chia" sẽ phồng
  // hơn tổng từng cổ đông đang hiển thị. (shareholders đã loại deleted_at.)
  // hermes-parity:begin shareholder-profit — Hermes chép vùng này, xem infra/hermes-broker/web-parity.json
  const activeIds = useMemo(() => new Set(shareholders.map((s) => s.id)), [shareholders]);
  const allocActive = useMemo(
    () => allocations.filter((a) => activeIds.has(a.shareholder_id)),
    [allocations, activeIds]
  );
  const distActive = useMemo(
    () => distributions.filter((d) => activeIds.has(d.shareholder_id)),
    [distributions, activeIds]
  );
  // hermes-parity:end shareholder-profit

  // ---- Phân bổ (đã GẮN % cổ đông) lọc theo năm + cổ đông ----
  // Charts/bảng lấy từ profit_allocations (amount = LN nhà × % cổ đông) thay vì
  // adjusted_profit thô của profit_monthly → đúng phần CỔ ĐÔNG ĐƯỢC CHIA.
  // hermes-parity:begin shareholder-profit
  const allocYear = useMemo(
    () =>
      allocActive.filter(
        (a) =>
          (a.period_month ?? "").startsWith(String(year)) &&
          (shId === ALL || a.shareholder_id === shId)
      ),
    [allocActive, year, shId]
  );
  // hermes-parity:end shareholder-profit

  // Thêm lọc tháng (cho biểu đồ cơ cấu theo nhà + bảng).
  const allocScoped = useMemo(
    () => allocYear.filter((a) => month === ALL || monthOf(a.period_month) === Number(month)),
    [allocYear, month]
  );

  const buildingIdsInYear = useMemo(
    () => Array.from(new Set(allocScoped.map((a) => a.building_id).filter(Boolean) as string[])),
    [allocScoped]
  );

  const cell = (bid: string, m: number) => {
    const rows = allocYear.filter((a) => a.building_id === bid && monthOf(a.period_month) === m);
    return rows.length ? rows.reduce((s, a) => s + a.amount, 0) : undefined;
  };

  // ---- Charts (số ĐƯỢC CHIA) ----
  const monthlyChart = useMemo(
    () =>
      Array.from({ length: 12 }, (_, i) => {
        const m = i + 1;
        const profit = allocYear
          .filter((a) => monthOf(a.period_month) === m)
          .reduce((s, a) => s + a.amount, 0);
        return { label: `T${m}`, value: profit, empty: profit === 0 };
      }),
    [allocYear]
  );
  // Tô đậm tháng đang xem (bộ lọc tháng) hoặc tháng hiện tại khi xem cả năm.
  const highlightMonth =
    month !== ALL
      ? Number(month) - 1
      : year === currentYear()
        ? new Date().getMonth()
        : undefined;

  const byBuildingChart = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of allocScoped) {
      if (!a.building_id) continue;
      m.set(a.building_id, (m.get(a.building_id) ?? 0) + a.amount);
    }
    return [...m.entries()]
      .map(([bid, value]) => ({ name: buildingName(bid), value }))
      .filter((x) => x.value !== 0)
      .sort((a, b) => b.value - a.value);
  }, [allocScoped]);

  // ---- KPI: settlement luỹ kế, lọc theo cổ đông ----
  // hermes-parity:begin shareholder-profit
  const summary = useMemo(
    () => computeShareholderSummary(shareholders.map((s) => s.id), allocActive, distActive),
    [shareholders, allocActive, distActive]
  );
  // hermes-parity:end shareholder-profit

  // ---- Sổ tổng (E1) lọc theo cổ đông đang chọn: số đầu trang khi sổ tổng chạy (SHADOW trở đi) ----
  const ledgerScoped = useMemo(
    () => (shId === ALL ? ledgerRows : ledgerRows.filter((row) => row.shareholder_id === shId)),
    [ledgerRows, shId]
  );
  const ledgerSum = useMemo(() => summarizeShareholderLedger(ledgerScoped), [ledgerScoped]);

  // ---- Rà 21/10 (F21): LN đã chốt đi về đâu — CHỈ HIỆN ----
  // Cơ sở: snapshot profit_monthly LOCKED, luỹ kế, cùng phạm vi với "Tổng LN đã chốt".
  const lockedSplit = useMemo(() => splitLockedProfit(profitMonthly), [profitMonthly]);

  // ---- Rà 21/10 (F18/F20): phủ chốt Tháng × Toà + LN chưa chốt + đối chiếu LN chốt ↔ hiện tại ----
  const coverageData = useProfitOverviewCoverage(year, month === ALL ? null : Number(month), profitMonthly);

  const totals = useMemo(() => {
    // Tổng LN đã chốt = toàn bộ LN doanh nghiệp đã khoá (KHÔNG theo cổ đông — là gốc trước chia).
    // hermes-parity:begin shareholder-profit
    const lockedProfit = profitMonthly
      .filter((p) => p.status === "LOCKED")
      .reduce((s, p) => s + p.adjusted_profit, 0);
    // hermes-parity:end shareholder-profit
    // Được chia / Đã ứng / Còn lại = luỹ kế, lọc theo cổ đông đang chọn (đã loại cổ đông xoá).
    // hermes-parity:begin shareholder-profit
    const allocF = allocActive.filter((a) => shId === ALL || a.shareholder_id === shId);
    const distF = distActive.filter((d) => shId === ALL || d.shareholder_id === shId);
    const accrued = allocF.reduce((s, a) => s + a.amount, 0);
    const paid = distF.reduce((s, d) => s + d.total_amount, 0);
    return { lockedProfit, accrued, paid, remaining: accrued - paid };
    // hermes-parity:end shareholder-profit
  }, [profitMonthly, allocActive, distActive, shId]);

  // "Còn lại theo cổ đông": sổ tổng khi đang chạy; còn xem thử thì giữ cách tính cũ (cùng số đầu trang).
  const remainingChart = useMemo(
    () =>
      (kpiMode === "LEDGER"
        ? ledgerRows.map((row) => ({ name: row.name, value: row.balance }))
        : shareholders.map((s) => ({ name: s.name, value: summary[s.id]?.remaining ?? 0 })))
        .filter((x) => x.value !== 0)
        .sort((a, b) => b.value - a.value),
    [kpiMode, ledgerRows, shareholders, summary]
  );
  const remainingHolders = remainingChart.length;

  const years = [currentYear() + 1, currentYear(), currentYear() - 1, currentYear() - 2];
  const shName = shId === ALL ? null : shareholders.find((s) => s.id === shId)?.name ?? null;
  const scopeLabel = shName ? ` · ${shName}` : "";
  const monthsToShow =
    month === ALL ? Array.from({ length: 12 }, (_, i) => i + 1) : [Number(month)];
  const grandTotal = allocYear.reduce((s, a) => s + a.amount, 0);
  const payRatio = totals.lockedProfit > 0 ? Math.round((totals.accrued / totals.lockedProfit) * 100) : null;

  return (
    <QueryRegion label="lợi nhuận và cấu hình phân bổ" queries={[shareholdersQuery, buildingsQuery, profitMonthlyQuery, allocationsQuery, distributionsQuery]} skeleton="table" rows={6}>
    <>
      <ProfitHubSlot name="kpis">
        <div className="ph-kpi ph-kpi--flex" title={lockedSplitTitle(lockedSplit, formatCurrency)}>
          <div className="ph-kpi__label">Tổng LN đã chốt (luỹ kế)</div>
          <div className="ph-kpi__value">{formatCurrency(totals.lockedProfit)}</div>
          <div className="ph-kpi__sub">trước chia cổ đông · chỉ tháng-toà đã chốt</div>
          {coverageData.coverage && (
            <div className="ph-kpi__sub ph-kpi__sub--gold">
              LN chưa chốt {month === ALL ? `năm ${year}` : `T${month}/${year}`}: ≈
              {formatCurrency(
                splitOpenNetByMonthEnd(coverageData.coverage, year, coverageData.today).ended
              )}{" "}
              (ước tính, trước chia)
            </div>
          )}
        </div>
        <div className="ph-kpi__div" />
        <div className="ph-kpi ph-kpi--flex">
          <div className="ph-kpi__label">
            {shName ? `Được chia · ${shName}` : "Tổng được chia cổ đông"}
          </div>
          <div className="ph-kpi__value ph-kpi__value--mint">{formatCurrency(totals.accrued)}</div>
          <div className="ph-kpi__sub">
            {payRatio !== null ? `${payRatio}% LN đã chốt` : "theo tỷ lệ từng nhà"}
          </div>
        </div>
        <div className="ph-kpi__div" />
        {kpiMode === "LEDGER" ? (
          <>
            <div className="ph-kpi ph-kpi--flex" data-testid="kpi-paid">
              <div className="ph-kpi__label">Đã chi (đã duyệt)</div>
              <div className="ph-kpi__value ph-kpi__value--gold">{formatCurrency(ledgerSum.approved)}</div>
              <div className="ph-kpi__sub">
                chờ duyệt {formatCurrency(ledgerSum.pending)} · qua lương {formatCurrency(ledgerSum.viaSalary)}
              </div>
            </div>
            <div className="ph-kpi__div" />
            <div className="ph-kpi ph-kpi--flex" data-testid="kpi-remaining">
              <div className="ph-kpi__label">Còn phải trả</div>
              <div className="ph-kpi__value">{formatCurrency(ledgerSum.owed)}</div>
              <div className="ph-kpi__sub ph-kpi__sub--mint">{ledgerSum.owedCount} cổ đông còn phải trả · theo sổ tổng</div>
              {ledgerSum.advance > 0 && (
                <div className="ph-kpi__sub ph-kpi__sub--gold">đang tạm ứng {formatCurrency(ledgerSum.advance)}</div>
              )}
            </div>
          </>
        ) : kpiMode === "LEGACY" ? (
          <>
            <div className="ph-kpi ph-kpi--flex" data-testid="kpi-paid">
              <div className="ph-kpi__label">Đã ứng / đã chia</div>
              <div className="ph-kpi__value ph-kpi__value--gold">{formatCurrency(totals.paid)}</div>
              <div className="ph-kpi__sub">đã chi qua phiếu</div>
            </div>
            <div className="ph-kpi__div" />
            <div className="ph-kpi ph-kpi--flex" data-testid="kpi-remaining">
              <div className="ph-kpi__label">Còn phải trả</div>
              <div className="ph-kpi__value">{formatCurrency(totals.remaining)}</div>
              <div className="ph-kpi__sub ph-kpi__sub--mint">{remainingHolders} cổ đông còn số dư</div>
              <div className="ph-kpi__sub ph-kpi__sub--gold">cách tính cũ — sổ tổng đang xem thử</div>
            </div>
          </>
        ) : (
          <>
            <div className="ph-kpi ph-kpi--flex" data-testid="kpi-paid">
              <div className="ph-kpi__label">Đã chi (đã duyệt)</div>
              <div className="ph-kpi__value">
                {kpiMode === "PENDING" ? <Skeleton className="h-6 w-24 bg-white/20" aria-label="Đang tải sổ tổng" /> : "—"}
              </div>
              {kpiMode === "ERROR" && <div className="ph-kpi__sub">chưa tải được sổ tổng</div>}
            </div>
            <div className="ph-kpi__div" />
            <div className="ph-kpi ph-kpi--flex" data-testid="kpi-remaining">
              <div className="ph-kpi__label">Còn phải trả</div>
              <div className="ph-kpi__value">
                {kpiMode === "PENDING" ? <Skeleton className="h-6 w-24 bg-white/20" aria-label="Đang tải sổ tổng" /> : "—"}
              </div>
              {kpiMode === "ERROR" && <div className="ph-kpi__sub">chưa tải được sổ tổng</div>}
            </div>
          </>
        )}
        <div className="ph-kpi__div" />
        <div className="ph-kpi ph-kpi--flex" title={lockedSplitTitle(lockedSplit, formatCurrency)}>
          <div className="ph-kpi__label">Giữ lại công ty (luỹ kế)</div>
          <div className="ph-kpi__value">
            {formatCurrency(lockedSplit.retained + lockedSplit.legacyRetained)}
          </div>
          <div className="ph-kpi__sub">{retainedKpiSub(lockedSplit, formatCurrency)}</div>
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
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <SelectItem key={m} value={String(m)}>Tháng {m}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={shId} onValueChange={setShId}>
            <SelectTrigger className="ph-control" aria-label="Chọn cổ đông">
              <SelectValue placeholder="Cổ đông" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Tất cả cổ đông</SelectItem>
              {shareholders.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
            </SelectContent>
          </Select>
          {canDistribute && (
            <Button
              className="ph-btn-primary ml-auto"
              disabled={!ledger || !routeState.canPayShareholder}
              title={ledger && !routeState.canPayShareholder ? routeState.banner ?? undefined : undefined}
              onClick={() => { setDistShareholder(shId === ALL ? null : shId); setDistOpen(true); }}
            >
              ＋ Chi lợi nhuận
            </Button>
          )}
        </div>

        {/* Rà 21/10 F18/F20: tháng-toà nào đã chốt / chưa chốt / chốt nhưng nguồn đã đổi,
            LN chưa chốt (ước tính) và băng đối chiếu LN chốt ↔ hiện tại. */}
        <ProfitCoverageCard data={coverageData} year={year} monthFilter={month === ALL ? null : Number(month)} />

        {/* Biểu đồ (số ĐƯỢC CHIA cho cổ đông) */}
        <div className="ph-grid-2">
          <div className="ph-card ph-card__pad">
            <div className="ph-card__title">LN được chia theo tháng — {year}{scopeLabel}</div>
            <MiniBars
              data={monthlyChart}
              highlight={highlightMonth}
              footnote="Đơn vị: triệu ₫ · số ĐƯỢC CHIA cho cổ đông (đã trừ lương điều hành)"
            />
          </div>

          <div className="ph-card ph-card__pad">
            <div className="ph-card__title">
              Cơ cấu LN được chia theo nhà — {year}{month === ALL ? "" : ` · T${month}`}{scopeLabel}
            </div>
            <DonutBreakdown data={byBuildingChart} caption="ĐƯỢC CHIA" />
          </div>
        </div>

        {/* Ma trận Nhà × Tháng (số ĐƯỢC CHIA) */}
        <div className="ph-card">
          <div className="ph-card__head">
            <div className="ph-card__title">LN được chia Nhà × Tháng — {year}{scopeLabel}</div>
          </div>
          {buildingIdsInYear.length === 0 ? (
            <div className="ph-empty">
              Chưa có phần chia cho cổ đông trong {month === ALL ? `năm ${year}` : `tháng ${month}/${year}`}.
            </div>
          ) : (
            <div className="ph-tbl__scroll">
              <table className="ph-tbl">
                <thead>
                  <tr>
                    <th style={{ width: 70 }}>Tháng</th>
                    {buildingIdsInYear.map((bid) => (
                      <th key={bid} className="num">{buildingName(bid)}</th>
                    ))}
                    <th className="num">Tổng chia</th>
                  </tr>
                </thead>
                <tbody>
                  {monthsToShow.map((m) => {
                    const rowTotal = buildingIdsInYear.reduce((s, bid) => s + (cell(bid, m) ?? 0), 0);
                    if (rowTotal === 0 && !buildingIdsInYear.some((bid) => cell(bid, m) != null)) return null;
                    return (
                      <tr key={m} className={m === (highlightMonth ?? -1) + 1 ? "is-current" : undefined}>
                        <td className="name">T{m}</td>
                        {buildingIdsInYear.map((bid) => {
                          const v = cell(bid, m);
                          return (
                            <td key={bid} className="num">
                              {v == null ? <span style={{ color: "var(--ph-ink-4)" }}>—</span> : formatCurrency(v)}
                            </td>
                          );
                        })}
                        <td className="num strong">{formatCurrency(rowTotal)}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td>Σ {year}</td>
                    {buildingIdsInYear.map((bid) => (
                      <td key={bid} className="num">
                        {formatCurrency(
                          monthsToShow.reduce((s, m) => s + (cell(bid, m) ?? 0), 0)
                        )}
                      </td>
                    ))}
                    <td className="num" style={{ fontWeight: 800, color: "var(--ph-green-d)" }}>
                      {formatCurrency(grandTotal)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>

        {/* Sổ tổng theo cổ đông (E1): mốc, được chia sau mốc, đã chi, chờ duyệt, qua lương, còn phải trả. */}
        <div className="ph-card" data-testid="shareholder-ledger-card">
          <div className="ph-card__head">
            <div className="ph-card__title">
              Sổ tổng theo cổ đông
              {ledger && !routeState.ledgerReady && (
                <span className="ph-state ph-state--warn" style={{ marginLeft: 8 }}>xem thử</span>
              )}
            </div>
            {ledger && !routeState.ledgerReady && (
              <div className="ph-card__note">Số đầu trang vẫn tính theo cách cũ cho tới khi bật sổ tổng.</div>
            )}
          </div>
          <div style={{ padding: "0 18px" }}>
            <ProfitLedgerRouteBanner route={ledger?.route} className="mb-3" />
          </div>
          {!selectedOrganizationId ? (
            <div className="ph-empty">Chọn công ty để xem sổ tổng lợi nhuận.</div>
          ) : ledgerQuery.isError ? (
            <div style={{ padding: "0 18px 14px" }}>
              <ProfitLedgerReadError error={ledgerQuery.error} onRetry={() => { void ledgerQuery.refetch(); }} />
            </div>
          ) : !ledger ? (
            <div style={{ padding: "0 18px 14px" }}>
              <Skeleton className="h-28 w-full" aria-label="Đang tải sổ tổng lợi nhuận" />
            </div>
          ) : (
            <ShareholderLedgerTable
              rows={ledgerRows}
              routeState={routeState}
              canDistribute={canDistribute}
              selectedId={shId === ALL ? null : shId}
              onSelect={(id) => setShId(id ?? ALL)}
              onOpenEntries={(row) => setEntriesFor({ id: row.shareholder_id, name: row.name })}
              onPay={(row) => { setDistShareholder(row.shareholder_id); setDistOpen(true); }}
              onMarker={(row) => setMarkerFor({ id: row.shareholder_id, name: row.name, marker: row.marker })}
            />
          )}
        </div>

        <div className="ph-card ph-card__pad">
          <div className="ph-card__title">Còn lại theo cổ đông</div>
          <HBars data={remainingChart} />
          <div className="ph-hint">
            {kpiMode === "LEDGER"
              ? "Số dư = được chia sau mốc − đã chi − chờ duyệt − trả qua lương (âm là đang tạm ứng)"
              : "Số còn phải trả = được chia luỹ kế − đã ứng/đã chia (cách tính cũ)"}
          </div>
        </div>

        {/* Lương điều hành theo sổ (E10): được nhận sau mốc − đã trả − chờ duyệt = còn lại. */}
        <ManagerLedgerSection organizationId={selectedOrganizationId} canPayManager={canPayManager} variant="desktop" />
      </div>

      <ProfitDistributeDialog
        open={distOpen}
        onOpenChange={setDistOpen}
        organizationId={selectedOrganizationId}
        mode="OWNER"
        ledgerRows={ledger?.shareholders}
        defaultShareholderId={distShareholder}
        onReviewSalary={(shareholderId) => {
          setDistOpen(false);
          const row = ledgerRows.find((r) => r.shareholder_id === shareholderId);
          setEntriesFor({ id: shareholderId, name: row?.name ?? "" });
        }}
      />
      <ShareholderLedgerSheet
        open={!!entriesFor}
        onOpenChange={(next) => { if (!next) setEntriesFor(null); }}
        organizationId={selectedOrganizationId}
        shareholder={entriesFor}
        route={ledger?.route}
        canDistribute={canDistribute}
      />
      <ProfitLedgerMarkerDialog
        open={!!markerFor}
        onOpenChange={(next) => { if (!next) setMarkerFor(null); }}
        organizationId={selectedOrganizationId}
        subjectKind="SHAREHOLDER"
        subject={markerFor}
      />
    </>
    </QueryRegion>
  );
}
