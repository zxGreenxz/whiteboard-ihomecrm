import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { Calendar, Check, ChevronDown, Copy, Download, Phone, Settings } from "lucide-react";
import { QueryRegion } from "@/components/errors/QueryRegion";
import { SkeletonBar } from "@/components/loading/LoadingState";
import { SALE_POLICY_MAX } from "@/lib/publicRoomFeedback";
import { autoStatusLines, buildRoomListTable, GROUP_BG, samePhone } from "@/pages/phong-trong/roomListTable";
import type { Room } from "@/pages/phong-trong/sampleData";
import { sheetKey } from "@/hooks/useSaveRoomListSheet";
import {
  amenitiesFallback, formatPriceInput, ownPhone, parseTypeCell, priceEditable, roomCellValue,
  ROOM_AMENITIES_MAX, ROOM_POLICY_MAX, ROOM_STATUS_MAX, ROOM_TYPE_MAX, type RoomField,
} from "../roomListSheetDraft";
import { useRoomListSheetDraft } from "../useRoomListSheetDraft";
import SaleSheet from "./SaleSheet";
import type { HeaderAction } from "./types";

type SheetKey = null | "settings" | "phone" | "preview" | "copy";
type TabKey = "policy" | Exclude<RoomField, "price">;
const FIELDS: { key: Exclude<RoomField, "price">; label: string; ph: string; max: number }[] = [
  { key: "type", label: "Loại phòng", ph: "VD: Phòng 20m², ban công", max: ROOM_TYPE_MAX + 20 },
  { key: "amenities", label: "Nội thất", ph: "VD: máy lạnh, tủ lạnh", max: ROOM_AMENITIES_MAX },
  { key: "status", label: "Tình trạng", ph: "", max: ROOM_STATUS_MAX },
];
const TABS: { key: TabKey; label: string }[] = [{ key: "policy", label: "Chính sách" }, ...FIELDS.map((f) => ({ key: f.key, label: f.label }))];
const ROOM_KEYS = ["policy", "price", "type", "amenities", "status"] as const;
const PILL: Record<string, string> = { soon: "soon", pass: "passc" };
/** Chính sách `src` (một hay nhiều dòng) đã nằm nguyên khối, đủ dòng, liên tiếp trong `cur` chưa. */
const hasLines = (cur: string, src: string) => {
  const c = cur.split("\n").map((l) => l.trim());
  const s = src.split("\n").map((l) => l.trim());
  return c.some((_, i) => s.every((l, j) => c[i + j] === l));
};

/**
 * Cài đặt hiển thị (mobile) — đủ nội dung bảng "điền như Excel" của desktop, cùng nguồn
 * dữ liệu (useRoomListSheetDraft): mỗi nhà một thẻ gập/mở với SĐT riêng; mỗi phòng sửa giá
 * (chạm 2 lần), chính sách (có sao chép sang phòng khác), loại phòng, nội thất, tình trạng.
 * Cài đặt chung (sắp trống, hotline, chính sách chung, phòng đã thuê) nằm sau nút bánh răng.
 */
