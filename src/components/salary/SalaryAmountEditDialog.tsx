// Hộp "Sửa số tiền" một khoản lương — chỉ super admin / chủ công ty (server chặn
// thêm lần nữa). Ghi qua salary_line_override_set_v1: số mới thay số máy tính cho
// đúng (người, kỳ, khoản); bỏ sửa tay = ghi dòng amount NULL. Lịch sử giữ ở server.
import { useState } from "react";
import type { SalAppliedOverride, SalManager } from "@/lib/managerSalary";
import { newSalaryRequestKey, useSetLineOverride } from "@/hooks/useSalaryExtras";
import { Modal } from "./salaryCommon";
import { Pencil, X } from "lucide-react";
import { salFmt } from "./salaryFormat";
import { MONO, MUTED } from "./salaryFundUi";

export interface EditableLine {
  key: string;
  label: string;
  /** Số máy tính (trước khi sửa tay). */
  computed: number;
  /** Số đang áp (đã gồm ghi đè nếu có). */
  current: number;
  ovr: SalAppliedOverride | null;
}

const parseSigned = (s: string, allowNegative: boolean): number | null => {
  const t = (s || "").trim();
  if (!t) return null;
  const neg = allowNegative && t.startsWith("-");
  const digits = t.replace(/\D/g, "");
  if (!digits) return null;
  const n = parseInt(digits, 10);
  return neg ? -n : n;
};

export default function SalaryAmountEditDialog({ m, line, periodMonth, onClose }: {
  m: SalManager; line: EditableLine; periodMonth: string; onClose: () => void;
}) {
  const save = useSetLineOverride();
  // Phân bổ lợi nhuận có thể âm (toà lỗ); khoản khác là tiền trả nên không âm.
  const allowNegative = line.key.startsWith("dh:");
  const [amt, setAmt] = useState(String(line.current));
  const [reason, setReason] = useState("");
  const [keySet] = useState(() => newSalaryRequestKey("sal-ovr"));
  const [keyClear] = useState(() => newSalaryRequestKey("sal-ovr"));
  const val = parseSigned(amt, allowNegative);
  const diff = val == null ? 0 : val - line.computed;
  const ok = val != null && reason.trim().length > 0 && !save.isPending && val !== line.current;
  const crossBook = line.key.startsWith("sale:") || line.key.startsWith("dh:");

  const submit = (amount: number | null, requestKey: string) =>
    save.mutate(
      { staffId: m.id, periodMonth, lineKey: line.key, lineLabel: line.label, computed: line.computed, amount, reason: reason.trim(), requestKey },
      { onSuccess: onClose },
    );

  return (
    <Modal onClose={onClose}>
      <div className="sal-modal-head">
        <span className="mic" style={{ background: "hsl(var(--status-info-bg))", color: "hsl(var(--status-info-fg))" }}><Pencil size={18} /></span>
        <div><h3>Sửa số tiền</h3><p>{m.name} · {line.label}</p></div>
        <button className="x" onClick={onClose} aria-label="Đóng"><X size={18} /></button>
      </div>
      <div className="sal-modal-body">
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
          <span style={{ color: MUTED }}>Số máy tính</span><b style={MONO}>{salFmt(line.computed)}</b>
        </div>
        {line.ovr && (
          <div style={{ fontSize: 12, background: "hsl(var(--muted) / .5)", border: "1px solid hsl(var(--border))", borderRadius: 8, padding: "8px 10px" }}>
            Đang áp <b style={MONO}>{salFmt(line.ovr.amount)}</b> · {line.ovr.reason}
            <div style={{ color: MUTED }}>Sửa bởi {line.ovr.byName || "—"} · {new Date(line.ovr.at).toLocaleString("vi-VN")}</div>
          </div>
        )}
        <div className="sal-field"><label htmlFor="sal-ovr-amount">Số tiền mới</label>
          <input id="sal-ovr-amount" className="sal-input mono" inputMode={allowNegative ? "text" : "numeric"} autoFocus
            value={val == null ? amt : (val < 0 ? "-" : "") + Math.abs(val).toLocaleString("vi-VN")}
            onChange={(e) => setAmt(e.target.value)} placeholder="0" /></div>
        {val != null && diff !== 0 && (
          <div style={{ fontSize: 12, color: diff > 0 ? "hsl(var(--status-danger-fg))" : "hsl(var(--status-success-fg))" }}>
            {diff > 0 ? "Tăng " : "Giảm "}{salFmt(Math.abs(diff))} so với số máy tính
          </div>
        )}
        <div className="sal-field"><label htmlFor="sal-ovr-reason">Lý do (bắt buộc)</label>
          <textarea id="sal-ovr-reason" className="sal-input" value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="VD: Nghỉ không phép 2 ngày theo biên bản ngày…" /></div>
        <div style={{ fontSize: 11.5, color: MUTED }}>
          Số mới dùng cho thực nhận, chốt kỳ và phiếu chi của kỳ này. Kỳ đã chốt không sửa được.
          {crossBook && <> <b style={{ color: "hsl(var(--status-warning-fg))" }}>Số trả qua lương sẽ khác số ghi ở {line.key.startsWith("sale:") ? "phiếu Sale nguồn (chi phí toà giữ nguyên)" : "lợi nhuận toà đã chốt"}.</b></>}
        </div>
      </div>
      <div className="sal-modal-foot">
        {line.ovr && (
          <button className="sal-btn sal-btn--ghost" style={{ marginRight: "auto", color: "hsl(var(--status-danger-fg))" }}
            disabled={!reason.trim() || save.isPending} title={!reason.trim() ? "Ghi lý do trước khi bỏ sửa tay" : undefined}
            onClick={() => submit(null, keyClear)}>Bỏ sửa tay</button>
        )}
        <button className="sal-btn sal-btn--ghost" onClick={onClose}>Huỷ</button>
        <button className="sal-btn sal-btn--primary" disabled={!ok} onClick={() => val != null && submit(val, keySet)}>
          {save.isPending ? "Đang lưu…" : "Lưu số mới"}
        </button>
      </div>
    </Modal>
  );
}
