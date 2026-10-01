import {parseSalaryAmount,formatSalaryAmountInput,typedSalaryAmount} from '@/lib/salaryAmountInput';
import { useSalaryFormFeedback } from "./useSalaryFormFeedback";
import { SALARY_SETTINGS_RULES } from "@/lib/salarySettingsFeedback";
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

export default function SalaryAmountEditDialog({ m, line, periodMonth, onClose }: {
  m: SalManager; line: EditableLine; periodMonth: string; onClose: () => void;
}) {
  const feedback=useSalaryFormFeedback("lưu số tiền khoản lương",{rules:SALARY_SETTINGS_RULES});
  const save = useSetLineOverride();
  // Phân bổ lợi nhuận có thể âm (toà lỗ); khoản khác là tiền trả nên không âm.
  const allowNegative = line.key.startsWith("dh:");
  const [amt, setAmt] = useState(String(line.current));
  const [reason, setReason] = useState("");
  const [keySet] = useState(() => newSalaryRequestKey("sal-ovr"));
  const [keyClear] = useState(() => newSalaryRequestKey("sal-ovr"));
  const parsedAmount=parseSalaryAmount(amt,{allowNegative});
  const val=parsedAmount.value;
  const diff = val == null ? 0 : val - line.computed;
  const crossBook = line.key.startsWith("sale:") || line.key.startsWith("dh:");

  const submit = (amount: number | null, requestKey: string, clearing=false) => {
    void feedback.run(()=>save.mutateAsync(
      { staffId:m.id,periodMonth,lineKey:line.key,lineLabel:line.label,computed:line.computed,amount,reason:reason.trim(),requestKey }),onClose,{
       amount:clearing?undefined:parsedAmount.error??(amount===line.current?'Số tiền chưa thay đổi. Kiểm tra lại khoản đang áp dụng.':undefined),
       reason:reason.trim()?undefined:'Nhập lý do thay đổi số tiền.'
      });
  };

  return (
    <Modal onClose={onClose}>
      <div className="sal-modal-head">
        <span className="mic" style={{ background: "hsl(var(--status-info-bg))", color: "hsl(var(--status-info-fg))" }}><Pencil size={18} /></span>
        <div><h3>Sửa số tiền</h3><p>{m.name} · {line.label}</p></div>
        <button className="x" onClick={onClose} aria-label="Đóng"><X size={18} /></button>
      </div>
      <div ref={feedback.root} className="sal-modal-body">
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
          <input {...feedback.field("amount")} id="sal-ovr-amount" className="sal-input mono" inputMode={allowNegative ? "text" : "numeric"} autoFocus
            value={formatSalaryAmountInput(amt,{allowNegative})}
            onChange={(e) => setAmt(typedSalaryAmount(amt, e, {allowNegative}))} placeholder="0" />{feedback.issue("amount")}</div>
        {val != null && diff !== 0 && (
          <div style={{ fontSize: 12, color: diff > 0 ? "hsl(var(--status-danger-fg))" : "hsl(var(--status-success-fg))" }}>
            {diff > 0 ? "Tăng " : "Giảm "}{salFmt(Math.abs(diff))} so với số máy tính
          </div>
        )}
        <div className="sal-field"><label htmlFor="sal-ovr-reason">Lý do (bắt buộc)</label>
          <textarea {...feedback.field("reason")} id="sal-ovr-reason" className="sal-input" value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="VD: Nghỉ không phép 2 ngày theo biên bản ngày…" />{feedback.issue("reason")}</div>
        <div style={{ fontSize: 11.5, color: MUTED }}>
          Số mới dùng cho thực nhận, chốt kỳ và phiếu chi của kỳ này. Kỳ đã chốt không sửa được.
          {crossBook && <> <b style={{ color: "hsl(var(--status-warning-fg))" }}>Số trả qua lương sẽ khác số ghi ở {line.key.startsWith("sale:") ? "phiếu Sale nguồn (chi phí toà giữ nguyên)" : "lợi nhuận toà đã chốt"}.</b></>}
        </div>
      </div>
      {feedback.notice}
      <div className="sal-modal-foot">
        {line.ovr && (
          <button className="sal-btn sal-btn--ghost" style={{ marginRight: "auto", color: "hsl(var(--status-danger-fg))" }}
            disabled={feedback.saving || feedback.blocked} title={!reason.trim() ? "Ghi lý do trước khi bỏ sửa tay" : undefined}
            onClick={() => submit(null, keyClear,true)}>Bỏ sửa tay</button>
        )}
        <button className="sal-btn sal-btn--ghost" onClick={onClose}>Huỷ</button>
        <button className="sal-btn sal-btn--primary" disabled={feedback.saving || feedback.blocked} onClick={() => submit(val, keySet)}>
          {save.isPending ? "Đang lưu…" : "Lưu số mới"}
        </button>
      </div>
    </Modal>
  );
}
