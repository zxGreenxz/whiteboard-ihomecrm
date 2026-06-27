import { useEffect, useMemo, useState } from "react";
import { Calendar, Phone, Check, ChevronRight } from "lucide-react";
import { useHotlines } from "@/hooks/useHotlines";
import {
  usePublicRoomSettings, useUpsertPublicRoomSettings, PUBLIC_ROOM_SETTINGS_DEFAULTS,
  type PublicRoomSettings,
} from "@/hooks/usePublicRoomSettings";
import SaleSheet from "./SaleSheet";

export default function MobileDisplaySettings() {
  const { data, isLoading } = usePublicRoomSettings();
  const { data: hotlines } = useHotlines();
  const upsertMut = useUpsertPublicRoomSettings();

  const [form, setForm] = useState<PublicRoomSettings>(PUBLIC_ROOM_SETTINGS_DEFAULTS);
  const [hotlineSheet, setHotlineSheet] = useState(false);

  useEffect(() => { if (data) setForm(data); }, [data]);

  const set = <K extends keyof PublicRoomSettings>(k: K, v: PublicRoomSettings[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const list = hotlines ?? [];
  const selected = useMemo(
    () => list.find((h) => h.id === form.hotline_id) ?? list[0],
    [list, form.hotline_id],
  );
  const hotlineName = selected?.name ?? "Mặc định";
  const hotlinePhone = selected?.phone_number ?? "—";

  if (isLoading) return <div className="stub"><p>Đang tải…</p></div>;

  return (
    <div style={{ padding: "14px 16px 28px" }}>
      <p className="sp-hint" style={{ margin: "0 0 14px" }}>Áp dụng chung cho mọi link chia sẻ của tài khoản.</p>

      {/* soon_days stepper */}
      <div className="sp-card">
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <span className="ic" style={{ width: 34, height: 34, borderRadius: 10, background: "var(--soonBg)", color: "var(--soon)", display: "grid", placeItems: "center", flexShrink: 0 }}>
            <Calendar size={18} />
          </span>
          <div style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 700, letterSpacing: "-.2px" }}>Số ngày báo "sắp trống"</div>
        </div>
        <p className="sp-hint" style={{ margin: "10px 0 13px" }}>Phòng có hợp đồng sắp hết hạn trong khoảng này sẽ được gắn nhãn "Sắp trống" trên trang công khai.</p>
        <div className="sp-step">
          <button onClick={() => set("soon_days", Math.max(0, form.soon_days - 1))}>–</button>
          <div className="box">
            <input type="number" value={form.soon_days}
              onChange={(e) => set("soon_days", Math.max(0, Math.min(365, Number(e.target.value) || 0)))} />
            <span>ngày</span>
          </div>
          <button onClick={() => set("soon_days", Math.min(365, form.soon_days + 1))}>+</button>
        </div>
      </div>

      {/* hotline picker */}
      <button className="sp-rowcard" onClick={() => setHotlineSheet(true)}>
        <span className="ic brand"><Phone size={18} /></span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span className="gv">Hotline hiển thị</span>
          <span className="gn">{hotlineName} · {hotlinePhone}</span>
        </span>
        <ChevronRight className="chev" size={20} />
      </button>

      {/* show_rented toggle */}
      <div className="sp-rowcard">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: "-.2px" }}>Hiện phòng đã thuê</div>
          <p className="sp-hint" style={{ margin: "3px 0 0" }}>Vẽ mờ phòng đã thuê trên sơ đồ để giữ đầy đủ bố cục tầng.</p>
        </div>
        <button className={"sp-switch" + (form.show_rented ? " on" : "")} aria-label="Hiện phòng đã thuê"
          onClick={() => set("show_rented", !form.show_rented)}>
          <span className="knob" />
        </button>
      </div>

      {/* preview */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".6px", color: "var(--ink-3)", margin: "0 0 9px", paddingLeft: 2 }}>Xem trước trên trang khách</div>
        <div className="sp-card" style={{ marginBottom: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontFamily: "var(--mono)", fontWeight: 700, fontSize: 15, letterSpacing: "-.3px" }}>102 · P.305</span>
            <span className="pill soon"><span className="bd" style={{ background: "var(--soon)" }} />Sắp trống · {form.soon_days} ngày</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 9 }}>
            <span style={{ fontFamily: "var(--mono)", fontWeight: 700, fontSize: 16, color: "var(--brand)" }}>4,5tr<span style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-3)" }}>/tháng</span></span>
            <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 600, color: "var(--ink-2)" }}>
              <Phone size={13} />{hotlinePhone}
            </span>
          </div>
        </div>
      </div>

      <button className="sp-save" onClick={() => upsertMut.mutate(form)} disabled={upsertMut.isPending}>Lưu cài đặt</button>

      <SaleSheet open={hotlineSheet} onClose={() => setHotlineSheet(false)}>
        <h3>Hotline hiển thị</h3>
        <p className="desc">Số hiển thị trên trang công khai khi phòng/toà không có liên hệ riêng.</p>
        <div className="sp-picklist">
          {list.length === 0 && <p className="desc">Chưa có hotline. Thêm ở mục Danh mục → Hotline.</p>}
          {list.map((h) => {
            const sel = (form.hotline_id ?? list[0]?.id) === h.id;
            return (
              <button key={h.id} className={"sp-pickitem" + (sel ? " sel" : "")}
                onClick={() => { set("hotline_id", h.id); setHotlineSheet(false); }}>
                <span className="tag" style={{ borderRadius: 10 }}><Phone size={17} /></span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="nm">{h.name}</span>
                  <span className="sub" style={{ fontFamily: "var(--mono)" }}>{h.phone_number}</span>
                </span>
                {sel && <Check size={20} stroke="var(--brand)" />}
              </button>
            );
          })}
        </div>
      </SaleSheet>
    </div>
  );
}
