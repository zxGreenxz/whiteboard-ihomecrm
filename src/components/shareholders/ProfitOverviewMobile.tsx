import { QueryRegion } from "@/components/errors/QueryRegion";
import { useMemo, useState } from "react";
import { HandCoins, Plus } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { colorAt } from "./shareholderUtils";
import { useMyShareholder, useShareholders } from "@/hooks/useShareholders";
import { useBuildings } from "@/hooks/useBuildings";
import { useProfitOverviewCoverage } from "@/hooks/useProfitOverviewCoverage";
import {
  retainedKpiSub,
  splitLockedProfit,
} from "@/lib/profitOverviewCoverage";
import { ProfitCoverageMobile } from "./ProfitCoverageCard";
import {
  useProfitMonthly,
  useProfitAllocations,
  useShareholderDistributions,
} from "@/hooks/useShareholderProfit";
import { useShareholderProfitLedger, useShareholderProfitPositions } from "@/hooks/profit-ledger/useProfitLedgerQueries";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import { canUse } from "@/lib/permissionPages";
import { isProfitLedgerForbidden } from "@/lib/profitLedger/errors";
import type { ShareholderLedgerRow } from "@/lib/profitLedger/ledgerReaders";
import {
  markerText,
  ownerLedgerMode,
  salaryNet,
  shareholderPayBlock,
  summarizeShareholderLedger,
} from "@/lib/profitLedger/ownerLedgerView";
import type { ShareholderPositionRow } from "@/lib/profitLedger/positionReaders";
import {
  advancePendingText,
  isUnpaidNegative,
  POSITION_EXPLAIN,
  POSITION_LABELS,
  positionsForLedgerRows,
  settlementCashPendingText,
  summarizeLedgerRowPositions,
  UNPAID_NEGATIVE_NOTE,
} from "@/lib/profitLedger/positionView";
import { profitLedgerRouteState } from "@/lib/profitLedger/route";
import { ownerSelfAdvanceSubject, selfAdvanceBlockedNote } from "@/lib/profitLedger/selfView";
import ProfitDistributeDialog from "./ProfitDistributeDialog";
import { SharedFundEntry } from "./SharedFundEntry";
import ProfitSelfAdvanceDialog from "./ProfitSelfAdvanceDialog";
import { ManagerLedgerSection } from "./ManagerLedgerSection";
import { ProfitLedgerMarkerDialog, type ProfitLedgerMarkerSubject } from "./ProfitLedgerMarkerDialog";
import { ProfitLedgerReadError, ProfitLedgerRouteBanner } from "./ProfitLedgerRouteBanner";
import { ShareholderLedgerSheet } from "./ShareholderLedgerSheet";
import { useOrganization } from "@/contexts/OrganizationContext";
import {
  CARD,
  Chip,
  fmtShort,
  MonthBars,
  BuildingMatrix,
  YearMonthRow,
  uniformPercent,
} from "./profitMobileShared";

const ALL = "all";

