import React, { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import "./phongTrong.css";
import { Icon } from "./icons";
import { Summary, FilterBar, FloorPlan, ListView, PRICE_BANDS } from "./PhongTrongParts";
import { DetailSheet, Toast } from "./PhongTrongSheet";
import { buildingsFromRpc, MANAGER, type Room } from "./sampleData";
import { usePhongTrong } from "@/hooks/usePhongTrong";

/**
 * Trang công khai "Phòng trống" cho Sale (/r/:token).
 * Dữ liệu thật qua RPC public get_public_available_rooms (xem usePhongTrong);
 * map sang type Building/Room bằng buildingsFromRpc — giữ NGUYÊN toàn bộ UI bên dưới.
 */

/** Màn trạng thái (loading / lỗi token / rỗng) dùng chung khung điện thoại. */
function StatusScreen({ icon, title, sub }: { icon: string; title: string; sub?: string }) {
  return (
    <div id="stage">
      <div className="app" style={{ justifyContent: "center", alignItems: "center" }}>
        <div className="empty">
          <div className="e-ic">{icon}</div>
          <p>
            <strong>{title}</strong>
            {sub && <><br />{sub}</>}
          </p>
        </div>
      </div>
    </div>
  );
}

export default function PhongTrongPage() {
  const { token } = useParams<{ token: string }>();
  const { data, isLoading, error } = usePhongTrong(token);

  const buildings = useMemo(() => buildingsFromRpc(data), [data]);
  const contact = useMemo(() => {
    const c = data?.contact;
    return c ? { name: c.name, phone: c.phone, zalo: c.phone.replace(/\D/g, "") } : MANAGER;
  }, [data]);

  const [propId, setPropId] = useState("");
  const [view, setView] = useState<"map" | "list">("map");
  const [showRented, setShowRented] = useState(false);
  const [band, setBand] = useState("all");

  const [room, setRoom] = useState<Room | null>(null);
  const [sheetShow, setSheetShow] = useState(false);
  const [toast, setToast] = useState({ msg: "", show: false });
  const toastTimer = useRef<number | undefined>(undefined);
  const propsRef = useRef<HTMLDivElement>(null);

  const [saved, setSaved] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("pt_saved") || "[]"); } catch { return []; }
  });
  useEffect(() => { localStorage.setItem("pt_saved", JSON.stringify(saved)); }, [saved]);
  const toggleSave = (id: string) =>
    setSaved((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  // Chọn toà đầu khi data về / đổi; giữ lựa chọn nếu vẫn còn trong danh sách.
  useEffect(() => {
    if (!buildings.length) return;
    if (!buildings.some((b) => b.id === propId)) setPropId(buildings[0].id);
  }, [buildings, propId]);

  // Kéo ngang hàng cơ sở: vuốt trên mobile (native) + kéo chuột trên desktop.
  useEffect(() => {
    const el = propsRef.current;
    if (!el) return;
    let down = false, startX = 0, startScroll = 0, moved = false;
    const onDown = (e: MouseEvent) => { down = true; moved = false; startX = e.pageX; startScroll = el.scrollLeft; el.classList.add("dragging"); };
    const onMove = (e: MouseEvent) => {
      if (!down) return;
      const dx = e.pageX - startX;
      if (Math.abs(dx) > 4) moved = true;
      el.scrollLeft = startScroll - dx;
    };
    const onUp = () => { down = false; el.classList.remove("dragging"); };
    const onClick = (e: MouseEvent) => { if (moved) { e.preventDefault(); e.stopPropagation(); } };
    el.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    el.addEventListener("click", onClick, true);
    return () => {
      el.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      el.removeEventListener("click", onClick, true);
    };
  }, [buildings.length, view]);

  const building = buildings.find((p) => p.id === propId) ?? buildings[0];
  const bandTest = PRICE_BANDS.find((b) => b.id === band)!.test as (p: number) => boolean;

  const listRooms = useMemo(() => {
    if (!building) return [];
    return building.rooms
      .filter((r) => (showRented || r.status !== "rented") && bandTest(r.price))
      .sort((a, b) => b.floor - a.floor || a.no - b.no);
  }, [building, showRented, band]);

  const openRoom = (r: Room) => { setRoom(r); requestAnimationFrame(() => setSheetShow(true)); };
  const closeSheet = () => { setSheetShow(false); window.setTimeout(() => setRoom(null), 300); };

  const showToast = (msg: string) => {
    setToast({ msg, show: true });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast((x) => ({ ...x, show: false })), 2200);
  };

  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");

  // ----- Trạng thái tải / lỗi / rỗng (sau khi mọi hook đã chạy) -----
  if (isLoading) {
    return <StatusScreen icon="⏳" title="Đang tải bảng phòng…" />;
  }
  if (error || data === null) {
    return <StatusScreen icon="🔗" title="Liên kết không hợp lệ" sub="Link chia sẻ đã bị thu hồi hoặc không tồn tại." />;
  }
  if (!building) {
    return <StatusScreen icon="🏠" title="Hiện chưa có phòng trống" sub="Vui lòng quay lại sau hoặc liên hệ để được tư vấn." />;
  }

  return (
    <div id="stage">
      <div className="app">
        <div className="hdr">
          <div className="hdr-top">
            <div className="brand-mark"><span>R</span></div>
            <div>
              <div className="brand-name">Phòng trống</div>
              <div className="brand-sub">Bảng phòng trực tiếp cho Sale</div>
            </div>
            <div className="live"><i className="dot" />Live · {hh}</div>
          </div>

          <div className="props" ref={propsRef}>
            {buildings.map((p) => (
              <button key={p.id} className={"prop-chip" + (p.id === propId ? " on" : "")} onClick={() => setPropId(p.id)}>
                <span className="pc-name">{p.name}</span>
                <span className="pc-meta">{p.area} · {p.freeCount} trống</span>
              </button>
            ))}
          </div>

          <div className="seg">
            <button className={view === "map" ? "on" : ""} onClick={() => setView("map")}>
              <Icon.Grid />Sơ đồ tòa nhà
            </button>
            <button className={view === "list" ? "on" : ""} onClick={() => setView("list")}>
              <Icon.List />Danh sách
            </button>
          </div>

          <FilterBar showRented={showRented} setShowRented={setShowRented} band={band} setBand={setBand} />
        </div>

        <Summary rooms={building.rooms} />

        <div className="scroll">
          {view === "map"
            ? <FloorPlan building={building} showRented={showRented} bandTest={bandTest} onOpen={openRoom} />
            : <ListView rooms={listRooms} onOpen={openRoom} />}
        </div>

        <DetailSheet room={room} show={sheetShow} onClose={closeSheet} onToast={showToast} saved={saved} toggleSave={toggleSave} contact={contact} />
        <Toast msg={toast.msg} show={toast.show} />
      </div>
    </div>
  );
}
