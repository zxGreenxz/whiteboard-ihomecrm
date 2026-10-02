// Modal "Nguồn lương & khoản định kỳ" — mở từ ô "Nguồn lương tháng" (bản Claude
// Design 26/09/2026).
// - Nguồn lương = phí Quản lý đã công bố giá theo tòa + "Chủ công ty cấp thêm" (khoản
//   định kỳ loại Lương QL bổ sung gắn toà — nhà không thuê-cho-thuê-lại như 481NVK,
//   950NK, 44TL). Một khoản vừa là dòng lương người nhận vừa là dòng nguồn (chủ chốt
//   27/09/2026: ghi một lần), không ghi vào thu chi của toà.
// - Khoản định kỳ: SalaryRecurringRules (quy tắc + phiên bản, lưu thật).
import { useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { ownerSupplementByBuilding, type RecurringItem } from "@/lib/salaryRecurring";
import type { SalManager } from "@/lib/managerSalary";
import type { FeeFundRow } from "@/hooks/useSalaryFund";
import { salFmt } from "./salaryFormat";
import { LoadingState, SkeletonBar } from "@/components/loading/LoadingState";
import { MONO, MUTED, Seg, StChip, monthShort } from "./salaryFundUi";
import SalaryRecurringRules, { type AddPreset } from "./SalaryRecurringRules";

interface Props {
  tab: "funding" | "rules";
  onTab: (t: "funding" | "rules") => void;
  onClose: () => void;
  periodMonth: string;
  locked: boolean;
  fee: { rows: FeeFundRow[]; total: number; unpublished: number; isLoading: boolean; error: Error | null };
  managers: SalManager[];
  recurring: RecurringItem[];
  /** false = máy chủ chưa có RPC khoản định kỳ (migration chưa áp). */
  extrasAvailable: boolean;
  /** Super admin / chủ công ty (salary_can_edit_amounts_v1). */
  canEdit: boolean;
}

const card: CSSProperties = { background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 12, boxShadow: "var(--shadow-sm)" };

export default function SalaryFundModal({ tab, onTab, onClose, periodMonth, fee, managers, recurring, extrasAvailable, canEdit }: Props) {
  const [addPreset, setAddPreset] = useState<AddPreset | null>(null);
  const openAddSupplement = () => { setAddPreset({ category: "SUPPLEMENTARY" }); onTab("rules"); };
  return <>
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(14,20,30,.42)" }} />
    <div role="dialog" aria-label="Nguồn lương & khoản định kỳ"
      style={{ position: "fixed", zIndex: 51, top: "4vh", left: "50%", transform: "translateX(-50%)", width: "min(1180px,94vw)", maxHeight: "92vh", background: "hsl(var(--background))", borderRadius: 14, boxShadow: "var(--shadow-xl)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "16px 20px", background: "hsl(var(--card))", borderBottom: "1px solid hsl(var(--border))", flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Nguồn lương &amp; khoản định kỳ</h3>
        <Seg value={tab} onChange={(t) => { if (t === "funding") setAddPreset(null); onTab(t); }} options={[{ key: "funding", label: "Nguồn lương" }, { key: "rules", label: "Khoản định kỳ" }]} />
        <button onClick={onClose} aria-label="Đóng" className="sal-btn sal-btn--ghost sal-btn--icon sal-btn--sm" style={{ marginLeft: "auto" }}>✕</button>
      </div>
      <div style={{ overflow: "auto", padding: 20 }}>
        {tab === "funding"
          ? <Funding fee={fee} periodMonth={periodMonth} recurring={recurring} available={extrasAvailable} canEdit={canEdit} onAddSupplement={openAddSupplement} />
          : <SalaryRecurringRules key={addPreset ? "add" : "list"} managers={managers} recurring={recurring} periodMonth={periodMonth}
              canEdit={canEdit} available={extrasAvailable} initialAdd={addPreset} />}
      </div>
    </div>
  </>;
}

function Funding({ fee, periodMonth, recurring, available, canEdit, onAddSupplement }: {
  fee: Props["fee"]; periodMonth: string; recurring: RecurringItem[]; available: boolean; canEdit: boolean; onAddSupplement: () => void;
}) {
  const owner = ownerSupplementByBuilding(recurring);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ ...card, padding: "16px 20px", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 12.5, color: MUTED, fontWeight: 600 }}>Nguồn lương mỗi tháng · {monthShort(periodMonth)}/{periodMonth.slice(0, 4)}</div>
          {/* Giá phí chưa về: vạch xám thay cho số 0 (chủ chốt 02/10/2026). */}
          {fee.isLoading ? <>
            <SkeletonBar className="my-1.5 h-6" style={{ width: "10rem" }} />
            <SkeletonBar className="h-3" style={{ width: "16rem", maxWidth: "100%" }} />
          </> : <>
            <div style={{ ...MONO, fontWeight: 800, fontSize: 24, color: "hsl(var(--primary))" }}>{salFmt(fee.total + owner.total)}</div>
            <div style={{ fontSize: 12, color: MUTED }}>Phí quản lý {fee.rows.length} tòa {salFmt(fee.total)}{owner.rows.length ? ` · chủ cấp thêm ${owner.rows.length} tòa ${salFmt(owner.total)}` : ""}</div>
          </>}
        </div>
        <Link to="/settings/finance/fixed-fees" className="sal-btn sal-btn--outline" style={{ color: "hsl(var(--primary))", textDecoration: "none" }}>+ Công bố giá phí Quản lý</Link>
      </div>

      <div style={card}>
        <div style={{ padding: "14px 20px", borderBottom: "1px solid hsl(var(--border))" }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>Phí quản lý từ tòa</h3>
          <p style={{ margin: 0, fontSize: 11.5, color: MUTED }}>Giá công bố của hạng mục Quản lý trong phí cố định từng tòa, áp cho tháng đang xem.</p>
        </div>
        {fee.isLoading && <LoadingState label="giá phí quản lý" variant="table" rows={3} className="px-5 py-3" />}
        {fee.error && <div style={{ padding: 20, fontSize: 12.5, color: "hsl(var(--status-danger-fg))" }}>Không tải được giá phí: {fee.error.message}</div>}
        {!fee.isLoading && !fee.error && fee.rows.length === 0 && <div style={{ padding: 20, fontSize: 12.5, color: MUTED }}>Chưa tòa nào công bố giá phí Quản lý cho tháng này.</div>}
        {fee.rows.map((r) => (
          <div key={r.buildingId} style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 20px", borderBottom: "1px solid hsl(var(--border) / .6)", flexWrap: "wrap" }}>
            <span style={{ flex: "0 0 180px" }}><b style={{ fontSize: 13 }}>{r.buildingName}</b></span>
            <span style={{ flex: 1, minWidth: 180, fontSize: 12, color: "hsl(var(--status-neutral-fg))" }}>Hạng mục Quản lý trong phí cố định{r.effectiveFrom ? ` · áp dụng từ ${r.effectiveFrom.slice(5, 7)}/${r.effectiveFrom.slice(0, 4)}` : ""}</span>
            <span style={{ ...MONO, fontWeight: 700, minWidth: 110, textAlign: "right" }}>{salFmt(r.amount)}</span>
          </div>
        ))}
        {fee.unpublished > 0 && <div style={{ padding: "10px 20px", fontSize: 12, color: "hsl(var(--status-warning-fg))", background: "hsl(var(--status-warning-bg))" }}>{fee.unpublished} tòa có hạng mục Quản lý nhưng chưa công bố giá — không cộng vào nguồn lương.</div>}
        <div style={{ display: "flex", justifyContent: "space-between", padding: "12px 20px", background: "hsl(var(--muted) / .6)", fontWeight: 700, borderRadius: "0 0 12px 12px" }}>
          <span style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: ".05em", color: MUTED }}>Cộng</span>{fee.isLoading ? <SkeletonBar style={{ width: "6rem" }} /> : <span style={MONO}>{salFmt(fee.total)}</span>}
        </div>
      </div>

      <div style={card}>
        <div style={{ padding: "14px 20px", borderBottom: "1px solid hsl(var(--border))", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>Chủ công ty cấp thêm</h3>
          <StChip tone="tasks">Hạn chế quyền xem</StChip>
          {canEdit && available && <button className="sal-btn sal-btn--outline sal-btn--sm" style={{ marginLeft: "auto" }} onClick={onAddSupplement}>+ Thêm lương QL bổ sung</button>}
          <p style={{ margin: 0, fontSize: 11.5, color: MUTED, flexBasis: "100%" }}>Trả lương QL bổ sung cho nhà không thuê-cho-thuê-lại (không có phí Quản lý — vd 481NVK, 950NK, 44TL). Nhập một lần ở Khoản định kỳ; không ghi vào báo cáo thu chi của tòa.</p>
        </div>
        {!available ? (
          <div style={{ padding: 20, fontSize: 12.5, color: MUTED, textAlign: "center" }}>Máy chủ chưa bật khoản định kỳ (chờ áp migration) — chưa lưu được nguồn chủ cấp.</div>
        ) : !canEdit ? (
          <div style={{ padding: 20, fontSize: 12.5, color: MUTED, textAlign: "center" }}>Chỉ chủ công ty / quản trị hệ thống xem chi tiết. Tổng kỳ này: <b style={MONO}>{salFmt(owner.total)}</b></div>
        ) : owner.rows.length === 0 ? (
          <div style={{ padding: 20, fontSize: 12.5, color: MUTED, textAlign: "center" }}>Kỳ này chưa có khoản chủ cấp thêm.</div>
        ) : (
          <>
            {owner.rows.map((r) => (
              <div key={r.buildingId} style={{ display: "flex", alignItems: "flex-start", gap: 14, padding: "12px 20px", borderBottom: "1px solid hsl(var(--border) / .6)", flexWrap: "wrap" }}>
                <span style={{ flex: "0 0 180px" }}><b style={{ fontSize: 13 }}>{r.buildingName}</b></span>
                <span style={{ flex: 1, minWidth: 180, fontSize: 12, color: "hsl(var(--status-neutral-fg))" }}>
                  {r.people.map((p, i) => <div key={i}>{p.name} · {p.label} · {salFmt(p.amount)}</div>)}
                </span>
                <span style={{ ...MONO, fontWeight: 700, minWidth: 110, textAlign: "right" }}>{salFmt(r.amount)}</span>
              </div>
            ))}
            <div style={{ display: "flex", justifyContent: "space-between", padding: "12px 20px", background: "hsl(var(--muted) / .6)", fontWeight: 700, borderRadius: "0 0 12px 12px" }}>
              <span style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: ".05em", color: MUTED }}>Cộng</span><span style={MONO}>{salFmt(owner.total)}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
