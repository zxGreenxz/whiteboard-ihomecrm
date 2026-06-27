import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronDown, DoorOpen, Plus, Check, X, Images } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useBuildings, useUpdateBuilding } from "@/hooks/useBuildings";
import { useRooms } from "@/hooks/useRooms";
import SaleSheet from "./SaleSheet";
import MobileImageGrid from "./MobileImageGrid";

const toStrArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const tagOf = (s: string) => (s || "").trim().slice(0, 2).toUpperCase() || "—";

type Scope = "building" | "room";

export default function MobileSaleInfo() {
  const qc = useQueryClient();
  const { data: buildings } = useBuildings();
  const updateBuilding = useUpdateBuilding();

  const [buildingId, setBuildingId] = useState("");
  const [scope, setScope] = useState<Scope>("building");
  const [buildingSheet, setBuildingSheet] = useState(false);
  const [roomSheet, setRoomSheet] = useState(false);
  const [similarSheet, setSimilarSheet] = useState(false);

  const { data: rooms } = useRooms(buildingId || undefined);
  const [roomId, setRoomId] = useState("");

  // Building form
  const building = useMemo(() => (buildings ?? []).find((b) => b.id === buildingId), [buildings, buildingId]);
  const [bName, setBName] = useState("");
  const [bPhone, setBPhone] = useState("");
  const [bImages, setBImages] = useState<string[]>([]);
  useEffect(() => {
    setBName((building as any)?.public_contact_name ?? "");
    setBPhone((building as any)?.public_contact_phone ?? "");
    setBImages(toStrArr(building?.images));
  }, [building]);

  // Room form
  const room = useMemo(() => (rooms ?? []).find((r) => r.id === roomId), [rooms, roomId]);
  const roomsById = useMemo(() => new Map((rooms ?? []).map((r) => [r.id, r])), [rooms]);
  const [amenities, setAmenities] = useState<string[]>([]);
  const [rImages, setRImages] = useState<string[]>([]);
  const [similarIds, setSimilarIds] = useState<string[]>([]);
  const [amenDraft, setAmenDraft] = useState("");
  const [savingRoom, setSavingRoom] = useState(false);
  useEffect(() => {
    setAmenities(toStrArr(room?.amenities));
    setRImages(toStrArr(room?.images));
    setSimilarIds([]);
  }, [room]);
  useEffect(() => { setRoomId(""); }, [buildingId]);

  const addAmen = () => {
    const t = amenDraft.trim();
    if (t && !amenities.includes(t)) setAmenities((a) => [...a, t]);
    setAmenDraft("");
  };

  const similarRooms = similarIds.map((id) => roomsById.get(id)).filter((r): r is NonNullable<typeof r> => !!r);
  const similarOpts = (rooms ?? []).filter((r) => r.id !== roomId && !similarIds.includes(r.id));
  const addSimilar = (rid: string) => {
    const r = roomsById.get(rid);
    if (!r) return;
    const rHasImages = toStrArr(r.images).length > 0;
    if (rHasImages && rImages.length > 0) {
      toast.error(`Phòng ${r.name} đã có ảnh riêng — mỗi nhóm đồng bộ chỉ 1 phòng làm nguồn. Xoá ảnh phòng đó hoặc bỏ ảnh đang chọn.`);
      return;
    }
    setSimilarIds((prev) => [...prev, rid]);
    if (rHasImages && rImages.length === 0) setRImages(toStrArr(r.images));
    setSimilarSheet(false);
  };

  const saveBuilding = () => {
    if (!building) return;
    updateBuilding.mutate(
      { id: building.id, updates: { public_contact_name: bName.trim() || null, public_contact_phone: bPhone.trim() || null, images: bImages } as any },
      { onSuccess: () => qc.invalidateQueries({ queryKey: ["my-available-rooms"] }) },
    );
  };

  const saveRoom = async () => {
    if (!room) return;
    setSavingRoom(true);
    try {
      const { error: e1 } = await (supabase as any).from("rooms")
        .update({ amenities: amenities.length > 0 ? amenities : null, images: rImages }).eq("id", room.id);
      if (e1) throw e1;
      if (similarIds.length > 0) {
        const { error: e2 } = await (supabase as any).from("rooms").update({ images: rImages }).in("id", similarIds);
        if (e2) throw e2;
      }
      toast.success(similarIds.length > 0 ? `Đã lưu & đồng bộ ảnh cho ${similarIds.length + 1} phòng` : "Đã lưu thông tin phòng");
      qc.invalidateQueries({ queryKey: ["rooms"] });
      qc.invalidateQueries({ queryKey: ["buildings"] });
      qc.invalidateQueries({ queryKey: ["my-available-rooms"] });
    } catch (err) {
      toast.error("Không thể lưu: " + ((err as { message?: string })?.message ?? "lỗi không xác định"));
    } finally {
      setSavingRoom(false);
    }
  };

  return (
    <div style={{ padding: "14px 16px 28px" }}>
      {/* building picker */}
      <button className="sp-rowcard" style={{ borderRadius: 16, padding: "11px 13px", marginBottom: 13 }} onClick={() => setBuildingSheet(true)}>
        <span className="sp-btag" style={{ width: 38, height: 38, borderRadius: 11 }}>{tagOf(building?.name ?? "?")}</span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span className="gv">Toà nhà</span>
          <span className="gn">{building?.name ?? "Chọn toà nhà"}</span>
        </span>
        <ChevronDown className="chev" size={18} />
      </button>

      {/* scope segmented */}
      <div className="sp-pillseg" style={{ marginBottom: 15 }}>
        <button className={scope === "building" ? "on" : ""} onClick={() => setScope("building")}>Thông tin toà</button>
        <button className={scope === "room" ? "on" : ""} onClick={() => setScope("room")}>Thông tin phòng</button>
      </div>

      {!building ? (
        <div className="stub"><p>Chọn toà nhà để chỉnh sửa thông tin sale.</p></div>
      ) : scope === "building" ? (
        <>
          <div className="sp-card">
            <div className="sp-card-t" style={{ marginBottom: 11 }}>Liên hệ quản lý toà</div>
            <label className="sp-label">Người liên hệ</label>
            <input className="sp-input" style={{ marginBottom: 11 }} placeholder="VD: A. Tâm (QL toà)" value={bName} onChange={(e) => setBName(e.target.value)} />
            <label className="sp-label">Số điện thoại</label>
            <input className="sp-input mono" type="tel" inputMode="tel" placeholder="VD: 0901234567" value={bPhone} onChange={(e) => setBPhone(e.target.value)} />
            <p className="sp-hint">Ưu tiên hiển thị cho phòng thuộc toà này. Để trống sẽ dùng hotline chung ở "Cài đặt hiển thị".</p>
          </div>
          <div className="sp-card">
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 11 }}>
              <span className="sp-card-t">Ảnh bìa toà</span>
              <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--ink-3)" }}>· {bImages.length} ảnh</span>
            </div>
            <MobileImageGrid value={bImages} onChange={setBImages} />
          </div>
          <button className="sp-save" onClick={saveBuilding} disabled={updateBuilding.isPending}>Lưu thông tin toà nhà</button>
        </>
      ) : (
        <>
          {/* room picker */}
          <button className="sp-rowcard" style={{ borderRadius: 16, padding: "12px 13px" }} onClick={() => setRoomSheet(true)}>
            <span className="ic" style={{ background: "var(--acc-violet)", color: "#fff" }}><DoorOpen size={19} /></span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span className="gv">Phòng</span>
              <span className="gn">{room ? `${room.name}${room.code && room.code !== room.name ? ` · ${room.code}` : ""}` : "Chọn phòng"}</span>
            </span>
            <ChevronDown className="chev" size={18} />
          </button>

          {!room ? (
            <div className="stub"><p>Chọn phòng để chỉnh sửa nội thất, ảnh.</p></div>
          ) : (
            <>
              <div className="sp-card">
                <div className="sp-card-t" style={{ marginBottom: 11 }}>Nội thất</div>
                <div className="sp-addrow">
                  <input className="sp-input" placeholder="VD: Máy lạnh, Tủ lạnh, Giường…" value={amenDraft}
                    onChange={(e) => setAmenDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addAmen(); } }} />
                  <button className="sp-addbtn" onClick={addAmen}>Thêm</button>
                </div>
                {amenities.length === 0 ? (
                  <p className="sp-hint" style={{ margin: 0 }}>Chưa có nội thất. Danh sách này hiển thị ở mục "Nội thất" trong chi tiết phòng.</p>
                ) : (
                  <div className="sp-tags">
                    {amenities.map((a) => (
                      <span key={a} className="sp-tag">{a}<button onClick={() => setAmenities((v) => v.filter((x) => x !== a))}><X size={11} /></button></span>
                    ))}
                  </div>
                )}
              </div>

              <div className="sp-card">
                <div className="sp-card-t" style={{ marginBottom: 11 }}>Ảnh phòng</div>
                <MobileImageGrid value={rImages} onChange={setRImages} />
                <button className="sp-rowcard" style={{ margin: "12px 0 0", borderRadius: 12, borderStyle: "dashed", padding: "11px 13px" }} onClick={() => setSimilarSheet(true)}>
                  <span className="ic brand"><Images size={18} /></span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span className="gn" style={{ fontSize: 13.5 }}>Đồng bộ ảnh sang phòng tương tự</span>
                    <span className="gv" style={{ marginTop: 2 }}>{similarRooms.length > 0 ? `${similarRooms.length} phòng cùng mẫu` : "Dùng chung bộ ảnh trên"}</span>
                  </span>
                  <Plus className="chev" size={18} />
                </button>
                {similarRooms.length > 0 && (
                  <div className="sp-tags" style={{ marginTop: 10 }}>
                    {similarRooms.map((r) => (
                      <span key={r.id} className="sp-tag">{r.name}{r.code ? ` · ${r.code}` : ""}<button onClick={() => setSimilarIds((p) => p.filter((x) => x !== r.id))}><X size={11} /></button></span>
                    ))}
                  </div>
                )}
              </div>

              <button className="sp-save" onClick={saveRoom} disabled={savingRoom}>
                {savingRoom ? "Đang lưu…" : similarIds.length > 0 ? `Lưu & đồng bộ (${similarIds.length + 1} phòng)` : "Lưu thông tin phòng"}
              </button>
            </>
          )}
        </>
      )}

      {/* building picker sheet */}
      <SaleSheet open={buildingSheet} onClose={() => setBuildingSheet(false)}>
        <h3>Chọn toà nhà</h3>
        <div className="sp-picklist">
          {(buildings ?? []).map((b) => (
            <button key={b.id} className={"sp-pickitem" + (b.id === buildingId ? " sel" : "")} style={{ padding: "11px 13px" }}
              onClick={() => { setBuildingId(b.id); setBuildingSheet(false); }}>
              <span className="tag">{tagOf(b.name)}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="nm">{b.name}</span>
                {b.code && b.code !== b.name && <span className="sub">{b.code}</span>}
              </span>
              {b.id === buildingId && <Check size={20} stroke="var(--brand)" />}
            </button>
          ))}
        </div>
      </SaleSheet>

      {/* room picker sheet */}
      <SaleSheet open={roomSheet} onClose={() => setRoomSheet(false)}>
        <h3>Chọn phòng</h3>
        <div className="sp-picklist" style={{ gap: 8 }}>
          {(rooms ?? []).map((r) => (
            <button key={r.id} className={"sp-pickitem" + (r.id === roomId ? " sel" : "")} style={{ padding: "11px 13px" }}
              onClick={() => { setRoomId(r.id); setRoomSheet(false); }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="nm" style={{ fontFamily: "var(--mono)", fontSize: 13.5 }}>{r.name}{r.code && r.code !== r.name ? ` · ${r.code}` : ""}</span>
                <span className="sub">Tầng {r.floor}{toStrArr(r.images).length > 0 ? " · có ảnh" : ""}</span>
              </span>
              {r.id === roomId && <Check size={19} stroke="var(--brand)" />}
            </button>
          ))}
        </div>
      </SaleSheet>

      {/* similar room sheet */}
      <SaleSheet open={similarSheet} onClose={() => setSimilarSheet(false)}>
        <h3>Thêm phòng tương tự</h3>
        <p className="desc">Phòng cùng mẫu sẽ dùng chung bộ ảnh đang chọn khi lưu.</p>
        {similarOpts.length === 0 ? (
          <p className="desc" style={{ textAlign: "center", padding: "20px 0" }}>Không còn phòng khác trong toà.</p>
        ) : (
          <div className="sp-picklist" style={{ gap: 8 }}>
            {similarOpts.map((r) => (
              <button key={r.id} className="sp-pickitem" style={{ padding: "11px 13px" }} onClick={() => addSimilar(r.id)}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="nm" style={{ fontFamily: "var(--mono)", fontSize: 13.5 }}>{r.name}{r.code && r.code !== r.name ? ` · ${r.code}` : ""}</span>
                  <span className="sub">Tầng {r.floor}{toStrArr(r.images).length > 0 ? " · có ảnh" : ""}</span>
                </span>
                <span className="tag" style={{ width: 30, height: 30, borderRadius: 9, background: "var(--brand-50)" }}><Plus size={17} /></span>
              </button>
            ))}
          </div>
        )}
      </SaleSheet>
    </div>
  );
}