// Tab "Tổng quan" MOBILE của trang Báo cáo Lợi Nhuận — bản thu gọn của
// ProfitOverviewTab (desktop), CÙNG hook/dữ liệu, chỉ khác trình bày
// (thiết kế ProfitMobileC · "C · Tổng quan quản lý").
export default function ProfitOverviewMobile({
  year,
  onYearChange,
}: {
  year: number;
  onYearChange: (y: number) => void;
}) {
  // Sổ tổng (E1/E10) theo công ty đang chọn; biểu đồ + ma trận vẫn đọc phân bổ như cũ.
  const { selectedOrganizationId, organization } = useOrganization();
  const [month, setMonth] = useState<string>(ALL); // "all" | "1".."12"
  const [shId, setShId] = useState<string>(ALL);
  const [distOpen, setDistOpen] = useState(false);
  const [distShareholder, setDistShareholder] = useState<string | null>(null);
  const [entriesFor, setEntriesFor] = useState<{ id: string; name: string } | null>(null);
  const [markerFor, setMarkerFor] = useState<ProfitLedgerMarkerSubject | null>(null);
  const [selfAdvanceOpen, setSelfAdvanceOpen] = useState(false);

  const { data: perms } = useMyPermissions();
  const canDistribute = canUse(perms, "shareholder_profit", "distribute");
  const canPayManager = canUse(perms, "shareholder_profit", "pay_manager");
  // Tỷ lệ % của cổ đông chỉ hiện khi được cấp quyền xem tỷ lệ.
  const canViewPercent = canUse(perms, "shareholder_profit", "view_percent");
  // Chủ đồng thời là cổ đông của đúng công ty này và có quyền tạm ứng ⇒ "Chi tạm ứng cho tôi" (như bản máy tính).
  const { data: myShareholder } = useMyShareholder();
  const canAdvanceOwn = canUse(perms, "shareholder_profit", "advance_own_cashbook");
  const selfAdvanceMe = useMemo(
    () => ownerSelfAdvanceSubject(myShareholder, canAdvanceOwn, selectedOrganizationId),
    [myShareholder, canAdvanceOwn, selectedOrganizationId]
  );

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

  // Sổ tổng lợi nhuận cổ đông (E1) — lỗi hiện tại chỗ trong thẻ sổ tổng, không chặn cả tab.
  const ledgerQuery = useShareholderProfitLedger(selectedOrganizationId);
  const ledger = ledgerQuery.data;
  const ledgerRows = useMemo<readonly ShareholderLedgerRow[]>(() => ledger?.shareholders ?? [], [ledger]);
  const routeState = profitLedgerRouteState(ledger?.route);
  const kpiMode = ownerLedgerMode({
    organizationId: selectedOrganizationId,
    route: ledger?.route,
    hasLedger: !!ledger,
    loading: ledgerQuery.isLoading,
    forbidden: ledgerQuery.isError && isProfitLedgerForbidden(ledgerQuery.error),
  });
  const ledgerSum = useMemo(
    () => summarizeShareholderLedger(shId === ALL ? ledgerRows : ledgerRows.filter((row) => row.shareholder_id === shId)),
    [ledgerRows, shId]
  );
  // Vị thế từng cổ đông (R1): "Lợi nhuận chưa chi" và "Tạm ứng đang có". Chưa có số ⇒ "…" / "—", không hiện 0.
  const positionsQuery = useShareholderProfitPositions(selectedOrganizationId, { enabled: !!ledger });
  const positions = useMemo<readonly ShareholderPositionRow[] | null>(
    () => positionsQuery.data?.shareholders ?? null,
    [positionsQuery.data]
  );
  const positionById = useMemo(() => new Map((positions ?? []).map((row) => [row.shareholder_id, row] as const)), [positions]);
  // Số đầu trang cộng ĐÚNG các thẻ cổ đông đang hiện (dòng E1) — cùng tập với bảng sổ tổng của bản máy tính.
  const positionSum = useMemo(
    () => summarizeLedgerRowPositions(shId === ALL ? ledgerRows : ledgerRows.filter((row) => row.shareholder_id === shId), positions),
    [ledgerRows, positions, shId]
  );
  const ledgerPositions = useMemo(() => positionsForLedgerRows(ledgerRows, positions)?.listed ?? [], [ledgerRows, positions]);
  const positionsPending = !positions && !positionsQuery.isError;
  const positionMissing = positionsPending ? "…" : "—";
  const positionGapNote = positions && !positionSum ? "Thiếu số của một cổ đông" : "Chưa tải được";
  const selfAdvanceNote = selfAdvanceBlockedNote(ledger?.route);
  const openMarker = (row: ShareholderLedgerRow) => setMarkerFor({
    id: row.shareholder_id,
    name: row.name,
    marker: row.marker,
    lastSettledThroughMonth: positionById.get(row.shareholder_id)?.last_settled_through_month ?? null,
  });

  const buildingName = (id: string) => (buildings as any[]).find((b) => b.id === id)?.name ?? "—";
  const monthOf = (period?: string) => Number((period ?? "").slice(5, 7));
  const shiftYear = (delta: number) => {
    onYearChange(year + delta);
    setMonth(ALL);
  };

  // Chỉ tính cổ đông CÒN HIỆU LỰC (đồng bộ desktop — cổ đông đã xoá không cộng tổng).
  const activeIds = useMemo(() => new Set(shareholders.map((s) => s.id)), [shareholders]);
  const allocActive = useMemo(
    () => allocations.filter((a) => activeIds.has(a.shareholder_id)),
    [allocations, activeIds]
  );
  const distActive = useMemo(
    () => distributions.filter((d) => activeIds.has(d.shareholder_id)),
    [distributions, activeIds]
  );

  const allocYear = useMemo(
    () =>
      allocActive.filter(
        (a) =>
          (a.period_month ?? "").startsWith(String(year)) &&
          (shId === ALL || a.shareholder_id === shId)
      ),
    [allocActive, year, shId]
  );
  const allocScoped = useMemo(
    () => allocYear.filter((a) => month === ALL || monthOf(a.period_month) === Number(month)),
    [allocYear, month]
  );

  const buildingIdsInYear = useMemo(
    () =>
      Array.from(new Set(allocScoped.map((a) => a.building_id).filter(Boolean) as string[])).sort(
        (a, b) => buildingName(a).localeCompare(buildingName(b), "vi")
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allocScoped, buildings]
  );

  const cell = (bid: string, m: number) => {
    const rows = allocYear.filter((a) => a.building_id === bid && monthOf(a.period_month) === m);
    return rows.length ? rows.reduce((s, a) => s + a.amount, 0) : undefined;
  };

  const monthVals = useMemo(
    () =>
      Array.from({ length: 12 }, (_, i) =>
        allocYear.filter((a) => monthOf(a.period_month) === i + 1).reduce((s, a) => s + a.amount, 0)
      ),
    [allocYear]
  );

  // Rà 21/10 (F21): LN đã chốt đi về đâu — CHỈ HIỆN (đồng bộ desktop).
  const lockedSplit = useMemo(() => splitLockedProfit(profitMonthly), [profitMonthly]);
  // Rà 21/10 (F18/F20): phủ chốt theo tháng + LN chưa chốt (ước tính) + đối chiếu.
  const coverageData = useProfitOverviewCoverage(year, month === ALL ? null : Number(month), profitMonthly);

  const totals = useMemo(() => {
    const lockedProfit = profitMonthly
      .filter((p) => p.status === "LOCKED")
      .reduce((s, p) => s + p.adjusted_profit, 0);
    const allocF = allocActive.filter((a) => shId === ALL || a.shareholder_id === shId);
    const distF = distActive.filter((d) => shId === ALL || d.shareholder_id === shId);
    const accrued = allocF.reduce((s, a) => s + a.amount, 0);
    const paid = distF.reduce((s, d) => s + d.total_amount, 0);
    return { lockedProfit, accrued, paid, remaining: accrued - paid };
  }, [profitMonthly, allocActive, distActive, shId]);

  const shName = shId === ALL ? null : shareholders.find((s) => s.id === shId)?.name ?? null;
  const scopeLabel = `năm ${year}${shName ? ` · ${shName}` : ""}`;
  const scopeMonthLabel = `${month === ALL ? `năm ${year}` : `T${month}/${year}`}${shName ? ` · ${shName}` : ""}`;

  // Cơ cấu theo nhà (dải màu + legend) — trên allocScoped.
  const bldSegs = useMemo(() => {
    const vals = buildingIdsInYear.map((bid) => ({
      bid,
      v: allocScoped.filter((a) => a.building_id === bid).reduce((s, a) => s + a.amount, 0),
    }));
    const sum = vals.reduce((t, x) => t + x.v, 0) || 1;
    return vals.map(({ bid, v }, i) => ({
      bid,
      name: buildingName(bid),
      v,
      pct: (v / sum) * 100,
      color: colorAt(i),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildingIdsInYear, allocScoped, buildings]);

  const monthsToShow = month === ALL ? Array.from({ length: 12 }, (_, i) => i + 1) : [Number(month)];
  const matrixRows = useMemo(
    () =>
      monthsToShow
        .map((m) => {
          const cells = buildingIdsInYear.map((bid) => cell(bid, m) ?? null);
          const total = cells.reduce<number>((s, c) => s + (c ?? 0), 0);
          return { m: `T${m}`, cells, total, hasAny: cells.some((c) => c != null) };
        })
        .filter((r) => r.hasAny || r.total !== 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [monthsToShow, buildingIdsInYear, allocYear]
  );

  const kpiVal = "font-mono font-bold text-[16px] tracking-[-0.4px] mt-1 whitespace-nowrap";
  const kpiLabel =
    "text-[9.5px] font-bold tracking-wide text-[#8d8678] uppercase whitespace-nowrap overflow-hidden text-ellipsis";
  const kpiSub = "text-[10px] text-[#b6b0a3] font-semibold mt-0.5";

  return (
    <QueryRegion label="lợi nhuận và cấu hình phân bổ" queries={[shareholdersQuery, buildingsQuery, profitMonthlyQuery, allocationsQuery, distributionsQuery]} skeleton="cards" rows={4}>
    <div className="flex flex-col gap-2.5">
      {/* KPI 2×2 */}
      <div className="grid grid-cols-2 gap-2">
        <div className={`${CARD} px-3 py-2.5`}>
          <div className={kpiLabel}>Tổng LN đã chốt (luỹ kế)</div>
          <div className={`${kpiVal} text-[#2b5aa0]`}>{fmtShort(totals.lockedProfit)}</div>
          <div className={kpiSub}>Trước chia cổ đông</div>
        </div>
        {/* Được chia / Đã chi / Còn phải trả CÙNG GỐC: sổ tổng chạy ⇒ cả ba đọc E1 (sau mốc);
            còn xem thử ⇒ cả ba theo cách tính cũ. */}
        <div className={`${CARD} px-3 py-2.5`} data-testid="kpi-allocated">
          {kpiMode === "LEDGER" ? (
            <>
              <div className={kpiLabel}>{shName ? `Được chia (sau mốc) · ${shName}` : "Được chia (sau mốc)"}</div>
              <div className={`${kpiVal} text-[#0e7a47]`}>{fmtShort(ledgerSum.allocated)}</div>
              <div className={kpiSub}>Các tháng đã chốt sau mốc</div>
            </>
          ) : kpiMode === "LEGACY" ? (
            <>
              <div className={kpiLabel}>{shName ? `Được chia · ${shName}` : "Tổng được chia cổ đông"}</div>
              <div className={`${kpiVal} text-[#0e7a47]`}>{fmtShort(totals.accrued)}</div>
              <div className={kpiSub}>Luỹ kế đã chốt</div>
            </>
          ) : (
            <>
              <div className={kpiLabel}>Được chia</div>
              <div className={`${kpiVal} text-[#1b1813]`}>
                {kpiMode === "PENDING" ? <Skeleton className="h-5 w-16" aria-label="Đang tải sổ tổng" /> : "—"}
              </div>
              {kpiMode === "ERROR" && <div className={kpiSub}>Chưa tải được sổ tổng</div>}
            </>
          )}
        </div>
        {kpiMode === "LEDGER" ? (
          <>
            <div className={`${CARD} px-3 py-2.5`} data-testid="kpi-paid">
              <div className={kpiLabel}>Đã chi (đã duyệt)</div>
              <div className={`${kpiVal} text-[#c97a10]`}>{fmtShort(ledgerSum.approved)}</div>
              <div className={kpiSub}>chờ duyệt {fmtShort(ledgerSum.pending)} · qua lương {fmtShort(ledgerSum.viaSalary)}</div>
            </div>
            {/* Hai con số của vị thế (R1). */}
            <div className={`${CARD} px-3 py-2.5`} data-testid="kpi-remaining">
              <div className={kpiLabel}>{POSITION_LABELS.unpaid}</div>
              <div className={`${kpiVal} ${positionSum && positionSum.unpaid < 0 ? "text-[#d6453f]" : "text-[#1b1813]"}`}>
                {positionSum
                  ? fmtShort(positionSum.unpaid)
                  : positionsPending ? <Skeleton className="h-5 w-16" aria-label="Đang tải lợi nhuận chưa chi" /> : "—"}
              </div>
              <div className={kpiSub}>
                {positionSum
                  ? positionSum.cashPending !== 0 ? `đang chờ chi ${fmtShort(positionSum.cashPending)}` : `${positionSum.unpaidCount} cổ đông còn chưa chi`
                  : positionsPending ? "" : positionGapNote}
              </div>
            </div>
            <div className={`${CARD} px-3 py-2.5`} data-testid="kpi-advance">
              <div className={kpiLabel}>{POSITION_LABELS.advance}</div>
              <div className={`${kpiVal} text-[#c97a10]`}>
                {positionSum
                  ? fmtShort(positionSum.advance)
                  : positionsPending ? <Skeleton className="h-5 w-16" aria-label="Đang tải tạm ứng đang có" /> : "—"}
              </div>
              <div className={kpiSub}>
                {positionSum
                  ? positionSum.advancePending !== 0 ? `chờ duyệt ${fmtShort(positionSum.advancePending)}` : "đã duyệt, chưa khấu trừ"
                  : positionsPending ? "" : positionGapNote}
              </div>
            </div>
          </>
        ) : kpiMode === "LEGACY" ? (
          <>
            <div className={`${CARD} px-3 py-2.5`} data-testid="kpi-paid">
              <div className={kpiLabel}>Đã ứng / đã chia</div>
              <div className={`${kpiVal} text-[#c97a10]`}>{fmtShort(totals.paid)}</div>
              <div className={kpiSub}>{shName ?? "Tất cả cổ đông"}</div>
            </div>
            <div className={`${CARD} px-3 py-2.5`} data-testid="kpi-remaining">
              <div className={kpiLabel}>Còn phải trả</div>
              <div className={`${kpiVal} ${totals.remaining < 0 ? "text-[#d6453f]" : "text-[#1b1813]"}`}>
                {fmtShort(totals.remaining)}
              </div>
              <div className={kpiSub}>Cách tính cũ (được chia − đã ứng)</div>
            </div>
          </>
        ) : (
          <>
            <div className={`${CARD} px-3 py-2.5`} data-testid="kpi-paid">
              <div className={kpiLabel}>Đã chi (đã duyệt)</div>
              <div className={`${kpiVal} text-[#1b1813]`}>
                {kpiMode === "PENDING" ? <Skeleton className="h-5 w-16" aria-label="Đang tải sổ tổng" /> : "—"}
              </div>
              {kpiMode === "ERROR" && <div className={kpiSub}>Chưa tải được sổ tổng</div>}
            </div>
            <div className={`${CARD} px-3 py-2.5`} data-testid="kpi-remaining">
              <div className={kpiLabel}>{POSITION_LABELS.unpaid}</div>
              <div className={`${kpiVal} text-[#1b1813]`}>
                {kpiMode === "PENDING" ? <Skeleton className="h-5 w-16" aria-label="Đang tải sổ tổng" /> : "—"}
              </div>
              {kpiMode === "ERROR" && <div className={kpiSub}>Chưa tải được sổ tổng</div>}
            </div>
          </>
        )}
        {/* Sổ tổng chạy: sáu ô xếp đủ ba hàng đôi; các chế độ khác còn năm ô nên ô cuối trải hai cột. */}
        <div className={`${CARD} px-3 py-2.5 ${kpiMode === "LEDGER" ? "" : "col-span-2"}`}>
          <div className={kpiLabel}>Giữ lại công ty (luỹ kế)</div>
          <div className={`${kpiVal} text-[#1b1813]`}>{fmtShort(lockedSplit.retained + lockedSplit.legacyRetained)}</div>
          <div className={kpiSub}>{retainedKpiSub(lockedSplit, fmtShort)}</div>
        </div>
      </div>
      <ProfitLedgerRouteBanner route={ledger?.route} className="-mt-1 text-[11px]" />
      {canDistribute && selectedOrganizationId && organization?.id === selectedOrganizationId && organization.memberType === "OWNER" && (
        <SharedFundEntry key={selectedOrganizationId} organizationId={selectedOrganizationId} onSettle={id => { setDistShareholder(id); setDistOpen(true); }} />
      )}
      {/* Chủ đồng thời là cổ đông có quyền tạm ứng: tự ứng cho mình (cùng hộp của màn tự xem). Sổ tổng chưa chạy thật
          thì nút khoá — dải báo ngay trên đã nói lý do. */}
      {selfAdvanceMe && (
        <button
          type="button"
          disabled={selfAdvanceNote !== null}
          onClick={() => setSelfAdvanceOpen(true)}
          className="flex items-center justify-center gap-2 rounded-[13px] border border-[#d2e8da] bg-[#e8f3ec] px-4 py-2.5 text-[13px] font-bold text-[#1a6645] active:scale-[.99] disabled:opacity-50"
        >
          <HandCoins className="h-4 w-4" />Chi tạm ứng cho tôi
        </button>
      )}

      {/* Năm + chip tháng */}
      <YearMonthRow year={year} month={month} onYearShift={shiftYear} onMonthChange={setMonth} />

      {/* Rà 21/10 F18/F20: tình trạng chốt theo tháng × toà (bản thu gọn) */}
      <ProfitCoverageMobile data={coverageData} year={year} monthFilter={month === ALL ? null : Number(month)} />

      {/* Chip cổ đông */}
      <div className="flex gap-1.5 overflow-x-auto [&::-webkit-scrollbar]:hidden">
        <Chip on={shId === ALL} onClick={() => setShId(ALL)}>Tất cả cổ đông</Chip>
        {shareholders.map((s) => (
          <Chip key={s.id} on={shId === s.id} onClick={() => setShId(shId === s.id ? ALL : s.id)}>
            {s.name}
          </Chip>
        ))}
      </div>

      {/* LN được chia theo tháng */}
      <div className={`${CARD} px-3 py-3`}>
        <div className="flex items-baseline gap-1.5">
          <span className="text-[12.5px] font-extrabold tracking-[-0.1px] text-[#1b1813]">LN được chia theo tháng</span>
          <span className="text-[10.5px] font-semibold text-[#8d8678]">{scopeLabel}</span>
        </div>
        <div className="mt-3">
          <MonthBars values={monthVals} month={month} onMonthChange={setMonth} />
        </div>
      </div>

      {/* Cơ cấu theo nhà */}
      <div className={`${CARD} px-3 py-3`}>
        <div className="flex items-baseline gap-1.5">
          <span className="text-[12.5px] font-extrabold tracking-[-0.1px] text-[#1b1813]">Cơ cấu theo nhà</span>
          <span className="text-[10.5px] font-semibold text-[#8d8678]">{scopeMonthLabel}</span>
        </div>
        {bldSegs.length === 0 ? (
          <p className="mt-2.5 mb-0 text-[12px] font-semibold text-[#8d8678]">Chưa có dữ liệu trong {scopeMonthLabel}.</p>
        ) : (
          <>
            <div className="flex h-2.5 rounded-full overflow-hidden mt-3 bg-[#efece4]">
              {bldSegs.map((s) => (
                <div key={s.bid} style={{ width: `${s.pct}%`, background: s.color }} />
              ))}
            </div>
            <div className="flex flex-col gap-[7px] mt-3">
              {bldSegs.map((s) => (
                <div key={s.bid} className="flex items-center gap-2">
                  <span className="w-[9px] h-[9px] rounded-[3px] shrink-0" style={{ background: s.color }} />
                  <span className="font-mono text-[12px] font-bold text-[#514c42] flex-1 min-w-0 truncate">{s.name}</span>
                  <span className="font-mono text-[12px] font-bold text-[#1b1813]">{fmtShort(s.v)}</span>
                  <span className="font-mono text-[10.5px] font-bold text-[#8d8678] w-11 text-right">
                    {s.pct.toFixed(1)}%
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Ma trận Nhà × Tháng */}
      <div className={`${CARD} overflow-hidden`}>
        <div className="flex items-baseline gap-1.5 px-3 pt-3 pb-2">
          <span className="text-[12.5px] font-extrabold tracking-[-0.1px] text-[#1b1813]">LN được chia Nhà × Tháng</span>
          <span className="ml-auto text-[10px] font-bold text-[#8d8678] bg-[#faf8f4] border border-[#efece4] rounded-md px-1.5 py-0.5">
            triệu ₫
          </span>
        </div>
        {matrixRows.length > 0 ? (
          <BuildingMatrix heads={buildingIdsInYear.map(buildingName)} rows={matrixRows} />
        ) : (
          <p className="m-0 px-3 pb-4 pt-1 text-[12px] font-semibold text-[#8d8678]">
            Chưa có phần chia cho cổ đông trong {scopeLabel}.
          </p>
        )}
      </div>

      {/* Sổ tổng theo cổ đông (E1): mỗi cổ đông một thẻ; bấm thẻ mở sổ chi tiết từ dưới lên. */}
      <div className={`${CARD} overflow-hidden`} data-testid="shareholder-ledger-card">
        <div className="flex items-center gap-2 px-3 py-3 border-b border-[#efece4]">
          <span className="text-[12.5px] font-extrabold tracking-[-0.1px] text-[#1b1813]">Sổ tổng theo cổ đông</span>
          {ledger && !routeState.ledgerReady ? (
            <span className="text-[10px] font-bold text-[#a35a0c] bg-[#fdf3e3] border border-[#f1dcb4] rounded-[5px] px-1.5 py-px">xem thử</span>
          ) : (
            <span className="text-[10.5px] font-semibold text-[#8d8678]">sau mốc</span>
          )}
          {canDistribute && (
            <button
              type="button"
              disabled={!ledger || !routeState.canPayShareholder}
              title={ledger && !routeState.canPayShareholder ? routeState.banner ?? undefined : undefined}
              onClick={() => { setDistShareholder(shId === ALL ? null : shId); setDistOpen(true); }}
              className="ml-auto inline-flex items-center gap-1 text-[11.5px] font-bold text-white bg-[#1f7a52] rounded-[9px] px-2.5 py-1.5 shadow-sm active:scale-95 disabled:opacity-50"
            >
              <Plus className="h-3 w-3" strokeWidth={2.5} /> Chi lợi nhuận
            </button>
          )}
        </div>
        {!selectedOrganizationId ? (
          <p className="m-0 px-3 py-3.5 text-[12px] font-semibold text-[#8d8678]">Chọn công ty để xem sổ tổng lợi nhuận.</p>
        ) : ledgerQuery.isError ? (
          <ProfitLedgerReadError className="m-3" error={ledgerQuery.error} onRetry={() => { void ledgerQuery.refetch(); }} />
        ) : !ledger ? (
          <div className="p-3"><Skeleton className="h-20 w-full" aria-label="Đang tải sổ tổng lợi nhuận" /></div>
        ) : ledgerRows.length === 0 ? (
          <p className="m-0 px-3 py-3.5 text-[12px] font-semibold text-[#8d8678]">Chưa có cổ đông.</p>
        ) : (
          <>
          {positionsQuery.isError && (
            <ProfitLedgerReadError className="m-3" error={positionsQuery.error} onRetry={() => { void positionsQuery.refetch(); }} />
          )}
          {ledgerRows.map((row) => {
            const payBlock = shareholderPayBlock(row, routeState);
            // % chỉ khi được cấp quyền xem tỷ lệ (shareholder_profit.view_percent).
            const pct = canViewPercent ? uniformPercent(allocActive.filter((a) => a.shareholder_id === row.shareholder_id)) : null;
            const marker = markerText(row.marker);
            const position = positionById.get(row.shareholder_id) ?? null;
            const advancePending = position ? advancePendingText(position, fmtShort) : null;
            const cashPending = position ? settlementCashPendingText(position, fmtShort) : null;
            return (
              <div
                key={row.shareholder_id}
                data-testid={`ledger-card-${row.shareholder_id}`}
                className={`flex items-center gap-2.5 px-3 py-2.5 border-b border-[#f4f1ea] last:border-b-0 ${shId === row.shareholder_id ? "bg-[#f2f9f4]" : ""} ${row.is_deleted ? "opacity-60" : ""}`}
              >
                <button
                  type="button"
                  onClick={() => setEntriesFor({ id: row.shareholder_id, name: row.name })}
                  className="flex-1 min-w-0 flex flex-col gap-0.5 text-left"
                >
                  <span className="flex items-center gap-1.5 text-[13px] font-extrabold text-[#1b1813]">
                    <span className="truncate">{row.name}</span>
                    {pct && (
                      <span className="font-mono text-[9.5px] font-bold text-[#1a6645] bg-[#e8f3ec] border border-[#d2e8da] rounded-[5px] px-1 py-px shrink-0">
                        {pct}
                      </span>
                    )}
                    {row.is_deleted && (
                      <span className="shrink-0 text-[9.5px] font-bold text-[#8d8678] bg-white border border-[#e7e3da] rounded-[5px] px-1 py-px">đã xoá</span>
                    )}
                  </span>
                  <span className="flex flex-wrap items-center gap-1">
                    {advancePending && (
                      <span className="text-[9.5px] font-bold text-[#a35a0c] bg-[#fdf3e3] rounded-[5px] px-1 py-px">tạm ứng {advancePending}</span>
                    )}
                    {cashPending && (
                      <span className="text-[9.5px] font-bold text-[#514c42] bg-[#efece4] rounded-[5px] px-1 py-px">{cashPending}</span>
                    )}
                    {row.needs_review_count > 0 && (
                      <span className="text-[9.5px] font-bold text-[#a35a0c] bg-[#fdf3e3] rounded-[5px] px-1 py-px">
                        cần xem lại ({row.needs_review_count})
                      </span>
                    )}
                    {marker && <span className="text-[9.5px] font-semibold text-[#8d8678]">mốc {marker}</span>}
                  </span>
                  <span className="text-[10.5px] font-semibold text-[#8d8678]">
                    Chia sau mốc <b className="font-mono text-[#0e7a47]">{fmtShort(row.allocated)}</b> · Đã chi{" "}
                    <b className="font-mono text-[#c97a10]">{fmtShort(row.payouts_approved)}</b> · Chờ duyệt{" "}
                    <b className="font-mono">{fmtShort(row.payouts_pending)}</b> · Qua lương{" "}
                    <b className="font-mono">{fmtShort(salaryNet(row))}</b>
                  </span>
                </button>
                <div className="flex flex-col items-end shrink-0" data-testid={`ledger-position-${row.shareholder_id}`}>
                  <span className={`font-mono text-[13.5px] font-bold tracking-[-0.3px] ${position && isUnpaidNegative(position) ? "text-[#d6453f]" : "text-[#1b1813]"}`}>
                    {position ? fmtShort(position.unpaid_profit) : positionMissing}
                  </span>
                  <span className="text-[9.5px] font-semibold text-[#b6b0a3]">chưa chi</span>
                  <span className="mt-0.5 font-mono text-[12px] font-bold tracking-[-0.3px] text-[#c97a10]">
                    {position ? fmtShort(position.advance_outstanding) : positionMissing}
                  </span>
                  <span className="text-[9.5px] font-semibold text-[#b6b0a3]">tạm ứng</span>
                </div>
                {canDistribute && (
                  <div className="flex shrink-0 flex-col items-stretch gap-1.5">
                    {!row.is_deleted && (
                      <button
                        type="button"
                        disabled={payBlock !== null}
                        title={payBlock ?? undefined}
                        onClick={() => { setDistShareholder(row.shareholder_id); setDistOpen(true); }}
                        className="text-[11.5px] font-bold text-[#1a6645] bg-[#e8f3ec] border border-[#d2e8da] rounded-[9px] px-3 py-[7px] active:scale-95 disabled:opacity-50"
                      >
                        Chi
                      </button>
                    )}
                    {/* Mốc "đã trả đủ" (hộp đặt mốc dùng được ở điện thoại: giới hạn chiều cao + cuộn, nút dính đáy). */}
                    <button
                      type="button"
                      disabled={!routeState.canSetMarker}
                      title={routeState.canSetMarker ? undefined : "Chỉ đặt mốc khi sổ tổng mở phần đặt mốc đã trả đủ."}
                      onClick={() => openMarker(row)}
                      className="text-[11.5px] font-bold text-[#514c42] bg-white border border-[#e7e3da] rounded-[9px] px-3 py-[5px] active:scale-95 disabled:opacity-50"
                    >
                      Mốc
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          <p className="m-0 px-3 py-2.5 border-t border-[#f4f1ea] text-[10.5px] font-semibold leading-snug text-[#8d8678]" data-testid="ledger-position-note">
            {POSITION_EXPLAIN}
            {ledgerPositions.some(isUnpaidNegative) ? ` ${UNPAID_NEGATIVE_NOTE}` : ""}
          </p>
          </>
        )}
      </div>

      {/* Lương điều hành theo sổ (E10) — điện thoại chỉ chi + xem sổ phiếu; đặt mốc trên máy tính. */}
      <ManagerLedgerSection organizationId={selectedOrganizationId} canPayManager={canPayManager} variant="mobile" />

      {/* Hộp CHỐT chi lợi nhuận (không nhập tay số tiền). Lời nhắc "đặt mốc trước" mở hộp đặt mốc ngay trên điện thoại. */}
      <ProfitDistributeDialog
        open={distOpen}
        onOpenChange={setDistOpen}
        organizationId={selectedOrganizationId}
        ledgerRows={ledger?.shareholders}
        defaultShareholderId={distShareholder}
        onReviewSalary={(shareholderId) => {
          setDistOpen(false);
          const row = ledgerRows.find((r) => r.shareholder_id === shareholderId);
          setEntriesFor({ id: shareholderId, name: row?.name ?? "" });
        }}
        onSetMarker={routeState.canSetMarker ? (shareholderId) => {
          const row = ledgerRows.find((r) => r.shareholder_id === shareholderId);
          if (!row) return;
          setDistOpen(false);
          openMarker(row);
        } : undefined}
      />
      <ProfitLedgerMarkerDialog
        open={!!markerFor}
        onOpenChange={(next) => { if (!next) setMarkerFor(null); }}
        organizationId={selectedOrganizationId}
        subjectKind="SHAREHOLDER"
        subject={markerFor}
      />
      {selfAdvanceMe && (
        <ProfitSelfAdvanceDialog
          open={selfAdvanceOpen}
          onOpenChange={setSelfAdvanceOpen}
          organizationId={selectedOrganizationId}
          me={selfAdvanceMe}
        />
      )}
      <ShareholderLedgerSheet
        open={!!entriesFor}
        onOpenChange={(next) => { if (!next) setEntriesFor(null); }}
        organizationId={selectedOrganizationId}
        shareholder={entriesFor}
        route={ledger?.route}
        canDistribute={canDistribute}
        compact
      />
    </div>
    </QueryRegion>
  );
}
