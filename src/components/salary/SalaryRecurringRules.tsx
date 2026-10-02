import {parseSalaryAmount,formatSalaryAmountInput,typedSalaryAmount} from '@/lib/salaryAmountInput';
import { QueryRegion } from "@/components/errors/QueryRegion";
import { useSalaryFormFeedback } from "./useSalaryFormFeedback";
import { SALARY_SETTINGS_RULES } from "@/lib/salarySettingsFeedback";
// Tab "Khoản định kỳ" của modal Nguồn lương — phụ cấp / thưởng cố định và lương QL
// bổ sung do chủ công ty cấp (gắn toà). Quy tắc + phiên bản, tính TRỌN kỳ (chủ chốt
// 27/09/2026). Ghi qua salary_recurring_*_v1; chỉ super admin / chủ công ty.
// Khung "Tác động" tính bằng recurringAmountFor — cùng luật với server.
import { useMemo, useState, type CSSProperties } from "react";
import { useBuildings } from "@/hooks/useBuildings";
import {
  newSalaryRequestKey, useAddRecurringVersion, useCreateRecurring, useDeleteRecurring,
} from "@/hooks/useSalaryExtras";
import { isSupplementaryLabel } from "@/lib/salaryFundReport";
import { shiftPeriodMonth } from "@/lib/salaryPeriod";
import {
  RECURRING_CATEGORY_LABEL, RECURRING_SOURCE_LABEL, recurringAmountFor,
  type RecurringCategory, type RecurringItem, type RecurringKind,
} from "@/lib/salaryRecurring";
import type { SalManager } from "@/lib/managerSalary";
import { salFmt } from "./salaryFormat";
import { MONO, MUTED, Seg, StChip, monthShort } from "./salaryFundUi";

const card: CSSProperties = { background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 12, boxShadow: "var(--shadow-sm)" };

const kyLabel = (p: string) => `${monthShort(p)}/${p.slice(0, 4)}`;

export interface AddPreset {
  staffId?: string;
  label?: string;
  amount?: number;
  category?: RecurringCategory;
}

type Mode = { t: "add"; preset: AddPreset; nonce: number } | { t: "edit"; id: string } | null;

interface Props {
  managers: SalManager[];
  recurring: RecurringItem[];
  periodMonth: string;
  canEdit: boolean;
  available: boolean;
  /** Mở sẵn form thêm (vd bấm "+ Thêm lương QL bổ sung" ở tab Nguồn lương). */
  initialAdd: AddPreset | null;
}

