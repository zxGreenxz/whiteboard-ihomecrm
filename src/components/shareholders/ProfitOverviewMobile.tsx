import { useMemo, useState } from "react";
import { Plus, Briefcase } from "lucide-react";
import { colorAt } from "./shareholderUtils";
import { useShareholders } from "@/hooks/useShareholders";
import { useProfitManagers } from "@/hooks/useProfitManagers";
import { useBuildings } from "@/hooks/useBuildings";
import {
  useProfitMonthly,
  useProfitAllocations,
  useShareholderDistributions,
  useProfitManagerAllocations,
  useManagerSalaryPayouts,
  computeShareholderSummary,
} from "@/hooks/useShareholderProfit";
import ProfitDistributeDialog from "./ProfitDistributeDialog";
import ManagerSalaryPayoutDialog from "./ManagerSalaryPayoutDialog";
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
  const [month, setMonth] = useState<string>(ALL); // "all" | "1".."12"
  const [shId, setShId] = useState<string>(ALL);
  const [distOpen, setDistOpen] = useState(false);
  const [distShareholder, setDistShareholder] = useState<string | null>(null);
  const [payoutOpen, setPayoutOpen] = useState(false);
  const [payoutManager, setPayoutManager] = useState<string | null>(null);

  const { data: shareholders = [] } = useShareholders();
  const { data: buildings = [] } = useBuildings();
  const { data: profitMonthly = [] } = useProfitMonthly();
  const { data: allocations = [] } = useProfitAllocations();
  const { data: distributions = [] } = useShareholderDistributions();

  const { data: managers = [] } = useProfitManagers();
  const { data: managerAllocations = [] } = useProfitManagerAllocations();
  const { data: managerPayouts = [] } = useManagerSalaryPayouts();

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

  // KPI settlement luỹ kế (mọi năm), lọc theo cổ đông đang chọn — như desktop.
  const summary = useMemo(
    () => computeShareholderSummary(shareholders.map((s) => s.id), allocActive, distActive),
    [shareholders, allocActive, distActive]
  );
  const activeMgrIds = useMemo(() => new Set(managers.map((m) => m.id)), [managers]);
  const managerSummary = useMemo(
    () =>
      computeShareholderSummary(
        managers.map((m) => m.id),
        managerAllocations
          .filter((a) => activeMgrIds.has(a.manager_id))
          .map((a) => ({ shareholder_id: a.manager_id, amount: a.amount })),
        managerPayouts
          .filter((p) => activeMgrIds.has(p.manager_id))
          .map((p) => ({ shareholder_id: p.manager_id, total_amount: p.total_amount }))
      ),
    [managers, managerAllocations, managerPayouts, activeMgrIds]
  );

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
    <div className="flex flex-col gap-2.5">
      {/* KPI 2×2 */}
      <div className="grid grid-cols-2 gap-2">
        <div className={`${CARD} px-3 py-2.5`}>
          <div className={kpiLabel}>Tổng LN đã chốt (luỹ kế)</div>
          <div className={`${kpiVal} text-[#2b5aa0]`}>{fmtShort(totals.lockedProfit)}</div>
          <div className={kpiSub}>Trước chia cổ đông</div>
        </div>
        <div className={`${CARD} px-3 py-2.5`}>
          <div className={kpiLabel}>{shName ? `Được chia · ${shName}` : "Tổng được chia cổ đông"}</div>
          <div className={`${kpiVal} text-[#0e7a47]`}>{fmtShort(totals.accrued)}</div>
          <div className={kpiSub}>Luỹ kế đã chốt</div>
        </div>
        <div className={`${CARD} px-3 py-2.5`}>
          <div className={kpiLabel}>Đã ứng / đã chia</div>
          <div className={`${kpiVal} text-[#c97a10]`}>{fmtShort(totals.paid)}</div>
          <div className={kpiSub}>{shName ?? "Tất cả cổ đông"}</div>
        </div>
        <div className={`${CARD} px-3 py-2.5`}>
          <div className={kpiLabel}>Còn phải trả</div>
          <div className={`${kpiVal} ${totals.remaining < 0 ? "text-[#d6453f]" : "text-[#1b1813]"}`}>
            {fmtShort(totals.remaining)}
          </div>
          <div className={kpiSub}>Được chia − đã ứng</div>
        </div>
      </div>

      {/* Năm + chip tháng */}
      <YearMonthRow year={year} month={month} onYearShift={shiftYear} onMonthChange={setMonth} />

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

      {/* Theo cổ đông */}
      <div className={`${CARD} overflow-hidden`}>
        <div className="flex items-center gap-2 px-3 py-3 border-b border-[#efece4]">
          <span className="text-[12.5px] font-extrabold tracking-[-0.1px] text-[#1b1813]">Theo cổ đông</span>
          <span className="text-[10.5px] font-semibold text-[#8d8678]">luỹ kế</span>
          <button
            onClick={() => { setDistShareholder(shId === ALL ? null : shId); setDistOpen(true); }}
            className="ml-auto inline-flex items-center gap-1 text-[11.5px] font-bold text-white bg-[#1f7a52] rounded-[9px] px-2.5 py-1.5 shadow-sm active:scale-95"
          >
            <Plus className="h-3 w-3" strokeWidth={2.5} /> Chi lợi nhuận
          </button>
        </div>
        {shareholders.length === 0 && (
          <p className="m-0 px-3 py-3.5 text-[12px] font-semibold text-[#8d8678]">Chưa có cổ đông.</p>
        )}
        {shareholders.map((s) => {
          const r = summary[s.id] ?? { accrued: 0, paid: 0, remaining: 0 };
          const active = shId === s.id;
          const pct = uniformPercent(allocActive.filter((a) => a.shareholder_id === s.id));
          return (
            <div
              key={s.id}
              className={`flex items-center gap-2.5 px-3 py-2.5 border-b border-[#f4f1ea] last:border-b-0 ${active ? "bg-[#f2f9f4]" : ""}`}
            >
              <button onClick={() => setShId(active ? ALL : s.id)} className="flex-1 min-w-0 flex flex-col gap-0.5 text-left">
                <span className="flex items-center gap-1.5 text-[13px] font-extrabold text-[#1b1813]">
                  <span className="truncate">{s.name}</span>
                  {pct && (
                    <span className="font-mono text-[9.5px] font-bold text-[#1a6645] bg-[#e8f3ec] border border-[#d2e8da] rounded-[5px] px-1 py-px shrink-0">
                      {pct}
                    </span>
                  )}
                </span>
                <span className="text-[10.5px] font-semibold text-[#8d8678]">
                  Được chia <b className="font-mono text-[#0e7a47]">{fmtShort(r.accrued)}</b> · Đã ứng{" "}
                  <b className="font-mono text-[#c97a10]">{fmtShort(r.paid)}</b>
                </span>
              </button>
              <div className="flex flex-col items-end shrink-0">
                <span className={`font-mono text-[13.5px] font-bold tracking-[-0.3px] ${r.remaining < 0 ? "text-[#d6453f]" : "text-[#1b1813]"}`}>
                  {fmtShort(r.remaining)}
                </span>
                <span className="text-[9.5px] font-semibold text-[#b6b0a3]">còn lại</span>
              </div>
              <button
                onClick={() => { setDistShareholder(s.id); setDistOpen(true); }}
                className="shrink-0 text-[11.5px] font-bold text-[#1a6645] bg-[#e8f3ec] border border-[#d2e8da] rounded-[9px] px-3 py-[7px] active:scale-95"
              >
                Chi
              </button>
            </div>
          );
        })}
      </div>

      {/* Lương điều hành */}
      {managers.length > 0 && (
        <div className={`${CARD} overflow-hidden`}>
          <div className="flex items-center gap-2 px-3 py-3 border-b border-[#efece4]">
            <Briefcase className="h-3.5 w-3.5 text-[#c2570f]" />
            <span className="text-[12.5px] font-extrabold tracking-[-0.1px] text-[#1b1813]">Lương điều hành</span>
            <span className="text-[10.5px] font-semibold text-[#8d8678]">luỹ kế</span>
          </div>
          {managers.map((m) => {
            const r = managerSummary[m.id] ?? { accrued: 0, paid: 0, remaining: 0 };
            return (
              <div key={m.id} className="flex items-center gap-2.5 px-3 py-2.5 border-b border-[#f4f1ea] last:border-b-0">
                <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                  <span className="text-[13px] font-extrabold text-[#1b1813] truncate">{m.name}</span>
                  <span className="text-[10.5px] font-semibold text-[#8d8678]">
                    Được nhận <b className="font-mono text-[#c2570f]">{fmtShort(r.accrued)}</b> · Đã trả{" "}
                    <b className="font-mono text-[#c97a10]">{fmtShort(r.paid)}</b>
                  </span>
                </div>
                <div className="flex flex-col items-end shrink-0">
                  <span className={`font-mono text-[13.5px] font-bold tracking-[-0.3px] ${r.remaining < 0 ? "text-[#d6453f]" : "text-[#1b1813]"}`}>
                    {fmtShort(r.remaining)}
                  </span>
                  <span className="text-[9.5px] font-semibold text-[#b6b0a3]">còn lại</span>
                </div>
                <button
                  onClick={() => { setPayoutManager(m.id); setPayoutOpen(true); }}
                  className="shrink-0 text-[11.5px] font-bold text-[#c2570f] bg-[#fdf0e8] border border-[#f3d6c4] rounded-[9px] px-3 py-[7px] active:scale-95"
                >
                  Chi
                </button>
              </div>
            );
          })}
        </div>
      )}

      <ProfitDistributeDialog
        open={distOpen}
        onOpenChange={setDistOpen}
        shareholders={shareholders}
        defaultShareholderId={distShareholder}
      />
      <ManagerSalaryPayoutDialog
        open={payoutOpen}
        onOpenChange={setPayoutOpen}
        managers={managers}
        defaultManagerId={payoutManager}
      />
    </div>
  );
}
