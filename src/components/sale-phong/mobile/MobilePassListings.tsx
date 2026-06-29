import { useEffect, useMemo, useState } from "react";
import {
  Repeat, Phone, Tag, Calendar, Pencil, Eye, EyeOff, Trash2, ChevronDown, Users,
} from "lucide-react";
import {
  usePassListings, usePassListingFormRooms, usePassListingRoomCustomers,
  useUpsertPassListing, useSetPassListingActive, useDeletePassListing,
  type PassListing, type PassListingFormRoom,
} from "@/hooks/usePassListings";
import SaleSheet from "./SaleSheet";
import type { HeaderAction } from "./types";

const fmtVnd = (n: number | null | undefined) =>
  n == null ? "" : Math.round(n).toLocaleString("vi-VN");
const fmtDateStr = (s: string | null | undefined) =>
  s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.split("-").reverse().join("/") : "";

interface FormState {
  id: string | null;
  roomId: string;
  contactName: string;
  contactPhone: string;
  salePolicy: string;
  passPrice: string;
  availDate: string;
  active: boolean;
  contactManager: boolean;
}
const emptyForm: FormState = {
  id: null, roomId: "", contactName: "", contactPhone: "",
  salePolicy: "", passPrice: "", availDate: "", active: true, contactManager: false,
};

