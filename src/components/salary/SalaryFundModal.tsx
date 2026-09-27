// Modal "Nguồn lương & khoản định kỳ" — mở từ ô "Nguồn lương tháng" (bản Claude
// Design 26/09/2026).
// - Nguồn lương: phí Quản lý đã công bố giá theo tòa (dữ liệu thật). Nguồn chủ cấp
//   thêm chưa có mô hình dữ liệu → trạng thái trống, không bịa số.
// - Khoản định kỳ: chưa có bảng lưu quy tắc/phiên bản. Hiện các khoản đang nhập tay
//   trong kỳ (dữ liệu thật) và khung sửa để xem trước tác động; nút lưu bị khoá.
import { useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { isSupplementaryLabel } from "@/lib/salaryFundReport";
import { shiftPeriodMonth } from "@/lib/salaryPeriod";
import type { SalManager } from "@/lib/managerSalary";
import type { FeeFundRow } from "@/hooks/useSalaryFund";
import { salFmt } from "./salaryFormat";
import { MONO, MUTED, Seg, StChip, monthShort } from "./salaryFundUi";

interface Props {
  tab: "funding" | "rules";
  onTab: (t: "funding" | "rules") => void;
  onClose: () => void;
  periodMonth: string;
  locked: boolean;
  fee: { rows: FeeFundRow[]; total: number; unpublished: number; isLoading: boolean; error: Error | null };
  managers: SalManager[];
}

const card: CSSProperties = { background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 12, boxShadow: "var(--shadow-sm)" };

export default function SalaryFundModal({ tab, onTab, onClose, periodMonth, locked, fee, managers }: Props) {
  return <>
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(14,20,30,.42)" }} />
    <div role="dialog" aria-label="Nguồn lương & khoản định kỳ"
      style={{ position: "fixed", zIndex: 51, top: "4vh", left: "50%", transform: "translateX(-50%)", width: "min(1180px,94vw)", maxHeight: "92vh", background: "hsl(var(--background))", borderRadius: 14, boxShadow: "var(--shadow-xl)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "16px 20px", background: "hsl(var(--card))", borderBottom: "1px solid hsl(var(--border))", flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Nguồn lương &amp; khoản định kỳ</h3>
        <Seg value={tab} onChange={onTab} options={[{ key: "funding", label: "Nguồn lương" }, { key: "rules", label: "Khoản định kỳ" }]} />
        <button onClick={onClose} aria-label="Đóng" className="sal-btn sal-btn--ghost sal-btn--icon sal-btn--sm" style={{ marginLeft: "auto" }}>✕</button>
      </div>
      <div style={{ overflow: "auto", padding: 20 }}>
        {tab === "funding" ? <Funding fee={fee} periodMonth={periodMonth} /> : <Rules managers={managers} periodMonth={periodMonth} locked={locked} />}
      </div>
    </div>
  </>;
}

function Funding({ fee, periodMonth }: { fee: Props["fee"]; periodMonth: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ ...card, padding: "16px 20px", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 12.5, color: MUTED, fontWeight: 600 }}>Nguồn lương mỗi tháng · {monthShort(periodMonth)}/{periodMonth.slice(0, 4)}</div>
          <div style={{ ...MONO, fontWeight: 800, fontSize: 24, color: "hsl(var(--primary))" }}>{salFmt(fee.total)}</div>
          <div style={{ fontSize: 12, color: MUTED }}>Phí quản lý {fee.rows.length} tòa · chi ngày 1 hàng tháng</div>
        </div>
        <Link to="/settings/finance/fixed-fees" className="sal-btn sal-btn--outline" style={{ color: "hsl(var(--primary))", textDecoration: "none" }}>+ Thêm nguồn / công bố giá</Link>
      </div>

      <div style={card}>
        <div style={{ padding: "14px 20px", borderBottom: "1px solid hsl(var(--border))" }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>Phí quản lý từ tòa</h3>
          <p style={{ margin: 0, fontSize: 11.5, color: MUTED }}>Giá công bố của hạng mục Quản lý trong phí cố định từng tòa, áp cho tháng đang xem.</p>
        </div>
        {fee.isLoading && <div style={{ padding: 20, fontSize: 12.5, color: MUTED }}>Đang tải…</div>}
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
          <span style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: ".05em", color: MUTED }}>Cộng</span><span style={MONO}>{salFmt(fee.total)}</span>
        </div>
      </div>

      <div style={card}>
        <div style={{ padding: "14px 20px", borderBottom: "1px solid hsl(var(--border))", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>Chủ công ty cấp thêm</h3>
          <StChip tone="tasks">Hạn chế quyền xem</StChip>
          <p style={{ margin: 0, fontSize: 11.5, color: MUTED, flexBasis: "100%" }}>Dùng để trả lương QL bổ sung. Không ghi vào báo cáo thu chi của tòa.</p>
        </div>
        <div style={{ padding: 20, textAlign: "center", fontSize: 12.5, color: MUTED }}>
          Chưa có dữ liệu nguồn chủ cấp. Hệ thống chưa có nơi lưu khoản này — cần bổ sung mô hình dữ liệu trước khi nhập.
        </div>
      </div>
    </div>
  );
}

type Kind = "change" | "once" | "stop";

function Rules({ managers, periodMonth, locked }: { managers: SalManager[]; periodMonth: string; locked: boolean }) {
  const rows = managers.flatMap((m) => m.adjustments.filter((a) => a.amount > 0).map((a) => {
    const sup = isSupplementaryLabel(a.label);
    return { id: m.id + ":" + (a.id || a.label), who: m.name, name: a.label, amount: a.amount, type: sup ? "Lương QL bổ sung" : "Phụ cấp / thưởng", src: sup ? "Chủ cấp bổ sung" : "Quỹ lương vận hành" };
  }));
  const [selId, setSelId] = useState<string | null>(rows[0]?.id ?? null);
  const [kind, setKind] = useState<Kind>("change");
  const froms = [0, 1, 2].map((k) => shiftPeriodMonth(periodMonth, k));
  const [from, setFrom] = useState(froms[locked ? 1 : 0]);
  const [amt, setAmt] = useState("");
  const [reason, setReason] = useState("");
  const cur = rows.find((r) => r.id === selId) || null;
  const newAmt = parseInt(amt.replace(/\D/g, ""), 10) || 0;
  const fi = froms.indexOf(from);
  const eff = (idx: number) => {
    if (!cur) return { v: "—", fg: MUTED };
    if (idx < fi) return { v: "Giữ " + salFmt(cur.amount), fg: "hsl(var(--status-neutral-fg))" };
    if (kind === "stop") return { v: "Không phát sinh", fg: "hsl(var(--status-danger-fg))" };
    if (kind === "once" && idx > fi) return { v: "Trở lại " + salFmt(cur.amount), fg: "hsl(var(--status-neutral-fg))" };
    return { v: newAmt ? "Áp " + salFmt(newAmt) : "Áp mức mới", fg: "hsl(var(--primary))" };
  };
  const prevMonth = shiftPeriodMonth(periodMonth, -1);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div style={{ fontSize: 12.5, color: "hsl(var(--status-warning-fg))", background: "hsl(var(--status-warning-bg))", borderRadius: 8, padding: "10px 14px" }}>
        <b>Bản xem trước.</b> Hệ thống chưa có bảng lưu khoản định kỳ và lịch sử phiên bản, nên chưa lưu được. Danh sách dưới là các khoản đang nhập tay trong Thưởng của kỳ {monthShort(periodMonth)} — ứng viên chuyển thành khoản định kỳ.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,360px),1fr))", gap: 18, alignItems: "start" }}>
        <div style={{ ...card, gridColumn: "span 2", minWidth: 0 }}>
          <div style={{ padding: "16px 20px", borderBottom: "1px solid hsl(var(--border))" }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Phụ cấp &amp; lương bổ sung đang nhập tay</h3>
            <p style={{ margin: 0, fontSize: 11.5, color: MUTED }}>Khi thành khoản định kỳ: tính lại một kỳ nhiều lần vẫn chỉ phát sinh một lần cho cùng quy tắc · người · kỳ.</p>
          </div>
          <div style={{ overflowX: "auto" }}><div style={{ minWidth: 640 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1.7fr 1fr 110px 1.3fr", gap: "0 12px", padding: "10px 20px", background: "hsl(var(--muted) / .5)", borderBottom: "1px solid hsl(var(--border))", fontSize: 10.5, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", color: MUTED }}>
              <span>Người · khoản</span><span>Loại</span><span style={{ textAlign: "right" }}>Mức</span><span>Nguồn chịu tiền</span>
            </div>
            {rows.length === 0 && <div style={{ padding: 20, fontSize: 12.5, color: MUTED }}>Kỳ này không có khoản thưởng nhập tay.</div>}
            {rows.map((r) => {
              const a = r.id === selId;
              return (
                <button key={r.id} onClick={() => { setSelId(r.id); setAmt(""); setReason(""); }}
                  style={{ display: "grid", gridTemplateColumns: "1.7fr 1fr 110px 1.3fr", gap: "0 12px", alignItems: "center", width: "100%", textAlign: "left", border: 0, borderBottom: "1px solid hsl(var(--border) / .6)", background: a ? "hsl(var(--primary) / .08)" : "hsl(var(--card))", boxShadow: a ? "inset 3px 0 0 hsl(var(--primary))" : "none", padding: "11px 20px", cursor: "pointer" }}>
                  <span><b style={{ fontSize: 13 }}>{r.name}</b><br /><span style={{ fontSize: 11.5, color: MUTED }}>{r.who} · nhập tay kỳ {monthShort(periodMonth)}</span></span>
                  <span style={{ fontSize: 12 }}>{r.type}</span>
                  <span style={{ ...MONO, textAlign: "right", fontWeight: 600 }}>{salFmt(r.amount)}</span>
                  <span style={{ fontSize: 12, color: "hsl(var(--status-neutral-fg))" }}>{r.src}</span>
                </button>
              );
            })}
          </div></div>
        </div>

        <div style={{ ...card, boxShadow: "var(--shadow-md)", minWidth: 0 }}>
          <div style={{ padding: "14px 16px", borderBottom: "1px solid hsl(var(--border))" }}>
            <b style={{ fontSize: 14 }}>{cur ? cur.name : "Chọn một khoản"}</b>
            {cur && <div style={{ fontSize: 11.5, color: MUTED }}>{cur.who} · hiện {salFmt(cur.amount)}</div>}
          </div>
          <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12, opacity: cur ? 1 : .5, pointerEvents: cur ? "auto" : "none" }}>
            <div className="sal-field"><label>Loại thay đổi</label>
              <Seg<Kind> small value={kind} onChange={setKind} options={[{ key: "change", label: "Sửa mức từ kỳ" }, { key: "once", label: "Chỉ một kỳ" }, { key: "stop", label: "Ngừng từ kỳ" }]} /></div>
            {kind !== "stop" && <div className="sal-field"><label>Mức mới</label>
              <input className="sal-input mono" value={newAmt ? newAmt.toLocaleString("vi-VN") : amt} onChange={(e) => setAmt(e.target.value)} inputMode="numeric" placeholder="VD: 700.000" /></div>}
            <div className="sal-field"><label>{kind === "once" ? "Kỳ được điều chỉnh" : "Áp dụng từ kỳ"}</label>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {froms.map((f, i) => {
                  const a = f === from;
                  const dis = i === 0 && locked;
                  return <button key={f} disabled={dis} onClick={() => setFrom(f)} className="sal-btn sal-btn--sm"
                    style={{ border: `1px solid ${a ? "hsl(var(--primary))" : "hsl(var(--border))"}`, background: a ? "hsl(var(--primary) / .08)" : "hsl(var(--card))", color: a ? "hsl(var(--primary))" : "hsl(var(--foreground))" }}>
                    {monthShort(f)}/{f.slice(0, 4)}{i === 0 ? (locked ? " · đã chốt" : " · đang mở") : ""}</button>;
                })}
              </div></div>
            <div className="sal-field"><label>Tác động</label>
              {[{ k: `${monthShort(prevMonth)}/${prevMonth.slice(0, 4)} · kỳ trước`, v: "Không đổi · dùng số đã chốt", fg: "hsl(var(--status-neutral-fg))", bg: "hsl(var(--muted) / .5)" },
                ...froms.map((f, i) => ({ k: `${monthShort(f)}/${f.slice(0, 4)}${i === 2 ? " trở đi" : ""}`, ...eff(i), bg: "hsl(var(--card))" }))].map((x) => (
                <div key={x.k} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12, padding: "7px 10px", borderRadius: 6, background: x.bg }}>
                  <span style={{ fontWeight: 600 }}>{x.k}</span><span style={{ color: x.fg, textAlign: "right" }}>{x.v}</span>
                </div>
              ))}</div>
            <div className="sal-field"><label>Lý do (bắt buộc)</label>
              <textarea className="sal-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="VD: Nhận thêm phụ trách tòa mới theo thỏa thuận ngày…" /></div>
            <button className="sal-btn sal-btn--primary" style={{ justifyContent: "center" }} disabled title="Chưa có bảng lưu khoản định kỳ">Lưu phiên bản mới · chưa hỗ trợ</button>
            <div style={{ fontSize: 11.5, color: MUTED, background: "hsl(var(--muted) / .5)", borderRadius: 8, padding: "9px 12px" }}>
              <b style={{ color: "hsl(var(--foreground))" }}>Chưa chốt:</b> bắt đầu/ngừng giữa tháng tính trọn hay theo ngày (OPEN-06). Mặc định hiển thị “trọn kỳ” và ghi rõ là giả định. Kỳ đã chốt không bao giờ tính lại.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