export default function MobileDisplaySettings({ onHeaderAction }: { onHeaderAction?: (a: HeaderAction | null) => void }) {
  const sheet = useRoomListSheetDraft();
  // Không gắn `root`: ô lỗi có thể nằm trong sheet (portal ra .cm-app, ngoài khung này) nên tìm ô cần focus trên cả trang.
  const { settings, hotlines: hotlineQuery, form, days, errors, writeError, canSave, set, changeDays, rooms, edits, cellErrors } = sheet;

  const [open, setOpen] = useState<SheetKey>(null);
  const [openBld, setOpenBld] = useState<string | null | undefined>(undefined);
  const [phoneEdit, setPhoneEdit] = useState<{ id: string; address: string; value: string } | null>(null);
  const [priceEdit, setPriceEdit] = useState<string | null>(null);
  const [tab, setTab] = useState<Record<string, TabKey>>({}); // mỗi phòng mở đúng 1 tab, mặc định Chính sách
  const [copyFrom, setCopyFrom] = useState<{ id: string; code: string; address: string; policy: string } | null>(null);
  const [picks, setPicks] = useState<Set<string>>(new Set());
  const [replace, setReplace] = useState(false);
  const [toast, setToast] = useState("");
  const [image, setImage] = useState<{ url: string } | { error: string } | null>(null);
  const lastTap = useRef<{ id: string; at: number } | null>(null);

  // Nút bánh răng trên app-bar → sheet "Cài đặt chung".
  useEffect(() => {
    onHeaderAction?.({ label: "Cài đặt chung", icon: Settings, iconOnly: true, onClick: () => setOpen("settings") });
    return () => onHeaderAction?.(null);
  }, [onHeaderAction]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  // Bảng dựng từ bản nháp như ảnh: chỉ phòng còn chào, đúng thứ tự và chữ ảnh sẽ in.
  const table = useMemo(() => buildRoomListTable(sheet.preview), [sheet.preview]);
  const byBuilding = useMemo(() => new Map(sheet.buildings.map((b) => [b.id, b])), [sheet.buildings]);
  const byRoom = useMemo(() => new Map<string, Room>(sheet.buildings.flatMap((b) => b.rooms.map((r) => [r.id, r]))), [sheet.buildings]);
  const roomCount = table.totalRooms;

  // Lưu bị chặn vì ô sai → đóng sheet, mở đúng nhà/tab có ô đó. Chỉ chạy ngay sau một lần bấm Lưu
  // (gõ sửa ô cũng đổi cellErrors — không được kéo người dùng khỏi ô đang gõ).
  const revealAfterSave = useRef(false);
  useEffect(() => {
    if (!revealAfterSave.current) return;
    revealAfterSave.current = false;
    const first = Object.entries(cellErrors).find(([, msg]) => msg)?.[0];
    if (!first) return;
    setOpen(null);
    const [kind = "", id = ""] = first.split(":");
    if (kind === "phone") { setOpenBld(id); return; }
    const room = byRoom.get(id);
    if (!room) return;
    setOpenBld(room.buildingId);
    if (kind === "price") setPriceEdit(id);
    else if (kind === "policy" || kind === "type" || kind === "amenities" || kind === "status") setTab((m) => ({ ...m, [id]: kind }));
  }, [cellErrors, byRoom]);
  const submit = async () => {
    if (sheet.busy) return false;
    revealAfterSave.current = true;
    try { return await sheet.saveAll(); } finally { revealAfterSave.current = false; }
  };
  useEffect(() => {
    if (errors.soon_days || errors.hotline_id || errors.sale_policy) setOpen("settings");
  }, [errors.soon_days, errors.hotline_id, errors.sale_policy]);

  const hotlinePhone = sheet.hotlinePhone.trim();
  const phoneState = (v: string) => {
    if (!v.trim()) return { own: false, hint: hotlinePhone ? `Để trống — dùng hotline chung ${hotlinePhone}` : "Để trống — dùng hotline chung" };
    if (hotlinePhone && samePhone(v, hotlinePhone)) return { own: false, hint: "Trùng hotline — ảnh không in lại" };
    return { own: true, hint: "Ảnh in riêng số này dưới địa chỉ nhà" };
  };
  const phoneOf = (id: string) => {
    const b = byBuilding.get(id);
    return edits.phones[id] ?? (b ? ownPhone(b) : "");
  };
  const policyOf = (r: Room) => edits.policies[r.id] ?? r.saleNote ?? "";

  const activeBld = openBld === undefined ? table.groups[0]?.buildingId ?? null : openBld;
  const hotlines = sheet.hotlineList.filter((h) => h.is_active !== false || h.id === form.hotline_id);

  const targets = useMemo(() => (copyFrom
    ? table.groups.map((g) => ({ ...g, rows: g.rows.filter((r) => r.roomId !== copyFrom.id) })).filter((g) => g.rows.length)
    : []), [table, copyFrom]);
  const targetIds = targets.flatMap((g) => g.rows.map((r) => r.roomId));
  const allPicked = targetIds.length > 0 && targetIds.every((id) => picks.has(id));

  const openCopy = (room: Room, code: string, address: string) => {
    const policy = policyOf(room).trim();
    if (!policy) return;
    setCopyFrom({ id: room.id, code, address, policy }); setPicks(new Set()); setReplace(false); setOpen("copy");
  };
  const togglePick = (id: string) => setPicks((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const applyCopy = () => {
    if (!copyFrom || picks.size === 0) return;
    let changed = 0;
    for (const id of picks) {
      const room = byRoom.get(id);
      if (!room) continue;
      const cur = policyOf(room).trim();
      // Mặc định BỔ SUNG xuống dòng dưới; bỏ qua nếu phòng đã có đúng dòng này.
      const next = replace || !cur ? copyFrom.policy : hasLines(cur, copyFrom.policy) ? cur : `${cur}\n${copyFrom.policy}`;
      if (next !== policyOf(room)) { sheet.setPolicy(id, next); changed++; }
    }
    const same = picks.size - changed;
    setToast(changed
      ? `Đã ${replace ? "thay thế" : "bổ sung"} chính sách cho ${changed} phòng${same ? ` · ${same} phòng đã có` : ""} · chưa lưu`
      : "Các phòng đã chọn đều có sẵn chính sách này");
    setOpen(null);
  };

  const closePhone = (value: string | null) => {
    if (phoneEdit && value !== null) sheet.setPhone(phoneEdit.id, value);
    setPhoneEdit(null); setOpen(null);
  };

  // Ảnh xem trước: vẽ bằng đúng hàm của nút Tải ảnh, mỗi lần mở sheet.
  const openPreview = async () => {
    setPriceEdit(null); setImage(null); setOpen("preview");
    try {
      const { drawRoomListImage } = await import("@/pages/phong-trong/exportRoomListImage");
      setImage({ url: table.totalRooms ? drawRoomListImage(table).toDataURL("image/png") : "" });
    } catch {
      setImage({ error: "Không vẽ được ảnh xem trước. Thử lại nhé." });
    }
  };

  const tapPrice = (id: string) => {
    const now = Date.now();
    if (lastTap.current?.id === id && now - lastTap.current.at < 400) { setPriceEdit(id); lastTap.current = null; }
    else lastTap.current = { id, at: now };
  };

  const appHost = typeof document !== "undefined" ? document.querySelector(".cm-app") ?? document.body : null;
  const pes = phoneEdit ? phoneState(phoneEdit.value) : null;
  const err = (name: string) => (cellErrors[name] ? <p id={`${name}-error`} role="alert" className="sp-err">{cellErrors[name]}</p> : null);

  return (
    <div style={{ padding: "14px 16px 28px" }}><QueryRegion label="cài đặt hiển thị" queries={[settings, hotlineQuery]} skeleton="detail" rows={4}>
      <div className="sp-sec">Từng nhà &amp; phòng<span className="cnt">{table.groups.length} nhà · {roomCount} phòng</span></div>
      <p className="sp-hint" style={{ margin: "0 0 12px", padding: "0 2px" }}>
        Bấm nút điện thoại ở mỗi nhà để đặt SĐT riêng, không đặt thì dùng hotline chung. Chạm 2 lần vào giá để sửa.
        Mỗi phòng có 4 tab thông tin, chấm xanh là tab đã điền. Lưu là sửa thẳng dữ liệu phòng.
      </p>

      <QueryRegion label="danh sách phòng trống" queries={[rooms]} skeleton="list" rows={4}>
        {table.groups.length === 0 && (
          <div className="sp-card"><p className="sp-hint" style={{ margin: 0 }}>Hiện không có phòng trống, sắp trống hay khách pass nào để đưa vào ảnh.</p></div>
        )}
        {table.groups.map((g, gi) => {
          const isOpen = activeBld === g.buildingId;
          const phone = phoneOf(g.buildingId);
          const ps = phoneState(phone);
          const withPolicy = g.rows.filter((r) => r.policy.trim()).length;
          const lift = byBuilding.get(g.buildingId)?.liftLabel?.trim().toLowerCase();
          const sub = [lift, `${g.rows.length} phòng`, `${withPolicy}/${g.rows.length} có chính sách riêng`].filter(Boolean).join(" · ");
          const toggle = () => { setOpenBld(isOpen ? null : g.buildingId); setPriceEdit(null); };
          return (
            <div key={g.buildingId} className={"sp-bacc" + (isOpen ? " open" : "")}>
              <div className="sp-bacc-h" role="button" tabIndex={0} aria-expanded={isOpen} onClick={toggle}
                onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggle(); } }}>
                <span className="no" style={{ background: GROUP_BG[gi % GROUP_BG.length] }}>{gi + 1}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="ad">{g.address}</span>
                  <span className="sub">{sub}</span>
                  <button type="button" className={"sp-phonepill" + (ps.own ? " own" : "")} aria-label={`SĐT riêng của nhà ${g.address}`}
                    aria-invalid={!!cellErrors[sheetKey.phone(g.buildingId)]}
                    onClick={(e) => { e.stopPropagation(); setPhoneEdit({ id: g.buildingId, address: g.address, value: phone }); setOpen("phone"); }}>
                    <Phone size={14} />{ps.own ? phone.trim() : "Dùng hotline"}
                  </button>
                  {err(sheetKey.phone(g.buildingId))}
                </span>
                <ChevronDown className="chev" size={20} />
              </div>
              {isOpen && g.rows.map((row) => {
                const room = byRoom.get(row.roomId);
                if (!room) return null;
                const editing = priceEdit === room.id;
                const price = roomCellValue(room, "price", edits);
                const cur = tab[room.id] ?? "policy";
                const fd = FIELDS.find((x) => x.key === cur);
                const filled: Record<TabKey, boolean> = {
                  policy: !!policyOf(room).trim(),
                  type: !!roomCellValue(room, "type", edits).trim(),
                  amenities: !!roomCellValue(room, "amenities", edits).trim(),
                  status: !!roomCellValue(room, "status", edits).trim(),
                };
                const passPolicy = room.status === "pass" ? room.passSalePolicy?.trim() : "";
                const fieldValue = fd ? roomCellValue(room, fd.key, edits) : "";
                const fieldName = fd ? sheetKey.field(fd.key, room.id) : "";
                return (
                  <div key={room.id} className="sp-room">
                    <div className="sp-room-h">
                      <span className="code">{row.code}</span>
                      {editing ? (
                        <input className="sp-priceedit" autoFocus inputMode="numeric" name={sheetKey.field("price", room.id)} disabled={sheet.busy}
                          aria-label={`Giá phòng ${row.code}`} value={price} maxLength={13}
                          aria-invalid={!!cellErrors[sheetKey.field("price", room.id)]}
                          onChange={(e) => sheet.setRoomField("price", room.id, formatPriceInput(e.target.value))}
                          onBlur={() => setPriceEdit(null)}
                          onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur(); }} />
                      ) : priceEditable(room) ? (
                        <button type="button" className={"price" + (price ? "" : " empty")} title="Chạm 2 lần để sửa giá"
                          aria-label={`Giá phòng ${row.code}: ${price || "chưa có"} — chạm 2 lần để sửa`}
                          onClick={() => tapPrice(room.id)}
                          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); setPriceEdit(room.id); } }}>
                          {price || "Chưa có giá"}
                        </button>
                      ) : (
                        <span className="price" style={{ borderBottom: 0, cursor: "default" }} title="Giá khách pass — sửa ở Khách nhờ sale">{row.price || "Chưa có giá"}</span>
                      )}
                      <span className={"pill " + (PILL[room.status] ?? "free")}><span className="bd" />{row.status.join(" · ")}</span>
                    </div>
                    {err(sheetKey.field("price", room.id))}
                    <div className="sp-room-meta">{[row.type, row.amenities].filter(Boolean).join(" · ") || "—"}</div>
                    <div className="sp-rtabs" role="tablist" aria-label={`Thông tin phòng ${row.code}`}>
                      {TABS.map((x) => (
                        <button key={x.key} type="button" role="tab" aria-selected={cur === x.key} className={cur === x.key ? "on" : ""}
                          onClick={() => setTab((m) => ({ ...m, [room.id]: x.key }))}>
                          {x.label}{filled[x.key] && <i aria-hidden="true" />}
                        </button>
                      ))}
                    </div>
                    {cur === "policy" ? (
                      <div className="sp-polrow">
                        <textarea name={sheetKey.policy(room.id)} maxLength={ROOM_POLICY_MAX} disabled={sheet.busy}
                          rows={Math.max(1, policyOf(room).split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 34)), 0))}
                          placeholder={passPolicy ? `Khách pass: ${passPolicy}` : "Chính sách riêng phòng"} aria-label={`Chính sách sale phòng ${row.code}`}
                          aria-invalid={!!cellErrors[sheetKey.policy(room.id)]}
                          value={policyOf(room)} onChange={(e) => sheet.setPolicy(room.id, e.target.value)} />
                        <button type="button" className="sp-iconbtn" disabled={!policyOf(room).trim()} aria-label={`Sao chép chính sách phòng ${row.code} sang phòng khác`}
                          title="Sao chép sang phòng khác" onClick={() => openCopy(room, row.code, g.address)}>
                          <Copy size={17} />
                        </button>
                      </div>
                    ) : fd && (
                      <>
                        <div className="sp-fieldrow">
                          <input className="sp-rfield" name={fieldName} maxLength={fd.max} disabled={sheet.busy}
                            placeholder={fd.key === "status" ? `Tự tính: ${autoStatusLines(room).join(" · ")}`
                              : fd.key === "amenities" && amenitiesFallback(room) ? `Đang in mô tả: ${amenitiesFallback(room)}` : fd.ph}
                            aria-label={`${fd.label} phòng ${row.code}`} aria-invalid={!!cellErrors[fieldName]}
                            value={fieldValue} onChange={(e) => sheet.setRoomField(fd.key, room.id, e.target.value)} />
                        </div>
                        {fd.key === "type" && edits.types[room.id] !== undefined && room.area > 0 && parseTypeCell(fieldValue).area === null && (
                          <p className="sp-hint" style={{ marginTop: 6 }}>Không thấy "Phòng Nm²" — giữ diện tích {room.area}m²</p>
                        )}
                        {fd.key === "status" && !fieldValue.trim() && (
                          <p className="sp-hint" style={{ marginTop: 6 }}>Để trống thì tự tính theo hợp đồng.</p>
                        )}
                      </>
                    )}
                    {ROOM_KEYS.filter((k) => k !== "price").map((k) => <span key={k}>{err(`${k}:${room.id}`)}</span>)}
                  </div>
                );
              })}
            </div>
          );
        })}
      </QueryRegion>

      {writeError && open !== "settings" && <p role="alert" className="sp-err">{writeError}</p>}
      {sheet.sheetWriteError && open !== "settings" && <p role="alert" className="sp-err">{sheet.sheetWriteError}</p>}

      <div className="sp-footer">
        <button type="button" className="ghost" onClick={() => void openPreview()} disabled={!rooms.data}><Download size={16} />Xem trước ảnh</button>
        <button type="button" className="sp-save" onClick={() => void submit()} disabled={sheet.busy || !canSave}>Lưu cài đặt</button>
      </div>

      {/* Cài đặt chung (nút bánh răng) */}
      <SaleSheet open={open === "settings"} onClose={() => setOpen(null)}
        footer={<button type="button" className="sp-save" disabled={sheet.busy || !canSave}
          onClick={async () => { if (await submit()) setOpen(null); }}>Lưu cài đặt</button>}>
        <h3>Cài đặt chung</h3>
        <p className="desc">Áp dụng chung cho mọi link chia sẻ của tài khoản và cho ảnh "Danh sách phòng trống" (nút Tải ảnh, tin gửi Zalo).</p>

        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <span style={{ width: 34, height: 34, borderRadius: 10, background: "var(--soonBg)", color: "var(--soon)", display: "grid", placeItems: "center", flexShrink: 0 }}><Calendar size={18} /></span>
          <label htmlFor="mobile-soon-days" style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 700, letterSpacing: "-.2px" }}>Số ngày báo "sắp trống"</label>
        </div>
        <p className="sp-hint" style={{ margin: "10px 0 13px" }}>Phòng có hợp đồng sắp hết hạn trong khoảng này sẽ được gắn nhãn "Sắp trống" trên trang công khai. Mặc định 30 ngày.</p>
        <div className="sp-step">
          <button type="button" aria-label="Giảm số ngày" disabled={!/^\d+$/.test(days) || Number(days) <= 0} onClick={() => changeDays(String(Math.max(0, Number(days) - 1)))}>–</button>
          <div className="box">
            <input id="mobile-soon-days" name="soon_days" type="text" inputMode="numeric" value={days} aria-invalid={!!errors.soon_days}
              aria-describedby={errors.soon_days ? "mobile-soon-days-error" : undefined}
              style={errors.soon_days ? { border: "1px solid var(--red)" } : undefined} onChange={(e) => changeDays(e.target.value)} />
            <span>ngày</span>
          </div>
          <button type="button" aria-label="Tăng số ngày" disabled={!/^\d+$/.test(days) || Number(days) >= 365} onClick={() => changeDays(String(Math.min(365, Number(days) + 1)))}>+</button>
        </div>
        {errors.soon_days && <p id="mobile-soon-days-error" role="alert" className="sp-err">{errors.soon_days}</p>}

        <div className="sp-sheet-sep" />
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <span style={{ width: 34, height: 34, borderRadius: 10, background: "var(--brand-50)", color: "var(--brand)", display: "grid", placeItems: "center", flexShrink: 0 }}><Phone size={18} /></span>
          <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 700, letterSpacing: "-.2px" }}>Hotline chung cho tất cả nhà</span>
        </div>
        <p className="sp-hint" style={{ margin: "10px 0 12px" }}>In ở góc trên trái ảnh và hiển thị trên trang công khai khi nhà không có SĐT riêng.</p>
        <div className="sp-picklist" data-field-name="hotline_id" aria-invalid={!!errors.hotline_id}>
          {hotlines.length === 0 && <p className="desc">Chưa có hotline. Thêm ở Quản lý danh sách hotline.</p>}
          {hotlines.map((h) => {
            const sel = sheet.currentHotline?.id === h.id;
            return (
              <button key={h.id} type="button" className={"sp-pickitem" + (sel ? " sel" : "")} aria-pressed={sel} onClick={() => sheet.pickHotline(h.id)}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="nm">{h.name || "Hotline"}</span>
                  <span className="sub" style={{ fontFamily: "var(--mono)" }}>{h.phone_number}{h.is_active === false ? " (đang tắt)" : ""}</span>
                </span>
                {sel && <Check size={20} stroke="var(--brand)" />}
              </button>
            );
          })}
        </div>
        {errors.hotline_id && <p role="alert" className="sp-err">{errors.hotline_id}</p>}
        <Link to="/settings/categories/hotlines" style={{ display: "inline-block", marginTop: 12, fontSize: 13, fontWeight: 600, color: "var(--brand-600)", textDecoration: "underline" }}>
          Quản lý danh sách hotline
        </Link>

        <div className="sp-sheet-sep" />
        <label htmlFor="mobile-sale-policy" style={{ display: "block", fontSize: 14, fontWeight: 700, letterSpacing: "-.2px" }}>Chính sách sale chung (in đầu ảnh)</label>
        <p className="sp-hint" style={{ margin: "6px 0 12px" }}>Mỗi dòng một ý, in ngay dưới dòng giá điện.</p>
        <textarea id="mobile-sale-policy" name="sale_policy" className="sp-textarea" rows={7} maxLength={SALE_POLICY_MAX}
          value={form.sale_policy ?? ""} onChange={(e) => set("sale_policy", e.target.value)}
          aria-invalid={!!errors.sale_policy} aria-describedby={errors.sale_policy ? "mobile-sale-policy-error" : undefined} />
        {errors.sale_policy && <p id="mobile-sale-policy-error" role="alert" className="sp-err">{errors.sale_policy}</p>}

        <div className="sp-sheet-sep" />
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: "-.2px" }}>Hiện phòng đã thuê</div>
            <p className="sp-hint" style={{ margin: "3px 0 0" }}>Vẽ mờ phòng đã thuê trên sơ đồ để giữ đầy đủ bố cục tầng.</p>
          </div>
          <button type="button" role="switch" aria-checked={form.show_rented} className={"sp-switch" + (form.show_rented ? " on" : "")}
            aria-label="Hiện phòng đã thuê" onClick={() => set("show_rented", !form.show_rented)}><span className="knob" /></button>
        </div>
        {writeError && <p role="alert" className="sp-err">{writeError}</p>}
        {sheet.sheetWriteError && <p role="alert" className="sp-err">{sheet.sheetWriteError}</p>}
      </SaleSheet>

      {/* SĐT riêng của nhà */}
      <SaleSheet open={open === "phone" && !!phoneEdit} onClose={() => closePhone(null)}>
        {phoneEdit && pes && (
          <>
            <h3>SĐT riêng của nhà</h3>
            <p className="desc">{phoneEdit.address}</p>
            <input className="sp-input mono" autoFocus type="tel" inputMode="tel" aria-label="SĐT riêng của nhà" placeholder={hotlinePhone || "Số điện thoại"}
              value={phoneEdit.value} onChange={(e) => setPhoneEdit({ ...phoneEdit, value: e.target.value })} />
            <p className={"sp-hint" + (pes.own ? " own" : "")} style={{ marginTop: 8 }}>{pes.hint}</p>
            <div className="sp-sheet-btns">
              <button type="button" className="cancel" onClick={() => closePhone("")}>Dùng hotline</button>
              <button type="button" className="ok" onClick={() => closePhone(phoneEdit.value.trim())}>Lưu số này</button>
            </div>
          </>
        )}
      </SaleSheet>

      {/* Xem trước ảnh */}
      <SaleSheet open={open === "preview"} onClose={() => setOpen(null)}>
        <h3>Xem trước ảnh</h3>
        <p className="desc">Ảnh tải về in đúng như bảng này. Chưa lưu thì ảnh vẫn dùng nội dung đang sửa.</p>
        <div className="sp-imgprev">
          {image === null ? <SkeletonBar className="h-48" style={{ width: "100%" }} />
            : "error" in image ? <p role="alert">{image.error}</p>
            : image.url ? <img src={image.url} alt="Danh sách phòng trống" />
            : <p>Hiện chưa có phòng trống để xuất ảnh.</p>}
        </div>
        <div className="sp-sheet-btns">
          <button type="button" className="cancel" onClick={() => setOpen(null)}>Đóng</button>
          <button type="button" className="ok" disabled={sheet.exporting || !table.totalRooms}
            onClick={() => { void sheet.exportPreview(); setOpen(null); }}
            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
            <Download size={17} />Tải ảnh
          </button>
        </div>
      </SaleSheet>

      {/* Sao chép chính sách */}
      <SaleSheet open={open === "copy" && !!copyFrom} onClose={() => setOpen(null)}
        footer={copyFrom && (
          <>
            <button type="button" className="sp-replace" role="checkbox" aria-checked={replace} onClick={() => setReplace((v) => !v)}>
              <span className={"sp-checkbox" + (replace ? " on" : "")}>{replace && <Check size={14} strokeWidth={3} />}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <b>Thay thế chính sách cũ</b>
                <span className="h">{replace ? "Xoá chính sách đang có của phòng được chọn, chỉ giữ chính sách mới." : "Đang tắt: chính sách mới được bổ sung xuống dòng dưới chính sách đang có."}</span>
              </span>
            </button>
            <div className="sp-sheet-btns">
              <button type="button" className="cancel" onClick={() => setOpen(null)}>Hủy</button>
              <button type="button" className="ok" disabled={picks.size === 0} onClick={applyCopy}>{picks.size ? `Sao chép cho ${picks.size} phòng` : "Chọn phòng nhận"}</button>
            </div>
          </>
        )}>
        {copyFrom && (
          <>
            <h3>Sao chép chính sách</h3>
            <p className="desc" style={{ marginBottom: 12 }}>
              Từ phòng <b style={{ fontFamily: "var(--mono)", color: "var(--ink-2)" }}>{copyFrom.code}</b> · {copyFrom.address}
            </p>
            <div className="sp-copysrc">{copyFrom.policy}</div>
            <div className="sp-copyhd">
              <span className="sl">Chọn phòng nhận</span>
              <button type="button" onClick={() => setPicks(allPicked ? new Set() : new Set(targetIds))}>{allPicked ? "Bỏ chọn" : "Chọn tất cả"}</button>
            </div>
            {targets.map((g) => (
              <div key={g.buildingId} className="sp-copygrp">
                <div className="sp-copygrp-h"><i style={{ background: GROUP_BG[table.groups.findIndex((x) => x.buildingId === g.buildingId) % GROUP_BG.length] }} /><span>{g.address}</span></div>
                {g.rows.map((r) => {
                  const sel = picks.has(r.roomId);
                  const room = byRoom.get(r.roomId);
                  const current = room ? policyOf(room).trim() : "";
                  return (
                    <button key={r.roomId} type="button" role="checkbox" aria-checked={sel} className={"sp-pickitem" + (sel ? " sel" : "")} onClick={() => togglePick(r.roomId)}>
                      <span className={"sp-checkbox" + (sel ? " on" : "")}>{sel && <Check size={14} strokeWidth={3} />}</span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span className="nm" style={{ fontFamily: "var(--mono)" }}>{r.code}</span>
                        <span className="sub clip">{current ? current.replace(/\n/g, " · ") : "Chưa có chính sách"}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </>
        )}
      </SaleSheet>

      {toast && appHost && createPortal(<div className="sp-toast" role="status">{toast}</div>, appHost)}
    </QueryRegion></div>
  );
}
