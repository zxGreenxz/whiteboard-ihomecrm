// Tab 3 — Cấu hình (quản lý hưởng lương · quy tắc thưởng · ngày lễ · KPI).
import React, { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { SAL_ICONS } from "./salaryIcons";
import { salFmt } from "./salaryFormat";
import { Modal } from "./salaryCommon";
import {
  useSalaryConfigList, useSaveManagerConfig, type ManagerConfigRow,
  useBonusRules, useSaveBonusRules, type SalaryRules,
  useSalaryHolidays, useAddHoliday, useDeleteHoliday,
  useStaffMonthOverrides, useSaveStaffMonthOverride, useSalaryLockedMonths,
} from "@/hooks/useSalaryConfig";
import { shiftYm, autoStaffYm, isStaffMonthVisible, latestVisibleStaffYm } from "@/lib/managerSalary";
import { vnYmOf } from "@/lib/salaryPeriod";

const I = SAL_ICONS;
const parseNum = (s: string) => parseInt((s || "").replace(/\D/g, ""), 10) || 0;
const fmtIn = (v: string | number) => {
  const n = typeof v === "number" ? v : parseInt((v || "").toString().replace(/\D/g, ""), 10);
  return n ? n.toLocaleString("vi-VN") : (v as string);
};

function Switch({ on, onClick }: { on: boolean; onClick: () => void }) {
  return <button className="sal-switch" data-on={!!on} onClick={onClick} role="switch" aria-checked={!!on} />;
}

const VN_HOLIDAYS_2026 = [
  { d: "2026-01-01", n: "Tết Dương lịch" },
  { d: "2026-02-17", n: "Tết Nguyên đán" },
  { d: "2026-04-26", n: "Giỗ Tổ Hùng Vương" },
  { d: "2026-04-30", n: "Giải phóng miền Nam" },
  { d: "2026-05-01", n: "Quốc tế Lao động" },
  { d: "2026-09-02", n: "Quốc khánh" },
];

function ManagerDialog({ row, onClose }: { row?: ManagerConfigRow | null; onClose: () => void }) {
  const save = useSaveManagerConfig();
  const { data: profiles } = useQuery({
    queryKey: ["profiles-for-salary"],
    queryFn: async () => {
      const { data } = await (supabase.from("profiles" as any).select("id, full_name") as any).order("full_name");
      return (data || []) as { id: string; full_name: string }[];
    },
    enabled: !row,
  });
  const { data: rooms } = useQuery({
    queryKey: ["rooms-for-salary"],
    queryFn: async () => {
      const { data } = await (supabase
        .from("rooms" as any)
        .select("id, name, building:building_id(name, code)") as any)
        .is("deleted_at", null)
        .order("name");
      return (data || []) as { id: string; name: string; building: { name: string; code: string | null } | null }[];
    },
  });
  const [staffId, setStaffId] = useState(row?.staff_id || "");
  const [alias, setAlias] = useState(row?.alias || "");
  const [role, setRole] = useState(row?.role_title || "Quản lý vận hành");
  const [base, setBase] = useState(row ? String(row.base_salary) : "");
  const [room, setRoom] = useState(row ? String(row.default_room_rent) : "0");
  const [goal, setGoal] = useState(row ? String(row.income_goal) : "");
  const [roomId, setRoomId] = useState(row?.room_id || "");

  return (
    <Modal onClose={onClose}>
      <div className="sal-modal-head">
        <span className="mic" style={{ background: "hsl(var(--primary) / .12)", color: "hsl(var(--primary))" }}><I.UserPlus size={19} /></span>
        <div><h3>{row ? "Sửa quản lý" : "Thêm quản lý hưởng lương"}</h3><p>{row ? row.full_name : "Đăng ký vào diện hưởng lương"}</p></div>
        <button className="x" onClick={onClose}><I.X size={18} /></button>
      </div>
      <div className="sal-modal-body">
        {!row && (
          <div className="sal-field"><label>Nhân viên</label>
            <select className="sal-select" style={{ height: 40 }} value={staffId} onChange={(e) => setStaffId(e.target.value)}>
              <option value="">— Chọn nhân viên —</option>
              {(profiles || []).map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
            </select></div>
        )}
        <div className="sal-two" style={{ gap: 12 }}>
          <div className="sal-field"><label>Biệt danh nội bộ</label><input className="sal-input" value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="Joey" /></div>
          <div className="sal-field"><label>Chức vụ</label><input className="sal-input" value={role} onChange={(e) => setRole(e.target.value)} /></div>
        </div>
        <div className="sal-field"><label>Lương tháng</label><input className="sal-input mono" value={fmtIn(base)} onChange={(e) => setBase(e.target.value)} placeholder="8.000.000" inputMode="numeric" /></div>
        <div className="sal-field"><label>Phòng nhân viên ở (giá ưu đãi)</label>
          <select className="sal-select" style={{ height: 40 }} value={roomId} onChange={(e) => setRoomId(e.target.value)}>
            <option value="">— Không gán phòng (dùng số cố định) —</option>
            {(rooms || []).map((r) => <option key={r.id} value={r.id}>{(r.building?.code || r.building?.name || "") + " · " + r.name}</option>)}
          </select>
        </div>
        <div className="sal-two" style={{ gap: 12 }}>
          <div className="sal-field"><label>Tiền phòng cố định {roomId ? "(khi tháng chưa có HĐ)" : ""}</label><input className="sal-input mono" value={fmtIn(room)} onChange={(e) => setRoom(e.target.value)} inputMode="numeric" /></div>
          <div className="sal-field"><label>Mục tiêu thu nhập tháng (tuỳ chọn)</label><input className="sal-input mono" value={fmtIn(goal)} onChange={(e) => setGoal(e.target.value)} placeholder="14.000.000" inputMode="numeric" /></div>
        </div>
        <div className="sal-helprow"><I.Home size={15} />{roomId ? "Tiền phòng = hoá đơn của phòng này theo từng tháng (giá ưu đãi), tự trừ vào lương." : "Cấp tài khoản đăng nhập để quản lý tự xem lương realtime ở mục \"Lương của tôi\"."}</div>
      </div>
      <div className="sal-modal-foot">
        <button className="sal-btn sal-btn--ghost" onClick={onClose}>Huỷ</button>
        <button className="sal-btn sal-btn--primary" disabled={!row && !staffId} onClick={() => {
          save.mutate({
            id: row?.id, staff_id: staffId || undefined,
            base_salary: parseNum(base), default_room_rent: parseNum(room),
            income_goal: parseNum(goal), role_title: role, alias: alias || null,
            room_id: roomId || null,
          }, { onSuccess: onClose });
        }}><I.Check size={16} />Lưu</button>
      </div>
    </Modal>
  );
}

const ymLabel = (ym: string) => { const [y, m] = ym.split("-"); return `Tháng ${parseInt(m, 10)}/${y}`; };

// Card — Tháng hiển thị bảng lương cho nhân viên (self-view).
function StaffMonthsCard() {
  const { data: overrides = {} } = useStaffMonthOverrides();
  const { data: lockedMonths } = useSalaryLockedMonths();
  const saveOverride = useSaveStaffMonthOverride();

  const cur = vnYmOf(); // giờ VN, không phải giờ máy (audit 2026-07-20)
  const prevLocked = lockedMonths?.has(shiftYm(cur, -1)) ?? false;
  const auto = autoStaffYm(cur, prevLocked);
  const staffViewing = latestVisibleStaffYm(cur, auto, overrides);
  const months = Array.from({ length: 6 }, (_, i) => shiftYm(cur, -i)); // cur … cur-5

  return (
    <div className="sal-card">
      <div className="sal-cfg-head">
        <span className="ic" style={{ background: "hsl(var(--status-info-bg))", color: "hsl(var(--status-info-fg))" }}><I.Calendar size={18} /></span>
        <div style={{ flex: 1 }}><h3>Tháng hiển thị cho nhân viên</h3><p>Bật/tắt từng tháng nhân viên được xem ở "Lương của tôi"</p></div>
      </div>
      <div className="sal-cfg-body">
        <div className="sal-note" style={{ marginTop: 0, marginBottom: 8 }}>
          <I.Info size={14} style={{ marginTop: 1, flexShrink: 0 }} />
          Mặc định lùi 1 tháng: hiện <b>{ymLabel(shiftYm(cur, -1))}</b> tới khi chốt lương, chốt rồi nhảy sang <b>{ymLabel(cur)}</b>. Nhân viên đang xem: <b style={{ color: "hsl(var(--primary))" }}>{ymLabel(staffViewing)}</b>.
        </div>
        {months.map((m) => {
          const visible = isStaffMonthVisible(m, auto, overrides);
          const hasOverride = Object.prototype.hasOwnProperty.call(overrides, m);
          const locked = lockedMonths?.has(m) ?? false;
          return (
            <div className="sal-rulerow" key={m}>
              <div className="rl">
                <b>{ymLabel(m)}{m === staffViewing ? <span className="sal-alias" style={{ marginLeft: 6 }}>đang hiển thị</span> : null}</b>
                <small>
                  {locked ? "Đã chốt lương" : "Chưa chốt"}
                  {hasOverride ? " · admin ghim" : (visible ? " · tự động hiện" : " · tự động ẩn")}
                </small>
              </div>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                {hasOverride && (
                  <button className="sal-btn sal-btn--ghost sal-btn--sm sal-btn--icon" title="Về mặc định tự động"
                    onClick={() => saveOverride.mutate({ ym: m, value: null })}><I.RefreshCw size={14} /></button>
                )}
                <Switch on={visible} onClick={() => saveOverride.mutate({ ym: m, value: !visible })} />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AddHolidayDialog({ onClose }: { onClose: () => void }) {
  const add = useAddHoliday();
  const [date, setDate] = useState("");
  const [name, setName] = useState("");
  return (
    <Modal onClose={onClose}>
      <div className="sal-modal-head">
        <span className="mic" style={{ background: "hsl(var(--status-tasks-bg))", color: "hsl(var(--status-tasks-fg))" }}><I.Calendar size={19} /></span>
        <div><h3>Thêm ngày lễ</h3><p>Dùng cho quy tắc thưởng CN/Lễ</p></div>
        <button className="x" onClick={onClose}><I.X size={18} /></button>
      </div>
      <div className="sal-modal-body">
        <div className="sal-field"><label>Ngày</label><input type="date" className="sal-input mono" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <div className="sal-field"><label>Tên ngày lễ</label><input className="sal-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="VD: Quốc khánh" /></div>
      </div>
      <div className="sal-modal-foot">
        <button className="sal-btn sal-btn--ghost" onClick={onClose}>Huỷ</button>
        <button className="sal-btn sal-btn--primary" disabled={!date} onClick={() => add.mutate({ holiday_date: date, name }, { onSuccess: onClose })}><I.Check size={16} />Thêm</button>
      </div>
    </Modal>
  );
}

export default function SalaryConfig() {
  const { data: configList = [] } = useSalaryConfigList();
  const { data: rulesData } = useBonusRules();
  const saveRules = useSaveBonusRules();
  const { data: holidays = [] } = useSalaryHolidays();
  const addHoliday = useAddHoliday();
  const delHoliday = useDeleteHoliday();

  const [mgrDialog, setMgrDialog] = useState<{ row?: ManagerConfigRow | null } | null>(null);
  const [holidayDialog, setHolidayDialog] = useState(false);
  const [rules, setRules] = useState<SalaryRules | null>(null);
  useEffect(() => { if (rulesData?.rules) setRules({ ...rulesData.rules }); }, [rulesData]);
  const [kpi, setKpi] = useState([
    { id: "occupancy", label: "Tỷ lệ lấp đầy", target: "≥ 95%", reward: 1500000, on: true },
    { id: "ontime", label: "Thu đúng hạn", target: "≥ 90%", reward: 1000000, on: true },
    { id: "retention", label: "Giữ chân khách (gia hạn)", target: "≥ 8 HĐ", reward: 800000, on: false },
  ]);

  const onRule = (k: keyof SalaryRules, v: any) => setRules((p) => (p ? { ...p, [k]: v } : p));
  const ruleIn = (v: number) => (v || 0).toLocaleString("vi-VN");
  const dm = (iso: string) => { const [, m, d] = iso.split("-"); return `${d}/${m}`; };

  const loadPreset = () => {
    const have = new Set(holidays.map((h) => h.holiday_date));
    VN_HOLIDAYS_2026.filter((h) => !have.has(h.d)).forEach((h) => addHoliday.mutate({ holiday_date: h.d, name: h.n }));
  };

  return (
    <>
      <div className="sal-cfg-grid">
        {/* Card 1 — Managers */}
        <div className="sal-card">
          <div className="sal-cfg-head">
            <span className="ic" style={{ background: "hsl(var(--primary) / .12)", color: "hsl(var(--primary))" }}><I.Users size={18} /></span>
            <div style={{ flex: 1 }}><h3>Quản lý hưởng lương</h3><p>Ai được tính lương + lương cứng, tiền phòng</p></div>
            <button className="sal-btn sal-btn--outline sal-btn--sm" onClick={() => setMgrDialog({ row: null })}><I.Plus size={15} />Thêm</button>
          </div>
          <div className="sal-cfg-body" style={{ paddingTop: 4, paddingBottom: 4 }}>
            {configList.length === 0 && <div style={{ padding: 16, fontSize: 13, color: "hsl(var(--muted-foreground))" }}>Chưa có quản lý nào. Bấm "Thêm" để đăng ký.</div>}
            {configList.map((m) => (
              <div className="sal-mgrrow" key={m.id}>
                <span className="sal-ava" style={{ width: 40, height: 40, background: "hsl(var(--primary))" }}>{(m.full_name || "?").trim().split(/\s+/).pop()![0]}</span>
                <div className="sal-mgrinfo">
                  <span className="nm">{m.full_name}{m.alias ? <span className="sal-alias">{m.alias}</span> : null}</span>
                  <span className="meta">{m.role_title} · Lương {salFmt(m.base_salary)}{m.room_name ? " · Ở phòng " + m.room_name : (m.default_room_rent ? " · Phòng " + salFmt(m.default_room_rent) : "")}</span>
                </div>
                <button className="sal-btn sal-btn--ghost sal-btn--sm sal-btn--icon" onClick={() => setMgrDialog({ row: m })}><I.Pencil size={15} /></button>
              </div>
            ))}
          </div>
        </div>

        {/* Card 2 — Bonus rules */}
        <div className="sal-card">
          <div className="sal-cfg-head">
            <span className="ic" style={{ background: "hsl(var(--status-warning-bg))", color: "hsl(var(--status-warning-fg))" }}><I.Gift size={18} /></span>
            <div style={{ flex: 1 }}><h3>Quy tắc thưởng</h3><p>Mức thưởng tự động cho việc & hợp đồng</p></div>
            {rules && <button className="sal-btn sal-btn--primary sal-btn--sm" onClick={() => saveRules.mutate(rules)}><I.Check size={14} />Lưu</button>}
          </div>
          <div className="sal-cfg-body">
            {rules && <>
              <div className="sal-rulerow"><div className="rl"><b>Thưởng mỗi việc sửa chữa</b><small>mức mặc định (đặt riêng từng loại ở trang Loại công việc)</small></div>
                <span className="sal-ruleinput"><input value={ruleIn(rules.repair)} onChange={(e) => onRule("repair", parseNum(e.target.value))} /><span className="unit">đ</span></span></div>
              <div className="sal-rulerow"><div className="rl"><b>Thưởng cả ngày nếu có sửa chữa CN/Lễ</b><small>áp dụng Chủ nhật HOẶC ngày lễ</small></div>
                <span className="sal-ruleinput"><input value={ruleIn(rules.weekendRepair)} onChange={(e) => onRule("weekendRepair", parseNum(e.target.value))} /><span className="unit">đ</span></span></div>
              <div className="sal-rulerow"><div className="rl"><b>Thưởng mỗi HĐ làm sau giờ / CN / Lễ</b></div>
                <span className="sal-ruleinput"><input value={ruleIn(rules.afterHourContract)} onChange={(e) => onRule("afterHourContract", parseNum(e.target.value))} /><span className="unit">đ</span></span></div>
              <div className="sal-rulerow"><div className="rl"><b>Mốc "sau giờ"</b></div>
                <span className="sal-ruleinput"><input style={{ width: 72, fontFamily: "var(--font-mono)" }} value={rules.afterHourMark} onChange={(e) => onRule("afterHourMark", e.target.value)} /></span></div>
              <div className="sal-rulerow"><div className="rl"><b>Ngày nghỉ tính cuối tuần</b></div>
                <select className="sal-select" value={JSON.stringify(rules.weekendDays)} onChange={(e) => onRule("weekendDays", JSON.parse(e.target.value))} style={{ width: 130 }}>
                  <option value="[0]">Chủ nhật</option><option value="[0,6]">Thứ 7 + CN</option></select></div>
              <div className="sal-rulerow"><div className="rl"><b>Yêu cầu ảnh hoàn thành mới tính thưởng</b><small>{rules.requirePhoto ? "Đang BẬT — việc thiếu ảnh không tính" : "Mặc định TẮT"}</small></div>
                <Switch on={rules.requirePhoto} onClick={() => onRule("requirePhoto", !rules.requirePhoto)} /></div>
              <div className="sal-note"><I.Info size={14} style={{ marginTop: 1, flexShrink: 0 }} />Mức thưởng riêng theo từng loại việc cài ở trang <b style={{ color: "hsl(var(--primary))" }}>&nbsp;Loại công việc</b>.</div>
            </>}
          </div>
        </div>

        {/* Card 3 — Holidays */}
        <div className="sal-card">
          <div className="sal-cfg-head">
            <span className="ic" style={{ background: "hsl(var(--status-tasks-bg))", color: "hsl(var(--status-tasks-fg))" }}><I.Calendar size={18} /></span>
            <div style={{ flex: 1 }}><h3>Ngày lễ</h3><p>Dùng cho quy tắc thưởng CN/Lễ</p></div>
            <button className="sal-btn sal-btn--outline sal-btn--sm" onClick={loadPreset}><I.Sparkles size={14} />Nạp sẵn lễ VN 2026</button>
          </div>
          <div className="sal-cfg-body">
            <div className="sal-holidays">
              {holidays.map((h) => <span className="sal-holiday" key={h.id}>{dm(h.holiday_date)}{h.name ? " · " + h.name : ""}<button title="Xoá" onClick={() => delHoliday.mutate(h.id)}><I.X size={12} /></button></span>)}
              <button className="sal-holiday" style={{ background: "hsl(var(--muted))", color: "hsl(var(--primary))", cursor: "pointer", border: "1px dashed hsl(var(--primary) / .4)" }} onClick={() => setHolidayDialog(true)}><I.Plus size={13} />Thêm ngày</button>
            </div>
          </div>
        </div>

        {/* Card 4 — KPI */}
        <div className="sal-card">
          <div className="sal-cfg-head">
            <span className="ic" style={{ background: "hsl(var(--status-success-bg))", color: "hsl(var(--status-success-fg))" }}><I.Target size={18} /></span>
            <div><h3>Mục tiêu &amp; KPI</h3><p>Thưởng theo hiệu suất — opt-in (bản xem trước)</p></div>
          </div>
          <div className="sal-cfg-body">
            {kpi.map((k) => (
              <div className="sal-kpirow" key={k.id}>
                <div className="kl"><b>{k.on ? <I.Zap size={14} style={{ color: "hsl(var(--status-success-strong))" }} /> : <I.Circle size={14} style={{ color: "hsl(var(--muted-foreground))" }} />}{k.label}</b><small>Mục tiêu {k.target}</small></div>
                <span className="sal-kpireward">+{salFmt(k.reward)}</span>
                <Switch on={k.on} onClick={() => setKpi((p) => p.map((x) => x.id === k.id ? { ...x, on: !x.on } : x))} />
              </div>
            ))}
            <div className="sal-note"><I.Info size={14} style={{ marginTop: 1, flexShrink: 0 }} />KPI là cải tiến tuỳ chọn — bản xem trước, sẽ cộng vào cột Thưởng khi bật trong các bản sau.</div>
          </div>
        </div>

        {/* Card 5 — Tháng hiển thị cho nhân viên */}
        <StaffMonthsCard />
      </div>

      {mgrDialog && <ManagerDialog row={mgrDialog.row} onClose={() => setMgrDialog(null)} />}
      {holidayDialog && <AddHolidayDialog onClose={() => setHolidayDialog(false)} />}
    </>
  );
}
