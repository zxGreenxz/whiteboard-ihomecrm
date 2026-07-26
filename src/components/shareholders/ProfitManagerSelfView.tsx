import { useMemo, useState } from "react";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { formatCurrency } from "@/lib/utils";
import { ProfitHubSlot } from "@/pages/reports/finance/ProfitHubShell";
import { DonutBreakdown, MiniBars } from "./profitCharts";
import { currentYear } from "./shareholderUtils";
import { useMyShareBuildings } from "@/hooks/useShareholders";
import {
  useProfitManagerAllocations,
  useManagerSalaryPayouts,
  computeShareholderSummary,
} from "@/hooks/useShareholderProfit";
import type { ProfitManager } from "@/hooks/useProfitManagers";

const ALL = "all";

export default function ProfitManagerSelfView({ me }: { me: ProfitManager }) {
  const [year, setYear] = useState(currentYear());
  const [month, setMonth] = useState<string>(ALL);
  const { data: allocations = [] } = useProfitManagerAllocations(); // RLS: chỉ của mình
  const { data: payouts = [] } = useManagerSalaryPayouts(); // RLS: chỉ của mình
  // Tên tòa qua RPC riêng (vai lợi-nhuận không còn quyền đọc bảng buildings).
  const { data: buildings = [] } = useMyShareBuildings();

  const buildingName = (id?: string) => buildings.find((b) => b.id === id)?.name ?? "—";
  const monthOf = (p?: string) => Number((p ?? "").slice(5, 7));

  const summary = useMemo(
    () =>
      computeShareholderSummary(
        [me.id],
        allocations.map((a) => ({ shareholder_id: a.manager_id, amount: a.amount })),
        payouts.map((p) => ({ shareholder_id: p.manager_id, total_amount: p.total_amount }))
      )[me.id],
    [me.id, allocations, payouts]
  );

  const allocYear = useMemo(
    () => allocations.filter((a) => (a.period_month ?? "").startsWith(String(year))),
    [allocations, year]
  );
  const allocScoped = useMemo(
    () => allocYear.filter((a) => month === ALL || monthOf(a.period_month) === Number(month)),
    [allocYear, month]
  );
  const salaryThisYear = useMemo(() => allocYear.reduce((s, a) => s + a.amount, 0), [allocYear]);

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

  const scopeNames = byBuilding.map((b) => b.name).slice(0, 3).join(" · ");
  const years = [currentYear() + 1, currentYear(), currentYear() - 1, currentYear() - 2];
  const paidTotal = payouts.reduce((s, p) => s + p.total_amount, 0);

  return (
    <>
      <ProfitHubSlot name="kpis">
        <div className="ph-kpi ph-kpi--flex">
          <div className="ph-kpi__label">Quản lý điều hành</div>
          <div className="ph-kpi__value">{me.name}</div>
          <div className="ph-kpi__sub">{scopeNames ? `phụ trách ${scopeNames}` : "chưa gán nhà nào"}</div>
        </div>
        <div className="ph-kpi__div" />
        <div className="ph-kpi ph-kpi--flex">
          <div className="ph-kpi__label">Được nhận (luỹ kế)</div>
          <div className="ph-kpi__value ph-kpi__value--mint">{formatCurrency(summary?.accrued ?? 0)}</div>
          <div className="ph-kpi__sub">từ {allocations.length} kỳ chốt</div>
        </div>
        <div className="ph-kpi__div" />
        <div className="ph-kpi ph-kpi--flex">
          <div className="ph-kpi__label">Đã trả / đã lấy</div>
          <div className="ph-kpi__value ph-kpi__value--gold">{formatCurrency(summary?.paid ?? 0)}</div>
          <div className="ph-kpi__sub">{payouts.length} phiếu chi lương</div>
        </div>
        <div className="ph-kpi__div" />
        <div className="ph-kpi ph-kpi--flex">
          <div className="ph-kpi__label">Còn lại</div>
          <div className="ph-kpi__value">{formatCurrency(summary?.remaining ?? 0)}</div>
          <div className="ph-kpi__sub ph-kpi__sub--mint">
            Lương năm {year}: {formatCurrency(salaryThisYear)}
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
            <div className="ph-card__title">Lương điều hành theo tháng — {year}</div>
            <MiniBars
              data={monthlyChart}
              height={110}
              tone="orange"
              digits={1}
              highlight={highlightMonth}
              footnote="Đơn vị: triệu ₫ · theo quy tắc lương đang áp dụng cho từng nhà"
            />
          </div>

          <div className="ph-card ph-card__pad">
            <div className="ph-card__title">
              Theo nhà — {year}{month === ALL ? "" : ` · T${month}`}
            </div>
            <DonutBreakdown data={byBuilding} caption={`NĂM ${year}`} />
          </div>
        </div>

        <div className="ph-card">
          <div className="ph-card__head">
            <div className="ph-card__title">Lịch sử đã trả / đã lấy</div>
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
                {payouts.length === 0 && (
                  <tr><td colSpan={3} style={{ textAlign: "center", color: "var(--ph-ink-4)" }}>Chưa có khoản trả nào</td></tr>
                )}
                {payouts.map((d) => (
                  <tr key={d.id}>
                    <td>{d.voucher_date}</td>
                    <td>{d.name}</td>
                    <td className="num neg strong">{formatCurrency(d.total_amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {payouts.length > 0 && (
            <div className="ph-card__foot">
              <b>Tổng đã trả (luỹ kế)</b>
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
