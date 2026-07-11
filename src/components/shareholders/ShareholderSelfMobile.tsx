import { useMemo, useState } from "react";
import { HandCoins } from "lucide-react";
import { colorAt } from "./shareholderUtils";
import {
  useProfitAllocations,
  useShareholderDistributions,
  computeShareholderSummary,
} from "@/hooks/useShareholderProfit";
import { useMyShareBuildings, type Shareholder } from "@/hooks/useShareholders";
import {
  CARD,
  fmtShort,
  MonthBars,
  BuildingMatrix,
  YearMonthRow,
  uniformPercent,
} from "./profitMobileShared";

const ALL = "all";

// Tab "Của tôi" MOBILE — cổ đông-partner tự xem phần lợi nhuận của mình.
// Bản thu gọn của ShareholderSelfView (desktop), CÙNG hook/dữ liệu (RLS tự lọc
// về đúng cổ đông đang đăng nhập) — thiết kế ProfitMobileC · "C · Của tôi".
export default function ShareholderSelfMobile({
  me,
  year,
  onYearChange,
}: {
  me: Shareholder;
  year: number;
  onYearChange: (y: number) => void;
}) {
  const [month, setMonth] = useState<string>(ALL); // "all" | "1".."12"
  const { data: allocations = [] } = useProfitAllocations(); // RLS: chỉ của mình
  const { data: distributions = [] } = useShareholderDistributions(); // RLS: chỉ của mình
  // Tên tòa qua RPC riêng (cổ đông không có quyền đọc bảng buildings).
  const { data: buildings = [] } = useMyShareBuildings();

  const buildingName = (id?: string) => buildings.find((b) => b.id === id)?.name ?? "—";
  const monthOf = (p?: string) => Number((p ?? "").slice(5, 7));
  const shiftYear = (delta: number) => {
    onYearChange(year + delta);
    setMonth(ALL);
  };

  const summary = useMemo(
    () => computeShareholderSummary([me.id], allocations, distributions)[me.id],
    [me.id, allocations, distributions]
  );

  const allocYear = useMemo(
    () => allocations.filter((a) => (a.period_month ?? "").startsWith(String(year))),
    [allocations, year]
  );
  const allocScoped = useMemo(
    () => allocYear.filter((a) => month === ALL || monthOf(a.period_month) === Number(month)),
    [allocYear, month]
  );

  const profitThisYear = useMemo(() => allocYear.reduce((s, a) => s + a.amount, 0), [allocYear]);
  const monthVals = useMemo(
    () =>
      Array.from({ length: 12 }, (_, i) =>
        allocYear.filter((a) => monthOf(a.period_month) === i + 1).reduce((s, a) => s + a.amount, 0)
      ),
    [allocYear]
  );
  const lockedMonthsInYear = useMemo(
    () => new Set(allocYear.map((a) => a.period_month)).size,
    [allocYear]
  );

  // Theo nhà: giá trị + % cơ cấu + thanh tiến độ (so với toà cao nhất).
  const buildingIdsInYear = useMemo(
    () =>
      Array.from(new Set(allocScoped.map((a) => a.building_id).filter(Boolean) as string[])).sort(
        (a, b) => buildingName(a).localeCompare(buildingName(b), "vi")
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allocScoped, buildings]
  );
  const bldRows = useMemo(() => {
    const vals = buildingIdsInYear.map((bid) => ({
      bid,
      v: allocScoped.filter((a) => a.building_id === bid).reduce((s, a) => s + a.amount, 0),
    }));
    const sum = vals.reduce((t, x) => t + x.v, 0) || 1;
    const max = Math.max(...vals.map((x) => x.v), 1);
    return vals.map(({ bid, v }, i) => ({
      bid,
      name: buildingName(bid),
      v,
      pct: (v / sum) * 100,
      fill: (v / max) * 100,
      color: colorAt(i),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildingIdsInYear, allocScoped, buildings]);

  const cell = (bid: string, m: number) => {
    const rows = allocYear.filter((a) => a.building_id === bid && monthOf(a.period_month) === m);
    return rows.length ? rows.reduce((s, a) => s + a.amount, 0) : undefined;
  };
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

  const scopeMonthLabel = month === ALL ? `năm ${year}` : `T${month}/${year}`;
  const pct = uniformPercent(allocations);
  const initial = (me.name || "?").trim().charAt(0).toUpperCase();

  const kpiVal = "font-mono font-bold text-[17px] tracking-[-0.4px] mt-1 whitespace-nowrap leading-none";
  const kpiLabel = "text-[10px] font-bold tracking-wide text-[#8d8678] uppercase";
  const kpiSub = "text-[10.5px] text-[#b6b0a3] font-semibold mt-1";

  return (
    <div className="flex flex-col gap-3">
      {/* Hero */}
      <div
        className="rounded-[20px] px-4 py-[15px] text-white flex items-center gap-3"
        style={{ background: "linear-gradient(155deg,#1f7a52,#1a6645)" }}
      >
        <div className="w-11 h-11 rounded-full bg-white/15 border border-white/30 grid place-items-center font-extrabold text-[17px] shrink-0">
          {initial}
        </div>
        <div className="flex flex-col gap-0.5 min-w-0 flex-1">
          <span className="text-[15px] font-extrabold tracking-[-0.2px] truncate">{me.name}</span>
          <span className="text-[11.5px] font-semibold text-white/80 truncate">
            Cổ đông{pct ? ` · tỷ lệ ${pct}` : ""}{buildings.length ? ` · ${buildings.length} toà nhà` : ""}
          </span>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[10px] font-bold tracking-wide text-white/75">CÒN LẠI</div>
          <div className="font-mono text-[18px] font-bold tracking-[-0.4px]">{fmtShort(summary?.remaining ?? 0)}</div>
        </div>
      </div>

      {/* KPI 2×2 */}
      <div className="grid grid-cols-2 gap-2.5">
        <div className={`${CARD} !rounded-2xl px-3 py-3`}>
          <span className={kpiLabel}>Được chia (luỹ kế)</span>
          <div className={`${kpiVal} text-[#0e7a47]`}>{fmtShort(summary?.accrued ?? 0)}</div>
          <div className={kpiSub}>Sau chốt LN tháng</div>
        </div>
        <div className={`${CARD} !rounded-2xl px-3 py-3`}>
          <span className={kpiLabel}>Đã ứng / đã lấy</span>
          <div className={`${kpiVal} text-[#c97a10]`}>{fmtShort(summary?.paid ?? 0)}</div>
          <div className={kpiSub}>{distributions.length} lần ứng</div>
        </div>
        <div className={`${CARD} !rounded-2xl px-3 py-3`}>
          <span className={kpiLabel}>Còn lại</span>
          <div className={`${kpiVal} ${(summary?.remaining ?? 0) < 0 ? "text-[#d6453f]" : "text-[#2b5aa0]"}`}>
            {fmtShort(summary?.remaining ?? 0)}
          </div>
          <div className={kpiSub}>Chưa nhận</div>
        </div>
        <div className={`${CARD} !rounded-2xl px-3 py-3`}>
          <span className={kpiLabel}>LN năm {year}</span>
          <div className={`${kpiVal} text-[#1b1813]`}>{fmtShort(profitThisYear)}</div>
          <div className={kpiSub}>
            {lockedMonthsInYear > 0 ? `${lockedMonthsInYear} tháng đã chốt` : "Chưa có dữ liệu"}
          </div>
        </div>
      </div>

      {/* Năm + chip tháng */}
      <YearMonthRow year={year} month={month} onYearShift={shiftYear} onMonthChange={setMonth} />

      {/* Được chia theo tháng */}
      <div className={`${CARD} !rounded-2xl px-[15px] py-3.5`}>
        <div className="flex items-baseline gap-1.5">
          <span className="text-[13.5px] font-extrabold tracking-[-0.1px] text-[#1b1813]">Được chia theo tháng</span>
          <span className="text-[11px] font-semibold text-[#8d8678]">năm {year}</span>
          <span className="ml-auto font-mono text-[12px] font-bold text-[#0e7a47]">{fmtShort(profitThisYear)}</span>
        </div>
        <div className="mt-3.5">
          <MonthBars values={monthVals} month={month} onMonthChange={setMonth} areaHeight={120} barMax={76} />
        </div>
      </div>

      {/* Theo nhà */}
      <div className={`${CARD} !rounded-2xl px-[15px] py-3.5`}>
        <div className="flex flex-col">
          <span className="text-[13.5px] font-extrabold tracking-[-0.1px] text-[#1b1813]">Theo nhà</span>
          <span className="text-[11px] font-semibold text-[#8d8678]">{scopeMonthLabel}</span>
        </div>
        {bldRows.length === 0 ? (
          <p className="mt-3 mb-0 text-[12.5px] font-semibold text-[#8d8678]">Chưa có dữ liệu trong {scopeMonthLabel}.</p>
        ) : (
          <div className="flex flex-col gap-2.5 mt-3">
            {bldRows.map((b) => (
              <div key={b.bid} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-[3px] shrink-0" style={{ background: b.color }} />
                  <span className="font-mono text-[12.5px] font-bold text-[#1b1813] flex-1 min-w-0 truncate">{b.name}</span>
                  <span className="font-mono text-[12.5px] font-bold text-[#1b1813]">{fmtShort(b.v)}</span>
                  <span className="font-mono text-[11px] font-bold text-[#8d8678] w-12 text-right">
                    {b.pct.toFixed(1)}%
                  </span>
                </div>
                <div className="h-[7px] rounded-full bg-[#efece4] overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${b.fill}%`, background: b.color }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Ma trận Nhà × Tháng */}
      <div className={`${CARD} !rounded-2xl overflow-hidden`}>
        <div className="flex items-baseline gap-1.5 px-[15px] pt-3.5 pb-2.5">
          <span className="text-[13.5px] font-extrabold tracking-[-0.1px] text-[#1b1813]">Được chia Nhà × Tháng</span>
          <span className="ml-auto text-[10px] font-bold text-[#8d8678] bg-[#faf8f4] border border-[#efece4] rounded-md px-1.5 py-0.5">
            triệu ₫
          </span>
        </div>
        {matrixRows.length > 0 ? (
          <BuildingMatrix heads={buildingIdsInYear.map(buildingName)} rows={matrixRows} />
        ) : (
          <p className="m-0 px-[15px] pb-4 pt-1 text-[12.5px] font-semibold text-[#8d8678]">
            Chưa có phần chia trong năm {year}.
          </p>
        )}
      </div>

      {/* Lịch sử đã ứng / đã lấy */}
      <div className={`${CARD} !rounded-2xl overflow-hidden`}>
        <div className="flex items-center gap-2 px-[15px] py-3.5 border-b border-[#efece4]">
          <span className="text-[13.5px] font-extrabold tracking-[-0.1px] text-[#1b1813]">Lịch sử đã ứng / đã lấy</span>
          <span className="ml-auto font-mono text-[12px] font-bold text-[#c97a10]">{fmtShort(summary?.paid ?? 0)}</span>
        </div>
        {distributions.length === 0 && (
          <p className="m-0 px-[15px] py-3.5 text-[12.5px] font-semibold text-[#8d8678]">Chưa có khoản ứng nào.</p>
        )}
        {distributions.map((d) => (
          <div key={d.id} className="flex items-center gap-[11px] px-[15px] py-[11px] border-b border-[#f4f1ea] last:border-b-0">
            <span className="w-8 h-8 rounded-[10px] bg-[#fbf1da] text-[#c97a10] grid place-items-center shrink-0">
              <HandCoins className="h-[15px] w-[15px]" />
            </span>
            <div className="flex-1 min-w-0 flex flex-col gap-px">
              <span className="text-[12.5px] font-bold text-[#1b1813] truncate">{d.name}</span>
              <span className="font-mono text-[10.5px] font-bold text-[#8d8678]">{d.voucher_date}</span>
            </div>
            <span className="font-mono text-[13px] font-bold text-[#c97a10] whitespace-nowrap">
              {fmtShort(d.total_amount)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