export default function SalaryRecurringRules({ managers, recurring, periodMonth, canEdit, available, initialAdd }: Props) {
  const [mode, setMode] = useState<Mode>(
    initialAdd ? { t: "add", preset: initialAdd, nonce: 1 } : recurring[0] ? { t: "edit", id: recurring[0].id } : null,
  );
  const lockedOf = (staffId: string) => managers.find((m) => m.id === staffId)?.status === "LOCKED";
  const manual = managers.flatMap((m) =>
    m.adjustments.filter((a) => !a.recurring && a.amount > 0).map((a) => ({ m, a })),
  );
  const openAdd = (preset: AddPreset) => setMode((cur) => ({ t: "add", preset, nonce: (cur?.t === "add" ? cur.nonce : 0) + 1 }));
  const sel = mode?.t === "edit" ? recurring.find((r) => r.id === mode.id) || null : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {!available && (
        <div style={{ fontSize: 12.5, color: "hsl(var(--status-warning-fg))", background: "hsl(var(--status-warning-bg))", borderRadius: 8, padding: "10px 14px" }}>
          <b>Chưa bật trên máy chủ.</b> Chức năng khoản lương định kỳ chưa sẵn sàng. Liên hệ quản trị viên để bật trước khi lưu.
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,360px),1fr))", gap: 18, alignItems: "start" }}>
        <div style={{ gridColumn: "span 2", minWidth: 0, display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={card}>
            <div style={{ padding: "16px 20px", borderBottom: "1px solid hsl(var(--border))", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Khoản định kỳ</h3>
                <p style={{ margin: 0, fontSize: 11.5, color: MUTED }}>Tự vào lương mỗi kỳ theo phiên bản đang hiệu lực; tính lại một kỳ nhiều lần vẫn chỉ phát sinh một lần cho mỗi khoản · người · kỳ.</p>
              </div>
              {canEdit && available && <button className="sal-btn sal-btn--primary sal-btn--sm" onClick={() => openAdd({})}>+ Thêm khoản định kỳ</button>}
            </div>
            <div style={{ overflowX: "auto" }}><div style={{ minWidth: 640 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1.7fr 1.1fr 120px 1.2fr", gap: "0 12px", padding: "10px 20px", background: "hsl(var(--muted) / .5)", borderBottom: "1px solid hsl(var(--border))", fontSize: 10.5, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", color: MUTED }}>
                <span>Người · khoản</span><span>Loại</span><span style={{ textAlign: "right" }}>Mức {monthShort(periodMonth)}</span><span>Nguồn chịu tiền</span>
              </div>
              {recurring.length === 0 && <div style={{ padding: 20, fontSize: 12.5, color: MUTED }}>Chưa có khoản định kỳ nào.{canEdit && available ? " Bấm “+ Thêm khoản định kỳ” để nhập phụ cấp / thưởng cố định." : ""}</div>}
              {recurring.map((r) => {
                const a = sel?.id === r.id;
                const first = r.versions[0]?.effectiveMonth;
                const status = r.amountForPeriod > 0 ? null : first && first > periodMonth ? `Bắt đầu ${kyLabel(first)}` : "Không phát sinh kỳ này";
                return (
                  <button key={r.id} onClick={() => setMode({ t: "edit", id: r.id })}
                    style={{ display: "grid", gridTemplateColumns: "1.7fr 1.1fr 120px 1.2fr", gap: "0 12px", alignItems: "center", width: "100%", textAlign: "left", border: 0, borderBottom: "1px solid hsl(var(--border) / .6)", background: a ? "hsl(var(--primary) / .08)" : "hsl(var(--card))", boxShadow: a ? "inset 3px 0 0 hsl(var(--primary))" : "none", padding: "11px 20px", cursor: "pointer" }}>
                    <span><b style={{ fontSize: 13 }}>{r.label}</b><br /><span style={{ fontSize: 11.5, color: MUTED }}>{r.staffName || "—"}{status ? " · " + status : ""}</span></span>
                    <span style={{ fontSize: 12 }}>{RECURRING_CATEGORY_LABEL[r.category]}{r.buildingName ? ` · ${r.buildingName}` : ""}</span>
                    <span style={{ ...MONO, textAlign: "right", fontWeight: 600 }}>{salFmt(r.amountForPeriod)}</span>
                    <span style={{ fontSize: 12, color: "hsl(var(--status-neutral-fg))" }}>{RECURRING_SOURCE_LABEL[r.category]}</span>
                  </button>
                );
              })}
            </div></div>
          </div>

          {manual.length > 0 && (
            <div style={card}>
              <div style={{ padding: "14px 20px", borderBottom: "1px solid hsl(var(--border))" }}>
                <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>Đang nhập tay trong Thưởng kỳ {monthShort(periodMonth)}</h3>
                <p style={{ margin: 0, fontSize: 11.5, color: MUTED }}>Khoản lặp lại hàng tháng nên chuyển thành khoản định kỳ. Sau khi chuyển, xoá dòng Thưởng tay của các kỳ chưa chốt để không trả hai lần.</p>
              </div>
              {manual.map(({ m, a }) => (
                <div key={m.id + ":" + (a.id || a.label)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 20px", borderBottom: "1px solid hsl(var(--border) / .6)", flexWrap: "wrap" }}>
                  <span style={{ flex: 1, minWidth: 180 }}><b style={{ fontSize: 13 }}>{a.label}</b><br /><span style={{ fontSize: 11.5, color: MUTED }}>{m.name} · nhập tay</span></span>
                  <span style={{ ...MONO, fontWeight: 600 }}>{salFmt(a.amount)}</span>
                  {canEdit && available && (
                    <button className="sal-btn sal-btn--outline sal-btn--sm"
                      onClick={() => openAdd({ staffId: m.id, label: a.label, amount: a.amount, category: isSupplementaryLabel(a.label) ? "SUPPLEMENTARY" : "ALLOWANCE" })}>
                      Chuyển thành định kỳ
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ ...card, boxShadow: "var(--shadow-md)", minWidth: 0 }}>
          {mode?.t === "add" ? (
            <AddForm key={mode.nonce} preset={mode.preset} managers={managers} periodMonth={periodMonth} lockedOf={lockedOf}
              disabled={!canEdit || !available} onDone={(id) => setMode(id ? { t: "edit", id } : null)} />
          ) : sel ? (
            <VersionEditor key={sel.id} item={sel} periodMonth={periodMonth} locked={lockedOf(sel.staffId)}
              disabled={!canEdit || !available} onDeleted={() => setMode(null)} />
          ) : (
            <div style={{ padding: "18px 16px", fontSize: 12.5, color: MUTED }}>Chọn một khoản bên trái để sửa mức, hoặc thêm khoản mới.</div>
          )}
          {!canEdit && (
            <div style={{ margin: "0 16px 16px", fontSize: 11.5, color: MUTED, background: "hsl(var(--muted) / .5)", borderRadius: 8, padding: "9px 12px" }}>
              Chỉ chủ công ty hoặc quản trị hệ thống được thêm / sửa khoản định kỳ.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FromPicker({ periodMonth, value, onChange, locked }: { periodMonth: string; value: string; onChange: (p: string) => void; locked: boolean }) {
  const froms = [0, 1, 2].map((k) => shiftPeriodMonth(periodMonth, k));
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {froms.map((f, i) => {
        const a = f === value;
        const dis = i === 0 && locked;
        return <button key={f} disabled={dis} onClick={() => onChange(f)} className="sal-btn sal-btn--sm"
          style={{ border: `1px solid ${a ? "hsl(var(--primary))" : "hsl(var(--border))"}`, background: a ? "hsl(var(--primary) / .08)" : "hsl(var(--card))", color: a ? "hsl(var(--primary))" : "hsl(var(--foreground))" }}>
          {kyLabel(f)}{i === 0 ? (locked ? " · đã chốt" : " · đang mở") : ""}</button>;
      })}
    </div>
  );
}

function AddForm({ preset, managers, periodMonth, lockedOf, disabled, onDone }: {
  preset: AddPreset; managers: SalManager[]; periodMonth: string; lockedOf: (id: string) => boolean;
  disabled: boolean; onDone: (itemId: string | null) => void;
}) {
  const feedback=useSalaryFormFeedback("tạo khoản lương định kỳ",{rules:SALARY_SETTINGS_RULES});
  const create = useCreateRecurring();
  const [staffId, setStaffId] = useState(preset.staffId || managers[0]?.id || "");
  const [category, setCategory] = useState<RecurringCategory>(preset.category || "ALLOWANCE");
  const [label, setLabel] = useState(preset.label || (preset.category === "SUPPLEMENTARY" ? "Lương QL bổ sung" : ""));
  const [buildingId, setBuildingId] = useState("");
  const [amt, setAmt] = useState(preset.amount ? String(preset.amount) : "");
  const locked = lockedOf(staffId);
  const [from, setFrom] = useState(shiftPeriodMonth(periodMonth, locked ? 1 : 0));
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [requestKey] = useState(() => newSalaryRequestKey("sal-rec"));
  const staffOrg = managers.find((m) => m.id === staffId)?.organizationId ?? null;
  const buildingsQuery=useBuildings({ enabled: category === "SUPPLEMENTARY" }); const {data:buildings=[]}=buildingsQuery;
  const orgBuildings = useMemo(
    () => (buildings as { id: string; name: string; organization_id: string | null }[])
      .filter((b) => !staffOrg || b.organization_id === staffOrg)
      .sort((a, b) => a.name.localeCompare(b.name, "vi")),
    [buildings, staffOrg],
  );
  const parsedAmount = parseSalaryAmount(amt);
  const amount = parsedAmount.value ?? 0;
  const submit = () => {
    let createdId: string | null=null;
    void feedback.run(async()=>{const result=await create.mutateAsync({staffId,label:label.trim(),category,buildingId:category==='SUPPLEMENTARY'?buildingId:null,amount,effectiveMonth:from,reason:reason.trim(),note:note.trim()||null,requestKey});createdId=result.id;},()=>onDone(createdId),{
      staffId:staffId?undefined:'Chọn người nhận khoản lương.',
      label:label.trim()&&label.trim().length<=120?undefined:'Nhập tên khoản từ 1 đến 120 ký tự.',
      amount:parsedAmount.error ?? (amount>0?undefined:'Nhập số tiền nguyên lớn hơn 0.'),
      reason:reason.trim()?undefined:'Nhập lý do tạo khoản định kỳ.',
      buildingId:category==='SUPPLEMENTARY'&&!buildingId?'Chọn tòa nhà được bổ sung lương.':undefined,
    });
  };

  return (
    <div ref={feedback.root}>
      <div style={{ padding: "14px 16px", borderBottom: "1px solid hsl(var(--border))" }}>
        <b style={{ fontSize: 14 }}>Thêm khoản định kỳ</b>
        <div style={{ fontSize: 11.5, color: MUTED }}>Nhập một lần — tự vào lương mỗi kỳ từ kỳ áp dụng.</div>
      </div>
      <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12, opacity: disabled ? 0.55 : 1 }}>
        <div className="sal-field"><label htmlFor="rec-staff">Người nhận</label>
          <select {...feedback.field("staffId")} id="rec-staff" className="sal-select" value={staffId} onChange={(e) => setStaffId(e.target.value)} disabled={disabled}>
            {managers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select></div>
        <div className="sal-field"><label>Loại</label>
          <Seg<RecurringCategory> small value={category} onChange={(c) => { setCategory(c); if (c === "SUPPLEMENTARY" && !label.trim()) setLabel("Lương QL bổ sung"); }}
            options={[{ key: "ALLOWANCE", label: "Phụ cấp / thưởng cố định" }, { key: "SUPPLEMENTARY", label: "Lương QL bổ sung (chủ cấp)" }]} /></div>
        {category === "SUPPLEMENTARY" && (
          <div className="sal-field"><label htmlFor="rec-building">Nhà / toà được bù</label>
            {/* Nhãn hiện ngay; chỉ ô chọn chờ danh sách toà (vạch xám trong ô). */}
            <QueryRegion label="tòa nhà của người nhận lương" queries={[buildingsQuery]} skeleton="inline">
            <select {...feedback.field("buildingId")} id="rec-building" className="sal-select" value={buildingId} onChange={(e) => setBuildingId(e.target.value)} disabled={disabled}>
              <option value="">— Chọn toà (vd 481NVK, 950NK, 44TL) —</option>
              {orgBuildings.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            </QueryRegion>
            <span style={{ fontSize: 11, color: MUTED }}>Dùng cho nhà không thuê-cho-thuê-lại (không có phí Quản lý). Tiền do chủ công ty cấp, không ghi vào thu chi của toà.</span>
          </div>
        )}
        <div className="sal-field"><label htmlFor="rec-label">Tên khoản</label>
          <input {...feedback.field("label")} id="rec-label" className="sal-input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="VD: Hỗ trợ xăng, phụ cấp điện thoại…" disabled={disabled} /></div>
        <div className="sal-field"><label htmlFor="rec-amount">Mức mỗi tháng</label>
          <input {...feedback.field("amount")} id="rec-amount" className="sal-input mono" inputMode="numeric" value={formatSalaryAmountInput(amt)} onChange={(e) => setAmt(typedSalaryAmount(amt, e))} placeholder="VD: 700.000" disabled={disabled} /></div>
        <div className="sal-field" data-field-name="effectiveMonth" aria-invalid={!!feedback.issue("effectiveMonth")}><label>Áp dụng từ kỳ</label>
          <FromPicker periodMonth={periodMonth} value={from} onChange={setFrom} locked={locked} /></div>
        <div className="sal-field"><label htmlFor="rec-reason">Lý do (bắt buộc)</label>
          <textarea {...feedback.field("reason")} id="rec-reason" className="sal-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="VD: Thỏa thuận phụ trách thêm toà 44TL từ tháng 9" disabled={disabled} /></div>
        <div className="sal-field"><label htmlFor="rec-note">Ghi chú</label>
          <input id="rec-note" className="sal-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Tuỳ chọn" disabled={disabled} /></div>
        {['staffId','buildingId','label','amount','effectiveMonth','reason'].map(name=><div key={name}>{feedback.issue(name)}</div>)}
        {feedback.notice}
        <button className="sal-btn sal-btn--primary" style={{justifyContent:'center'}} disabled={disabled || feedback.saving || feedback.blocked || (category==='SUPPLEMENTARY' && buildingsQuery.isError)} onClick={submit}>
          {create.isPending ? "Đang lưu…" : "Tạo khoản định kỳ"}
        </button>
        <div style={{ fontSize: 11.5, color: MUTED, background: "hsl(var(--muted) / .5)", borderRadius: 8, padding: "9px 12px" }}>
          Bắt đầu / ngừng giữa tháng tính <b>trọn kỳ</b> (chủ chốt 27/09/2026). Kỳ đã chốt không bao giờ tính lại.
        </div>
      </div>
    </div>
  );
}

function VersionEditor({ item, periodMonth, locked, disabled, onDeleted }: {
  item: RecurringItem; periodMonth: string; locked: boolean; disabled: boolean; onDeleted: () => void;
}) {
  const feedback=useSalaryFormFeedback("thay đổi khoản lương định kỳ",{rules:SALARY_SETTINGS_RULES});
  const addVersion = useAddRecurringVersion();
  const del = useDeleteRecurring();
  const [kind, setKind] = useState<RecurringKind>("CHANGE");
  const froms = [0, 1, 2].map((k) => shiftPeriodMonth(periodMonth, k));
  const [from, setFrom] = useState(froms[locked ? 1 : 0]);
  const [amt, setAmt] = useState("");
  const [reason, setReason] = useState("");
  const [requestKey, setRequestKey] = useState(() => newSalaryRequestKey("sal-recv"));
  const parsedAmount = parseSalaryAmount(amt);
  const amount = parsedAmount.value ?? 0;
  const nextSeq = Math.max(0, ...item.versions.map((v) => v.seq)) + 1;
  const pending = { seq: nextSeq, kind, effectiveMonth: from, amount: kind === "STOP" ? null : amount };
  const prevMonth = shiftPeriodMonth(periodMonth, -1);
  const rows = [
    { p: prevMonth, k: `${kyLabel(prevMonth)} · kỳ trước` },
    ...froms.map((f, i) => ({ p: f, k: kyLabel(f) + (i === 2 ? " trở đi" : "") })),
  ].map(({ p, k }) => {
    const before = recurringAmountFor(item.versions, p) ?? 0;
    const after = recurringAmountFor([...item.versions, pending], p) ?? 0;
    const touched = kind === "ONCE" ? p === from : p >= from;
    return { k, before, after, changed: touched && (kind === "STOP" || amount > 0) && before !== after };
  });
  const invalid = (deleting=false) => ({reason:reason.trim()?undefined:'Nhập lý do thay đổi khoản định kỳ.',amount:deleting||kind==='STOP'?undefined:parsedAmount.error??(amount>0?undefined:'Nhập số tiền nguyên lớn hơn 0.')});

  return (
    <div ref={feedback.root}>
      <div style={{ padding: "14px 16px", borderBottom: "1px solid hsl(var(--border))" }}>
        <b style={{ fontSize: 14 }}>{item.label}</b>
        <div style={{ fontSize: 11.5, color: MUTED }}>
          {item.staffName || "—"} · {RECURRING_CATEGORY_LABEL[item.category]}{item.buildingName ? ` · ${item.buildingName}` : ""} · kỳ này {salFmt(item.amountForPeriod)}
        </div>
      </div>
      <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12, opacity: disabled ? 0.55 : 1 }}>
        <div className="sal-field"><label>Loại thay đổi</label>
          <Seg<RecurringKind> small value={kind} onChange={setKind} options={[{ key: "CHANGE", label: "Sửa mức từ kỳ" }, { key: "ONCE", label: "Chỉ một kỳ" }, { key: "STOP", label: "Ngừng từ kỳ" }]} /></div>
        {kind !== "STOP" && <div className="sal-field"><label htmlFor="recv-amount">Mức mới</label>
          <input {...feedback.field("amount")} id="recv-amount" className="sal-input mono" value={formatSalaryAmountInput(amt)} onChange={(e) => setAmt(typedSalaryAmount(amt, e))} inputMode="numeric" placeholder="VD: 700.000" disabled={disabled} /></div>}
        <div className="sal-field" data-field-name="effectiveMonth" aria-invalid={!!feedback.issue("effectiveMonth")}><label>{kind === "ONCE" ? "Kỳ được điều chỉnh" : "Áp dụng từ kỳ"}</label>
          <FromPicker periodMonth={periodMonth} value={from} onChange={setFrom} locked={locked} /></div>
        <div className="sal-field"><label>Tác động</label>
          {rows.map((x, i) => (
            <div key={x.k} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12, padding: "7px 10px", borderRadius: 6, background: i === 0 ? "hsl(var(--muted) / .5)" : "hsl(var(--card))" }}>
              <span style={{ fontWeight: 600 }}>{x.k}</span>
              <span style={{ color: x.changed ? "hsl(var(--primary))" : "hsl(var(--status-neutral-fg))", textAlign: "right" }}>
                {x.changed ? `${salFmt(x.before)} → ${x.after ? salFmt(x.after) : "không phát sinh"}` : (x.before ? "Giữ " + salFmt(x.before) : "Không phát sinh")}
              </span>
            </div>
          ))}</div>
        <div className="sal-field"><label htmlFor="recv-reason">Lý do (bắt buộc)</label>
          <textarea {...feedback.field("reason")} id="recv-reason" className="sal-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="VD: Nhận thêm phụ trách tòa mới theo thỏa thuận ngày…" disabled={disabled} /></div>
        {['amount','reason','effectiveMonth'].map(name=><div key={name}>{feedback.issue(name)}</div>)}
        {feedback.notice}
        <button className="sal-btn sal-btn--primary" style={{ justifyContent: "center" }} disabled={disabled || feedback.saving || feedback.blocked}
          onClick={() => void feedback.run(()=>addVersion.mutateAsync(
            { itemId: item.id, kind, effectiveMonth: from, amount: kind === "STOP" ? null : amount, reason: reason.trim(), requestKey },
          ),()=>{setAmt('');setReason('');setRequestKey(newSalaryRequestKey('sal-recv'));},invalid())}>
          {addVersion.isPending ? "Đang lưu…" : "Lưu phiên bản mới"}
        </button>

        <div className="sal-field"><label>Lịch sử phiên bản</label>
          {item.versions.slice().reverse().map((v) => (
            <div key={v.id} style={{ fontSize: 11.5, padding: "6px 0", borderBottom: "1px solid hsl(var(--border) / .6)" }}>
              <StChip tone={v.kind === "STOP" ? "danger" : v.kind === "ONCE" ? "warning" : "success"}>
                {v.kind === "CHANGE" ? "Từ " : v.kind === "ONCE" ? "Chỉ " : "Ngừng từ "}{kyLabel(v.effectiveMonth)}
              </StChip>{" "}
              {v.amount != null && <b style={MONO}>{salFmt(v.amount)}</b>} · {v.reason}
              <div style={{ color: MUTED }}>{v.createdByName || "—"} · {new Date(v.createdAt).toLocaleString("vi-VN")}</div>
            </div>
          ))}
        </div>
        {!disabled && (
          <button className="sal-btn sal-btn--ghost" style={{ color: "hsl(var(--status-danger-fg))", justifyContent: "center" }}
            disabled={feedback.saving || feedback.blocked} title={!reason.trim() ? "Ghi lý do trước khi xoá" : undefined}
            onClick={() => void feedback.run(()=>del.mutateAsync({ itemId:item.id,reason:reason.trim() }),onDeleted,invalid(true))}>
            Xoá khoản (nhập nhầm — chỉ khi chưa vào kỳ đã chốt)
          </button>
        )}
      </div>
    </div>
  );
}
