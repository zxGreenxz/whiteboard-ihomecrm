import { useMemo, useState } from "react";
import { Calendar, Phone, Check, ChevronRight } from "lucide-react";
import {QueryRegion} from '@/components/errors/QueryRegion';
import {usePublicRoomSettingsDraft} from '../usePublicRoomSettingsDraft';
import SaleSheet from "./SaleSheet";
import { SALE_POLICY_MAX } from "@/lib/publicRoomFeedback";

export default function MobileDisplaySettings() {
  const {settings,hotlines:hotlineQuery,mutation:upsertMut,root,form,days,errors,writeError,canSave,set,changeDays,save}=usePublicRoomSettingsDraft();
  const hotlines=hotlineQuery.data;
  const [hotlineSheet,setHotlineSheet]=useState(false);

  const list = hotlines ?? [];
  const selected = useMemo(
    () => list.find((h) => h.id === form.hotline_id) ?? list[0],
    [list, form.hotline_id],
  );
  const hotlineName = selected?.name ?? "Mặc định";
  const hotlinePhone = selected?.phone_number ?? "—";


  return (
    <div ref={root} style={{ padding: "14px 16px 28px" }}><QueryRegion label="cài đặt hiển thị" queries={[settings,hotlineQuery]} skeleton="detail" rows={4}>
      <p className="sp-hint" style={{ margin: "0 0 14px" }}>Áp dụng chung cho mọi link chia sẻ của tài khoản.</p>

      {/* soon_days stepper */}
      <div className="sp-card">
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <span className="ic" style={{ width: 34, height: 34, borderRadius: 10, background: "var(--soonBg)", color: "var(--soon)", display: "grid", placeItems: "center", flexShrink: 0 }}>
            <Calendar size={18} />
          </span>
          <label htmlFor="mobile-soon-days" style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 700, letterSpacing: "-.2px" }}>Số ngày báo "sắp trống"</label>
        </div>
        <p className="sp-hint" style={{ margin: "10px 0 13px" }}>Phòng có hợp đồng sắp hết hạn trong khoảng này sẽ được gắn nhãn "Sắp trống" trên trang công khai.</p>
        <div className="sp-step">
          <button aria-label="Giảm số ngày" disabled={!/^\d+$/.test(days)||Number(days)<=0} onClick={()=>changeDays(String(Math.max(0,Number(days)-1)))}>–</button>
          <div className="box">
            <input id="mobile-soon-days" name="soon_days" type="text" inputMode="numeric" value={days} aria-invalid={!!errors.soon_days} aria-describedby={errors.soon_days?"mobile-soon-days-error":undefined} style={errors.soon_days?{border:"1px solid var(--bad, #dc2626)"}:undefined} onChange={e=>changeDays(e.target.value)}/>
            <span>ngày</span>
          </div>
          <button aria-label="Tăng số ngày" disabled={!/^\d+$/.test(days)||Number(days)>=365} onClick={()=>changeDays(String(Math.min(365,Number(days)+1)))}>+</button>
        </div>
      </div>

      {errors.soon_days&&<p id="mobile-soon-days-error" role="alert" className="text-destructive">{errors.soon_days}</p>}

      {/* hotline picker */}
      <button className="sp-rowcard" data-field-name="hotline_id" aria-invalid={!!errors.hotline_id} aria-describedby={errors.hotline_id?"mobile-hotline-error":undefined} onClick={() => setHotlineSheet(true)}>
        <span className="ic brand"><Phone size={18} /></span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span className="gv">Hotline chung cho tất cả nhà</span>
          <span className="gn">{hotlineName} · {hotlinePhone}</span>
        </span>
        <ChevronRight className="chev" size={20} />
      </button>

      {errors.hotline_id&&<p id="mobile-hotline-error" role="alert" className="text-destructive">{errors.hotline_id}</p>}

      {/* Chính sách sale chung — khối đầu ảnh "Danh sách phòng trống" */}
      <div className="sp-card">
        <label htmlFor="mobile-sale-policy" style={{ fontSize: 14, fontWeight: 700, letterSpacing: "-.2px" }}>Chính sách sale chung (in đầu ảnh)</label>
        <p className="sp-hint" style={{ margin: "6px 0 10px" }}>
          Mỗi dòng một ý (giá điện, nước, phí dịch vụ…), in ở khối trên đầu ảnh. SĐT riêng từng nhà và chính sách từng phòng điền ở bảng trên máy tính.
        </p>
        <textarea
          id="mobile-sale-policy" name="sale_policy" rows={4} maxLength={SALE_POLICY_MAX}
          value={form.sale_policy ?? ""} onChange={(e) => set("sale_policy", e.target.value)}
          placeholder={"Nước 100k/người, phí dịch vụ 150k/phòng\nXe free, Wifi free"}
          aria-invalid={!!errors.sale_policy} aria-describedby={errors.sale_policy ? "mobile-sale-policy-error" : undefined}
          style={{ width: "100%", boxSizing: "border-box", borderRadius: 10, border: `1px solid ${errors.sale_policy ? "var(--bad, #dc2626)" : "var(--line, #d4d4d8)"}`, padding: "9px 11px", fontSize: 14, fontFamily: "inherit", resize: "vertical" }}
        />
        {errors.sale_policy && <p id="mobile-sale-policy-error" role="alert" className="text-destructive">{errors.sale_policy}</p>}
      </div>

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

      {writeError&&<p role="alert" className="text-destructive">{writeError}</p>}
      <button className="sp-save" onClick={()=>void save()} disabled={upsertMut.isPending||!canSave}>Lưu cài đặt</button>

      <SaleSheet open={hotlineSheet} onClose={() => setHotlineSheet(false)}>
        <h3>Hotline chung cho tất cả nhà</h3>
        <p className="desc">Số in ở ô "Liên hệ admin" đầu ảnh và trên trang công khai. Nhà nào có số riêng thì điền ở bảng phòng trống trên máy tính.</p>
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
    </QueryRegion></div>
  );
}
