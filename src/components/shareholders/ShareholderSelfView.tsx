import { useMemo, useState } from "react";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { formatCurrency } from "@/lib/utils";
import { ProfitHubSlot } from "@/pages/reports/finance/ProfitHubShell";
import { DonutBreakdown, MiniBars } from "./profitCharts";
import { currentYear } from "./shareholderUtils";
import {
  useProfitAllocations,
  useShareholderDistributions,
  computeShareholderSummary,
} from "@/hooks/useShareholderProfit";
import { useMyShareBuildings, type Shareholder } from "@/hooks/useShareholders";

const ALL = "all";

export default function ShareholderSelfView({ me }: { me: Shareholder }) {
  const [year, setYear] = useState(currentYear());
  const [month, setMonth] = useState<string>(ALL); // "all" | "1".."12"
  const { data: allocations = [] } = useProfitAllocations(); // RLS: chỉ của mình
  const { data: distributions = [] } = useShareholderDistributions(); // RLS: chỉ của mình
  // Tên tòa qua RPC riêng (cổ đông không còn quyền đọc bảng buildings).
  const { data: buildings = [] } = useMyShareBuildings();

  const buildingName = (id?: string) => buildings.find((b) => b.id === id)?.name ?? "—";
  const monthOf = (p?: string) => Number((p ?? "").slice(5, 7));

  const summary = useMemo(
    () => computeShareholderSummary([me.id], allocations, distributions)[me.id],
    [me.id, allocations, distributions]
  );

  const allocYear = useMemo(
    () => allocations.filter((a) => (a.period_month ?? "").startsWith(String(year))),
    [allocations, year]
  );

  // Thêm lọc tháng cho biểu đồ cơ cấu theo nhà + 2 bảng (biểu đồ cột giữ cả 12 tháng).
  const allocScoped = useMemo(
    () => allocYear.filter((a) => month === ALL || monthOf(a.period_month) === Number(month)),
    [allocYear, month]
  );

  const profitThisYear = useMemo(() => allocYear.reduce((s, a) => s + a.amount, 0), [allocYear]);

  const monthlyChart = useMemo(
    () =>
      Array.from({ length: 12 }, (_, i) => {
        const m = i + 1;
        const amount = allocYear
          .filter((a) => monthOf(a.period_month) === m)
          .reduce((s, a) => s + a.amount, 0);
        return { label: `T${m}`, value: amount, empty: amount === 0 };
      }),
    [allocYear]
  );
  const highlightMonth =
    month !== ALL ? Number(month) - 1 : year === currentYear() ? new Date().getMonth() : undefined;

  const byBuilding = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of allocScoped) m.set(a.building_id ?? "?", (m.get(a.building_id ?? "?") ?? 0) + a.amount);
    return Array.from(m.entries())
      .map(([bid, value]) => ({ name: buildingName(bid), value }))
      .filter((x) => x.value !== 0)
      .sort((a, b) => b.value - a.value);
  }, [allocScoped, buildings]);

  // ---- Ma trận Nhà × Tháng (được chia) ----
  const buildingIdsInYear = useMemo(
    () => Array.from(new Set(allocScoped.map((a) => a.building_id).filter(Boolean) as string[])),
    [allocScoped]
  );
  const cell = (bid: string, m: number) => {
    const rows = allocYear.filter((a) => a.building_id === bid && monthOf(a.period_month) === m);
    return rows.length ? rows.reduce((s, a) => s + a.amount, 0) : undefined;
  };
  const monthsToShow = month === ALL ? Array.from({ length: 12 }, (_, i) => i + 1) : [Number(month)];

  const years = [currentYear() + 1, currentYear(), currentYear() - 1, currentYear() - 2];
  const paidTotal = distributions.reduce((s, d) => s + d.total_amount, 0);

  return (
    <>
      <ProfitHubSlot name="kpis">
        <div className="ph-kpi ph-kpi--flex">
          <div className="ph-kpi__label">Cổ đông</div>
          <div className="ph-kpi__value">{me.name}</div>
          <div className="ph-kpi__sub">
            {buildings.length > 0 ? `${buildings.length} nhà được chia` : "chưa gán nhà nào"}
          </div>
        </div>
        <div className="ph-kpi__div" />
        <div className="ph-kpi ph-kpi--flex">
          <div className="ph-kpi__label">Được chia (luỹ kế)</div>
          <div className="ph-kpi__value ph-kpi__value--mint">{formatCurrency(summary?.accrued ?? 0)}</div>
          <div className="ph-kpi__sub">từ {allocations.length} kỳ chốt</div>
        </div>
        <div className="ph-kpi__div" />
        <div className="ph-kpi ph-kpi--flex">
          <div className="ph-kpi__label">Đã ứng / đã lấy</div>
          <div className="ph-kpi__value ph-kpi__value--gold">{formatCurrency(summary?.paid ?? 0)}</div>
          <div className="ph-kpi__sub">{distributions.length} phiếu chi</div>
        </div>
        <div className="ph-kpi__div" />
        <div className="ph-kpi ph-kpi--flex">
          <div className="ph-kpi__label">Còn lại</div>
          <div className="ph-kpi__value">{formatCurrency(summary?.remaining ?? 0)}</div>
          <div className="ph-kpi__sub ph-kpi__sub--mint">
            LN năm {year}: {formatCurrency(profitThisYear)}
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
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <SelectItem key={m} value={String(m)}>Tháng {m}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="ph-grid-2">
          <div className="ph-card ph-card__pad">
            <div className="ph-card__title">Lợi nhuận được chia theo tháng — {year}</div>
            <MiniBars
              data={monthlyChart}
              highlight={highlightMonth}
              footnote="Đơn vị: triệu ₫ · phần của bạn sau khi trừ lương điều hành"
            />
          </div>

          <div className="ph-card ph-card__pad">
            <div className="ph-card__title">
              Theo nhà — {year}{month === ALL ? "" : ` · T${month}`}
            </div>
            <DonutBreakdown data={byBuilding} caption="ĐƯỢC CHIA" />
          </div>
        </div>

        {/* Ma trận Nhà × Tháng — số được chia của tôi */}
        <div className="ph-card">
          <div className="ph-card__head">
            <div className="ph-card__title">LN được chia Nhà × Tháng — {year}</div>
          </div>
          {buildingIdsInYear.length === 0 ? (
            <div className="ph-empty">
              Chưa có phần chia trong {month === ALL ? `năm ${year}` : `tháng ${month}/${year}`}.
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
                        {formatCurrency(monthsToShow.reduce((s, m) => s + (cell(bid, m) ?? 0), 0))}
                      </td>
                    ))}
                    <td className="num" style={{ fontWeight: 800, color: "var(--ph-green-d)" }}>
                      {formatCurrency(profitThisYear)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>

        <div className="ph-card">
          <div className="ph-card__head">
            <div className="ph-card__title">Lịch sử đã ứng / đã lấy</div>
          </div>
          <div className="ph-tbl__scroll">
            <table className="ph-tbl">
              <thead>
                <tr>
                  <th style={{ width: 120 }}>Ngày</th>
                  <th>Diễn giải</th>
                  <th className="num" style={{ width: 140 }}>Số tiền</th>
                </tr>
              </thead>
              <tbody>
                {distributions.length === 0 && (
                  <tr><td colSpan={3} style={{ textAlign: "center", color: "var(--ph-ink-4)" }}>Chưa có khoản ứng nào</td></tr>
                )}
                {distributions.map((d) => (
                  <tr key={d.id}>
                    <td>{d.voucher_date}</td>
                    <td>{d.name}</td>
                    <td className="num neg strong">{formatCurrency(d.total_amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {distributions.length > 0 && (
            <div className="ph-card__foot">
              <b>Tổng đã ứng (luỹ kế)</b>
              <b style={{ fontVariantNumeric: "tabular-nums", color: "var(--ph-amber-d)" }}>
                {formatCurrency(paidTotal)}
              </b>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
