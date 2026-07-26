import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
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

const ALL = "all";

export default function ProfitOverviewTab() {
  const [year, setYear] = useState(currentYear());
  const [month, setMonth] = useState<string>(ALL); // "all" | "1".."12"
  const [shId, setShId] = useState<string>(ALL); // "all" | shareholder_id
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

  const buildingName = (id: string) => buildings.find((b: any) => b.id === id)?.name ?? "—";
  const monthOf = (period?: string) => Number((period ?? "").slice(5, 7));

  // Chỉ tính phần của cổ đông CÒN HIỆU LỰC: phân bổ/phiếu chi gắn cổ đông đã xoá
  // (vd "Green") không được cộng vào tổng — nếu không "Tổng được chia" sẽ phồng
  // hơn tổng từng cổ đông đang hiển thị. (shareholders đã loại deleted_at.)
  const activeIds = useMemo(() => new Set(shareholders.map((s) => s.id)), [shareholders]);
  const allocActive = useMemo(
    () => allocations.filter((a) => activeIds.has(a.shareholder_id)),
    [allocations, activeIds]
  );
  const distActive = useMemo(
    () => distributions.filter((d) => activeIds.has(d.shareholder_id)),
    [distributions, activeIds]
  );

  // ---- Phân bổ (đã GẮN % cổ đông) lọc theo năm + cổ đông ----
  // Charts/bảng lấy từ profit_allocations (amount = LN nhà × % cổ đông) thay vì
  // adjusted_profit thô của profit_monthly → đúng phần CỔ ĐÔNG ĐƯỢC CHIA.
  const allocYear = useMemo(
    () =>
      allocActive.filter(
        (a) =>
          (a.period_month ?? "").startsWith(String(year)) &&
          (shId === ALL || a.shareholder_id === shId)
      ),
    [allocActive, year, shId]
  );

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
  const summary = useMemo(
    () => computeShareholderSummary(shareholders.map((s) => s.id), allocActive, distActive),
    [shareholders, allocActive, distActive]
  );

  // ---- Lương điều hành: settlement luỹ kế theo quản lý (tái dùng computeShareholderSummary) ----
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
    // Tổng LN đã chốt = toàn bộ LN doanh nghiệp đã khoá (KHÔNG theo cổ đông — là gốc trước chia).
    const lockedProfit = profitMonthly
      .filter((p) => p.status === "LOCKED")
      .reduce((s, p) => s + p.adjusted_profit, 0);
    // Được chia / Đã ứng / Còn lại = luỹ kế, lọc theo cổ đông đang chọn (đã loại cổ đông xoá).
    const allocF = allocActive.filter((a) => shId === ALL || a.shareholder_id === shId);
    const distF = distActive.filter((d) => shId === ALL || d.shareholder_id === shId);
    const accrued = allocF.reduce((s, a) => s + a.amount, 0);
    const paid = distF.reduce((s, d) => s + d.total_amount, 0);
    return { lockedProfit, accrued, paid, remaining: accrued - paid };
  }, [profitMonthly, allocActive, distActive, shId]);

  const remainingChart = useMemo(
    () =>
      shareholders
        .map((s) => ({ name: s.name, value: summary[s.id]?.remaining ?? 0 }))
        .filter((x) => x.value !== 0)
        .sort((a, b) => b.value - a.value),
    [shareholders, summary]
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
    <>
      <ProfitHubSlot name="kpis">
        <div className="ph-kpi">
          <div className="ph-kpi__label">Tổng LN đã chốt (luỹ kế)</div>
          <div className="ph-kpi__value">{formatCurrency(totals.lockedProfit)}</div>
          <div className="ph-kpi__sub">trước chia cổ đông</div>
        </div>
        <div className="ph-kpi__div" />
        <div className="ph-kpi">
          <div className="ph-kpi__label">
            {shName ? `Được chia · ${shName}` : "Tổng được chia cổ đông"}
          </div>
          <div className="ph-kpi__value ph-kpi__value--mint">{formatCurrency(totals.accrued)}</div>
          <div className="ph-kpi__sub">
            {payRatio !== null ? `${payRatio}% LN đã chốt` : "theo tỷ lệ từng nhà"}
          </div>
        </div>
        <div className="ph-kpi__div" />
        <div className="ph-kpi">
          <div className="ph-kpi__label">Đã ứng / đã chia</div>
          <div className="ph-kpi__value ph-kpi__value--gold">{formatCurrency(totals.paid)}</div>
          <div className="ph-kpi__sub">đã chi qua phiếu</div>
        </div>
        <div className="ph-kpi__div" />
        <div className="ph-kpi">
          <div className="ph-kpi__label">Còn phải trả</div>
          <div className="ph-kpi__value">{formatCurrency(totals.remaining)}</div>
          <div className="ph-kpi__sub ph-kpi__sub--mint">{remainingHolders} cổ đông còn số dư</div>
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
          <Button
            className="ph-btn-primary ml-auto"
            onClick={() => { setDistShareholder(shId === ALL ? null : shId); setDistOpen(true); }}
          >
            ＋ Chi lợi nhuận
          </Button>
        </div>

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

        {/* Theo cổ đông */}
        <div className="ph-grid-2-wide">
          <div className="ph-card">
            <div className="ph-card__head">
              <div className="ph-card__title">Theo cổ đông (luỹ kế)</div>
            </div>
            <div className="ph-tbl__scroll">
              <table className="ph-tbl">
                <thead>
                  <tr>
                    <th>Cổ đông</th>
                    <th className="num">Được chia</th>
                    <th className="num">Đã ứng</th>
                    <th className="num">Còn lại</th>
                    <th style={{ width: 58 }} />
                  </tr>
                </thead>
                <tbody>
                  {shareholders.length === 0 && (
                    <tr><td colSpan={5} style={{ textAlign: "center", color: "var(--ph-ink-4)" }}>Chưa có cổ đông</td></tr>
                  )}
                  {shareholders.map((s) => {
                    const r = summary[s.id] ?? { accrued: 0, paid: 0, remaining: 0 };
                    const active = shId !== ALL && shId === s.id;
                    return (
                      <tr key={s.id} className={active ? "is-current" : undefined}>
                        <td className="name">
                          <button
                            type="button"
                            className="ph-row__link"
                            onClick={() => setShId(active ? ALL : s.id)}
                          >
                            {s.name}
                          </button>
                        </td>
                        <td className="num pos">{formatCurrency(r.accrued)}</td>
                        <td className="num neg">{formatCurrency(r.paid)}</td>
                        <td className={`num strong${r.remaining < 0 ? " bad" : ""}`}>{formatCurrency(r.remaining)}</td>
                        <td className="num">
                          <Button
                            className="ph-mini-btn"
                            onClick={() => { setDistShareholder(s.id); setDistOpen(true); }}
                          >
                            Chi
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                {shareholders.length > 0 && (
                  <tfoot>
                    <tr>
                      <td>Tổng</td>
                      <td className="num pos">{formatCurrency(totals.accrued)}</td>
                      <td className="num neg">{formatCurrency(totals.paid)}</td>
                      <td className="num" style={{ fontWeight: 800 }}>{formatCurrency(totals.remaining)}</td>
                      <td />
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>

          <div className="ph-card ph-card__pad">
            <div className="ph-card__title">Còn lại theo cổ đông</div>
            <HBars data={remainingChart} />
            <div className="ph-hint">Số còn phải trả = được chia luỹ kế − đã ứng/đã chia</div>
          </div>
        </div>

        {/* Lương điều hành (luỹ kế) */}
        {managers.length > 0 && (
          <div className="ph-card">
            <div className="ph-card__head">
              <div className="ph-card__title">Lương điều hành (luỹ kế)</div>
              <div className="ph-card__push">
                <Button
                  className="ph-control ph-control--strong"
                  onClick={() => { setPayoutManager(null); setPayoutOpen(true); }}
                >
                  ＋ Chi lương điều hành
                </Button>
              </div>
            </div>
            <div className="ph-tbl__scroll">
              <table className="ph-tbl">
                <thead>
                  <tr>
                    <th>Quản lý</th>
                    <th className="num">Được nhận</th>
                    <th className="num">Đã trả</th>
                    <th className="num">Còn lại</th>
                    <th style={{ width: 58 }} />
                  </tr>
                </thead>
                <tbody>
                  {managers.map((m) => {
                    const r = managerSummary[m.id] ?? { accrued: 0, paid: 0, remaining: 0 };
                    return (
                      <tr key={m.id}>
                        <td className="name">{m.name}</td>
                        <td className="num exp">{formatCurrency(r.accrued)}</td>
                        <td className="num neg">{formatCurrency(r.paid)}</td>
                        <td className={`num strong${r.remaining < 0 ? " bad" : r.remaining === 0 ? " pos" : ""}`}>
                          {formatCurrency(r.remaining)}
                        </td>
                        <td className="num">
                          <Button
                            className="ph-mini-btn"
                            onClick={() => { setPayoutManager(m.id); setPayoutOpen(true); }}
                          >
                            Chi
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

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
    </>
  );
}
