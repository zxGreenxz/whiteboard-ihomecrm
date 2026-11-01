import { QueryRegion } from "@/components/errors/QueryRegion";
import { LoadingState } from "@/components/loading/LoadingState";
import { formatCurrency } from "@/lib/utils";
import type { ProfitOverviewCoverageData } from "@/hooks/useProfitOverviewCoverage";
import {
  COVERAGE_BASIS_NOTE,
  COVERAGE_OPEN_NOTE,
  coverageCellKey,
  coverageCellTitle,
  coverageSummaryLines,
  type CoverageStatus,
  type ProfitCoverage,
} from "@/lib/profitOverviewCoverage";
import { CARD, fmtShort } from "./profitMobileShared";

// =============================================================================
// Khối "Tình trạng chốt LN Tháng × Toà" của tab Tổng quan (rà 21/10, F18/F20).
// Trình bày kết quả buildProfitCoverage; dữ liệu do useProfitOverviewCoverage nạp.
// Mọi con số ghi rõ CƠ SỞ: dồn tích theo kỳ, chỉ phiếu đã duyệt, chỉ KQKD, trước
// lương điều hành và trước chia; bỏ toà ảo (toà ảo chỉ vào dòng chi phí chung).
// =============================================================================

const OPEN_NOTE = COVERAGE_OPEN_NOTE;

const GLYPH: Record<CoverageStatus, { mark: string; color: string; bg?: string; label: string }> = {
  LOCKED: { mark: "✓", color: "var(--ph-green-6, #047857)", label: "Đã chốt" },
  LOCKED_CHANGED: { mark: "!", color: "var(--ph-amber-d, #b45309)", bg: "#fef3c7", label: "Đã chốt nhưng nguồn đã đổi" },
  OPEN: { mark: "○", color: "var(--ph-red, #dc2626)", label: "Chưa chốt" },
  EMPTY: { mark: "·", color: "var(--ph-ink-4, #8a9992)", label: "Không phát sinh" },
};

interface Props {
  data: ProfitOverviewCoverageData;
  year: number;
  /** null = cả năm */
  monthFilter: number | null;
}

function emptyReason(data: ProfitOverviewCoverageData, year: number): string | null {
  if (!data.organizationSelected) return "Chọn công ty để xem tình trạng chốt theo toà.";
  if (data.months.length === 0) return `Chưa tới kỳ nào của năm ${year} để chốt.`;
  if (!data.hasBuildings) return "Công ty đang chọn chưa có toà nào.";
  return null;
}

export function ProfitCoverageCard({ data, year, monthFilter }: Props) {
  const scope = monthFilter != null ? `T${monthFilter}/${year}` : `năm ${year}`;
  const reason = emptyReason(data, year);
  const c = data.coverage;
  return (
    <div className="ph-card" data-testid="profit-coverage">
      <div className="ph-card__head" style={{ alignItems: "flex-start" }}>
        <div>
          <div className="ph-card__title">Tình trạng chốt LN Tháng × Toà — {scope}</div>
          <div className="ph-card__note">{COVERAGE_BASIS_NOTE}</div>
        </div>
      </div>
      {reason ? (
        <div className="ph-empty">{reason}</div>
      ) : (
        <QueryRegion label="tình trạng chốt theo toà" queries={data.regionQueries} skeleton="table" rows={4}>
          {!c ? (
            <div className="p-3">
              <LoadingState label="tình trạng chốt theo toà" variant="table" rows={4} />
            </div>
          ) : (
            <CoverageDesktopBody c={c} data={data} year={year} singleMonth={monthFilter != null} />
          )}
        </QueryRegion>
      )}
    </div>
  );
}