export default function MobilePassListings({ onHeaderAction }: { onHeaderAction: (a: HeaderAction | null) => void }) {
  const { data: listings, isLoading } = usePassListings();
  const { data: formRooms } = usePassListingFormRooms();
  const upsertMut = useUpsertPassListing();
  const activeMut = useSetPassListingActive();
  const deleteMut = useDeletePassListing();

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [deleting, setDeleting] = useState<PassListing | null>(null);
  const [roomSheet, setRoomSheet] = useState(false);

  const { data: roomCustomers = [] } = usePassListingRoomCustomers(open ? form.roomId : null);

  // Đổi phòng → điền sẵn SĐT/tên khách đại diện nếu đang trống.
  useEffect(() => {
    if (!open || !form.roomId || roomCustomers.length === 0) return;
    setForm((f) => {
      if (f.contactName.trim() || f.contactPhone.trim()) return f;
      const rep = roomCustomers.find((c) => c.is_representative) ?? roomCustomers[0];
      return { ...f, contactName: rep.full_name ?? "", contactPhone: rep.phone ?? "" };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCustomers, form.roomId, open]);

  const openCreate = () => { setForm(emptyForm); setOpen(true); };
  useEffect(() => {
    onHeaderAction({ label: "Thêm", onClick: openCreate });
    return () => onHeaderAction(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const roomById = useMemo(() => {
    const m = new Map<string, PassListingFormRoom>();
    (formRooms ?? []).forEach((r) => m.set(r.room_id, r));
    return m;
  }, [formRooms]);

  // Nhóm phòng theo toà cho picker.
  const roomGroups = useMemo(() => {
    const m = new Map<string, PassListingFormRoom[]>();
    (formRooms ?? []).forEach((r) => {
      const k = r.building_name ?? "—";
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    });
    return [...m.entries()];
  }, [formRooms]);

  const selectedRoom = form.roomId ? roomById.get(form.roomId) : undefined;
  const roomLabel = (r?: PassListingFormRoom) =>
    r ? `${r.building_name} · ${r.room_name}${r.room_code && r.room_code !== r.room_name ? ` (${r.room_code})` : ""}` : "Chọn phòng";

  const openEdit = (l: PassListing) => {
    setForm({
      id: l.id, roomId: l.room_id,
      contactName: l.contact_name ?? "", contactPhone: l.contact_phone ?? "",
      salePolicy: l.sale_policy ?? "",
      passPrice: l.pass_price != null ? String(l.pass_price) : "",
      availDate: l.avail_date ?? "", active: l.active,
      contactManager: l.contact_manager ?? false,
    });
    setOpen(true);
  };

  const doSave = () => {
    if (!form.roomId) return;
    const price = form.passPrice.replace(/[^\d]/g, "");
    upsertMut.mutate({
      id: form.id, roomId: form.roomId,
      contactName: form.contactName.trim() || null,
      contactPhone: form.contactPhone.trim() || null,
      salePolicy: form.salePolicy.trim() || null,
      passPrice: price ? Number(price) : null,
      availDate: form.availDate || null,
      active: form.active,
      contactManager: form.contactManager,
    }, { onSuccess: () => setOpen(false) });
  };

  const pickRep = () => {
    const rep = roomCustomers.find((c) => c.is_representative) ?? roomCustomers[0];
    if (rep) setForm((f) => ({ ...f, contactName: rep.full_name ?? "", contactPhone: rep.phone ?? "" }));
  };

  return (
    <div style={{ padding: "14px 16px 28px" }}>
      <div className="sp-note pink">
        <Repeat size={17} stroke="var(--pass)" />
        <p>Phòng đang có khách thuê nhưng khách <b>nhờ sale / pass phòng</b>. Hiện trên trang công khai (màu hồng) với SĐT của khách. Tắt khi khách dừng nhờ — không ảnh hưởng hợp đồng.</p>
      </div>

      {isLoading ? (
        <div className="stub"><p>Đang tải…</p></div>
      ) : !listings || listings.length === 0 ? (
        <div className="sp-empty pink">
          <span className="ic"><Repeat size={24} /></span>
          <p>Chưa có phòng khách nhờ sale. Bấm <b>Thêm</b> để đăng phòng pass.</p>
        </div>
      ) : (
        <div className="sp-list">
          {listings.map((l) => {
            const r = roomById.get(l.room_id);
            return (
              <div key={l.id} className={"sp-pcard" + (l.active ? "" : " off")}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="room">{r ? `${r.building_name} · ${r.room_name}` : "Phòng đã xoá"}</div>
                    <div className="rt">{r?.room_code && r.room_code !== r.room_name ? r.room_code : (r?.building_name ?? "")}</div>
                  </div>
                  <span className={"sp-badge " + (l.active ? "on" : "off")}><span className="dot" />{l.active ? "Đang hiện" : "Đang ẩn"}</span>
                </div>
                {l.contact_manager && (
                  <div className="ln" style={{ fontWeight: 600, color: "var(--pass)" }}>
                    <Phone size={14} stroke="var(--pass)" />
                    <span>Liên hệ quản lý — ẩn SĐT khách</span>
                  </div>
                )}
                {(l.contact_phone || l.contact_name) && (
                  <div className="ln">
                    <Phone size={14} stroke="var(--pass)" />
                    <span className="mono">{l.contact_phone || "—"}</span>
                    {l.contact_name && <span className="muted">{l.contact_name}</span>}
                  </div>
                )}
                {l.sale_policy && (
                  <div className="pol"><Tag size={14} stroke="var(--ink-3)" /><span>{l.sale_policy}</span></div>
                )}
                <div className="sp-pcard-f">
                  <span className="price">{l.pass_price != null ? fmtVnd(l.pass_price) : "theo giá phòng"}</span>
                  {l.avail_date && (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 600, color: "var(--ink-3)" }}>
                      <Calendar size={12} />{fmtDateStr(l.avail_date)}
                    </span>
                  )}
                  <span className="sp-acts">
                    <button className="sp-iconbtn" title="Sửa" onClick={() => openEdit(l)}><Pencil size={16} /></button>
                    <button className="sp-iconbtn" title={l.active ? "Ẩn" : "Hiện"} onClick={() => activeMut.mutate({ id: l.id, active: !l.active })}>
                      {l.active ? <EyeOff size={16} stroke="var(--soon)" /> : <Eye size={16} />}
                    </button>
                    <button className="sp-iconbtn danger" title="Xoá" onClick={() => setDeleting(l)}><Trash2 size={16} /></button>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* create / edit */}
      <SaleSheet open={open} onClose={() => setOpen(false)}>
        <h3>{form.id ? "Sửa phòng khách nhờ sale" : "Thêm phòng khách nhờ sale"}</h3>
        <p className="desc">Chọn phòng đang có khách, nhập SĐT + chính sách sale của khách.</p>

        <label className="sl">Phòng</label>
        <button className="sp-rowcard" style={{ marginBottom: 13, padding: "0 13px", height: 46 }} onClick={() => setRoomSheet(true)}>
          <span style={{ flex: 1, minWidth: 0, fontSize: 14.5, fontWeight: 600, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{roomLabel(selectedRoom)}</span>
          <ChevronDown className="chev" size={18} />
        </button>
        {selectedRoom && !selectedRoom.has_active_contract && (
          <p className="sp-hint" style={{ margin: "-8px 0 12px", color: "var(--soon)" }}>Phòng này hiện không có hợp đồng hiệu lực — vẫn đăng được nhưng kiểm tra lại.</p>
        )}

        <div style={{ display: "flex", gap: 10, marginBottom: 13 }}>
          <div style={{ flex: 1 }}>
            <label className="sl" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              SĐT khách
              {roomCustomers.length > 0 && (
                <button onClick={pickRep} title="Điền khách đại diện" style={{ border: 0, background: "transparent", color: "var(--brand)", cursor: "pointer", display: "inline-flex" }}><Users size={14} /></button>
              )}
            </label>
            <input className="sp-input mono" inputMode="tel" placeholder="0354 058 160" value={form.contactPhone}
              onChange={(e) => setForm((f) => ({ ...f, contactPhone: e.target.value }))} />
          </div>
          <div style={{ flex: 1 }}>
            <label className="sl">Tên khách</label>
            <input className="sp-input" placeholder="VD: Phúc" value={form.contactName}
              onChange={(e) => setForm((f) => ({ ...f, contactName: e.target.value }))} />
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, marginBottom: 13 }}>
          <div style={{ flex: 1 }}>
            <label className="sl">Giá pass (đ/tháng)</label>
            <input className="sp-input mono" inputMode="numeric" placeholder="Để trống = giá phòng" value={form.passPrice}
              onChange={(e) => setForm((f) => ({ ...f, passPrice: e.target.value }))} />
          </div>
          <div style={{ flex: 1 }}>
            <label className="sl">Ngày trống</label>
            <input className="sp-input" type="date" value={form.availDate}
              onChange={(e) => setForm((f) => ({ ...f, availDate: e.target.value }))} />
          </div>
        </div>

        <label className="sl">Chính sách sale (của khách)</label>
        <textarea className="sp-textarea" rows={2} style={{ marginBottom: 13 }}
          placeholder="VD: Giảm khách 500k tháng đầu hoặc thưởng sale 500k" value={form.salePolicy}
          onChange={(e) => setForm((f) => ({ ...f, salePolicy: e.target.value }))} />

        <div className="sp-rowcard" style={{ margin: 0, marginBottom: 10, borderRadius: 13, padding: "12px 14px" }}>
          <div style={{ flex: 1, paddingRight: 10 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700 }}>Liên hệ quản lý (ẩn SĐT khách)</div>
            <p className="sp-hint" style={{ margin: "2px 0 0" }}>Trang công khai hiện "Liên hệ quản lý" + SĐT QL của tòa, ẩn SĐT khách. SĐT khách vẫn lưu nội bộ.</p>
          </div>
          <button className={"sp-switch" + (form.contactManager ? " on" : "")} onClick={() => setForm((f) => ({ ...f, contactManager: !f.contactManager }))}><span className="knob" /></button>
        </div>

        <div className="sp-rowcard" style={{ margin: 0, marginBottom: 4, borderRadius: 13, padding: "12px 14px" }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700 }}>Hiển thị trên trang công khai</div>
            <p className="sp-hint" style={{ margin: "2px 0 0" }}>Tắt để tạm ẩn mà không xoá.</p>
          </div>
          <button className={"sp-switch" + (form.active ? " on" : "")} onClick={() => setForm((f) => ({ ...f, active: !f.active }))}><span className="knob" /></button>
        </div>

        <div className="sp-sheet-btns">
          <button className="cancel" onClick={() => setOpen(false)}>Hủy</button>
          <button className="ok" onClick={doSave} disabled={!form.roomId || upsertMut.isPending}>{form.id ? "Lưu" : "Thêm"}</button>
        </div>
      </SaleSheet>

      {/* room picker */}
      <SaleSheet open={roomSheet} onClose={() => setRoomSheet(false)}>
        <h3>Chọn phòng</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {roomGroups.map(([building, rooms]) => (
            <div key={building}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span className="tag" style={{ width: 26, height: 26, borderRadius: 8, background: "var(--brand-50)", color: "var(--brand)", display: "grid", placeItems: "center", fontFamily: "var(--mono)", fontWeight: 700, fontSize: 10, flexShrink: 0 }}>{building.slice(0, 2).toUpperCase()}</span>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink-2)" }}>{building}</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {rooms.map((r) => (
                  <button key={r.room_id} className="sp-pickitem" style={{ borderRadius: 11, padding: "10px 13px" }}
                    onClick={() => { setForm((f) => ({ ...f, roomId: r.room_id, contactName: "", contactPhone: "" })); setRoomSheet(false); }}>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span className="nm" style={{ fontFamily: "var(--mono)", fontSize: 13 }}>{r.room_name}{r.room_code && r.room_code !== r.room_name ? ` · ${r.room_code}` : ""}</span>
                      <span className="sub">{r.has_active_contract ? "Đang có khách" : "Phòng trống"}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </SaleSheet>

      {/* delete confirm */}
      <SaleSheet open={!!deleting} onClose={() => setDeleting(null)}>
        {deleting && (
          <>
            <span className="sp-confirm-ic danger"><Trash2 size={24} /></span>
            <h3 className="center">Xoá phòng khách nhờ sale?</h3>
            <p className="desc center">Phòng sẽ không còn hiển thị dạng "khách pass". Hợp đồng đang thuê KHÔNG bị ảnh hưởng. Muốn tạm ẩn thì dùng nút Ẩn.</p>
            <div className="sp-sheet-btns">
              <button className="cancel" onClick={() => setDeleting(null)}>Hủy</button>
              <button className="ok danger" onClick={() => { deleteMut.mutate(deleting.id); setDeleting(null); }}>Xoá</button>
            </div>
          </>
        )}
      </SaleSheet>
    </div>
  );
}