function CoverageDesktopBody({
  c,
  data,
  year,
  singleMonth,
}: {
  c: ProfitCoverage;
  data: ProfitOverviewCoverageData;
  year: number;
  singleMonth: boolean;
}) {
  const lines = coverageSummaryLines(c, { year, today: data.today, singleMonth }, formatCurrency);
  const nameOf = new Map(c.buildings.map((b) => [b.id, b.name]));
  return (
    <>
      <div className="space-y-1.5 border-b px-[18px] py-3 text-[12.5px]" style={{ background: "#FAFBFA" }}>
        <p className="m-0 font-semibold" style={{ color: c.lockedDelta !== 0 || c.changedCount > 0 ? "var(--ph-amber-d)" : "var(--ph-ink)" }}>
          {lines.reconcile}
        </p>
        {lines.reconcileSub && <p className="m-0 text-[11.5px]" style={{ color: "var(--ph-ink-3)" }}>{lines.reconcileSub}</p>}
        <p className="m-0 font-semibold" style={{ color: "var(--ph-ink)" }}>{lines.open}</p>
        <p className="m-0 text-[11.5px]" style={{ color: "var(--ph-ink-3)" }}>{OPEN_NOTE}</p>
        {lines.virtual && <p className="m-0" style={{ color: "var(--ph-ink-2)" }}>{lines.virtual}</p>}
      </div>
      {c.buildings.length === 0 ? (
        <div className="ph-empty">Không có toà nào phát sinh trong phạm vi đang xem.</div>
      ) : (
        <div className="ph-tbl__scroll">
          <table className="ph-tbl" aria-label="Tình trạng chốt lợi nhuận theo tháng và toà">
            <thead>
              <tr>
                <th style={{ width: 54 }}>Tháng</th>
                {c.buildings.map((b) => (
                  <th key={b.id} style={{ textAlign: "center", whiteSpace: "nowrap" }} title={b.name}>
                    {b.name}
                  </th>
                ))}
                <th className="num">Đã chốt</th>
                <th className="num">LN chưa chốt</th>
              </tr>
            </thead>
            <tbody>
              {c.byMonth.map((m) => (
                <tr key={m.month}>
                  <td className="name">T{m.month}</td>
                  {c.buildings.map((b) => {
                    const cell = c.cells[coverageCellKey(m.month, b.id)];
                    if (!cell) return <td key={b.id} />;
                    const g = GLYPH[cell.status];
                    const title = coverageCellTitle(cell, nameOf.get(b.id) ?? b.name, formatCurrency);
                    return (
                      <td key={b.id} style={{ textAlign: "center", padding: "4px 2px" }}>
                        <span
                          role="img"
                          aria-label={title}
                          title={title}
                          data-status={cell.status}
                          style={{
                            display: "inline-block",
                            minWidth: 18,
                            borderRadius: 4,
                            fontWeight: 800,
                            color: g.color,
                            background: g.bg,
                          }}
                        >
                          {g.mark}
                        </span>
                      </td>
                    );
                  })}
                  <td className="num">
                    {m.locked}/{c.buildings.length}
                    {m.changed > 0 && <span style={{ color: "var(--ph-amber-d)" }}> · {m.changed}!</span>}
                  </td>
                  <td className="num">{m.open > 0 ? formatCurrency(m.openNet) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="ph-legend" style={{ padding: "8px 18px 12px" }}>
        {(Object.keys(GLYPH) as CoverageStatus[]).map((s) => (
          <span key={s} className="ph-legend__item">
            <b style={{ color: GLYPH[s].color, background: GLYPH[s].bg, padding: "0 3px", borderRadius: 3 }}>{GLYPH[s].mark}</b>
            {GLYPH[s].label}
          </span>
        ))}
        <span className="ph-legend__item">Rê chuột vào ô để xem số</span>
      </div>
    </>
  );
}

/** Bản mobile: không vẽ ma trận rộng — mỗi tháng một dòng đếm + LN chưa chốt. */
export function ProfitCoverageMobile({ data, year, monthFilter }: Props) {
  const scope = monthFilter != null ? `T${monthFilter}/${year}` : `năm ${year}`;
  const reason = emptyReason(data, year);
  const c = data.coverage;
  return (
    <div className={`${CARD} px-3 py-3`} data-testid="profit-coverage-mobile">
      <div className="flex items-baseline gap-1.5">
        <span className="text-[12.5px] font-extrabold tracking-[-0.1px] text-[#1b1813]">Tình trạng chốt theo toà</span>
        <span className="text-[10.5px] font-semibold text-[#8d8678]">{scope}</span>
      </div>
      {reason ? (
        <p className="mt-2 mb-0 text-[12px] font-semibold text-[#8d8678]">{reason}</p>
      ) : (
        <QueryRegion label="tình trạng chốt theo toà" queries={data.regionQueries} skeleton="cards" rows={2}>
          {!c ? (
            <LoadingState label="tình trạng chốt theo toà" variant="lines" rows={3} />
          ) : (
            <CoverageMobileBody c={c} data={data} year={year} singleMonth={monthFilter != null} />
          )}
        </QueryRegion>
      )}
    </div>
  );
}

function CoverageMobileBody({
  c,
  data,
  year,
  singleMonth,
}: {
  c: ProfitCoverage;
  data: ProfitOverviewCoverageData;
  year: number;
  singleMonth: boolean;
}) {
  const lines = coverageSummaryLines(c, { year, today: data.today, singleMonth }, fmtShort);
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <p className={`m-0 text-[11.5px] font-bold ${c.lockedDelta !== 0 || c.changedCount > 0 ? "text-[#a35a0c]" : "text-[#1b1813]"}`}>
        {lines.reconcile}
      </p>
      {lines.reconcileSub && <p className="m-0 text-[10.5px] font-semibold text-[#8d8678]">{lines.reconcileSub}</p>}
      <p className="m-0 text-[11.5px] font-bold text-[#1b1813]">{lines.open}</p>
      <p className="m-0 text-[10.5px] font-semibold text-[#8d8678]">{OPEN_NOTE}</p>
      {lines.virtual && <p className="m-0 text-[11px] font-semibold text-[#514c42]">{lines.virtual}</p>}
      <p className="m-0 text-[10px] font-semibold text-[#b6b0a3]">{COVERAGE_BASIS_NOTE}</p>
      <div className="mt-1 flex flex-col divide-y divide-[#f4f1ea] rounded-[9px] border border-[#efece4]">
        {c.byMonth.map((m) => (
          <div key={m.month} className="flex items-center gap-2 px-2.5 py-1.5 text-[11.5px]">
            <span className="w-8 font-mono font-bold text-[#514c42]">T{m.month}</span>
            <span className="font-bold text-[#0e7a47]" aria-label={`${m.locked} toà đã chốt`}>✓{m.locked}</span>
            {m.changed > 0 && (
              <span className="font-bold text-[#a35a0c]" aria-label={`${m.changed} toà chốt nhưng nguồn đã đổi`}>!{m.changed}</span>
            )}
            <span className="font-bold text-[#d6453f]" aria-label={`${m.open} toà chưa chốt`}>○{m.open}</span>
            <span className="ml-auto font-mono font-bold text-[#1b1813]">
              {m.open > 0 ? `≈${fmtShort(m.openNet)}` : "—"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
