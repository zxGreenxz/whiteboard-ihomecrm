import React, { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import "./phongTrong.css";
import { Icon } from "./icons";
import { FloorPlan, ListView, OverviewView } from "./PhongTrongParts";
import { DetailSheet, Toast } from "./PhongTrongSheet";
import { SAMPLE_BUILDINGS, type Room } from "./sampleData";
import { usePhongTrong } from "./usePhongTrong";

/** Giá trị đặc biệt cho chip "Tổng hợp" trong hàng chọn tòa nhà (xem tất cả tòa). */
const OVERVIEW = "__overview__";

/**
 * Trang công khai "Phòng trống" cho Sale — 100% giao diện mock, data mẫu.
 * Route gợi ý: /r/:token (xem README). Khi nối Supabase: thay SAMPLE_BUILDINGS
 * bằng dữ liệu thật map sang type Building/Room (giữ nguyên toàn bộ UI bên dưới).
 */
export default function PhongTrongPage() {
  const { token } = useParams<{ token: string }>();
  const { data, isLoading, isError } = usePhongTrong(token);
  // Có data thật -> dùng; chưa có token/data (xem thử) -> data mẫu.
  const buildings = data && data.length ? data : SAMPLE_BUILDINGS;

  const [propId, setPropId] = useState<string>(OVERVIEW);
  const [view, setView] = useState<"map" | "list">("list");
  const [district, setDistrict] = useState("all");
  const showRented = false;
  const isOverview = propId === OVERVIEW;

  const [room, setRoom] = useState<Room | null>(null);
  const [sheetShow, setSheetShow] = useState(false);
  const [toast, setToast] = useState({ msg: "", show: false });
  const toastTimer = useRef<number | undefined>(undefined);
  const propsRef = useRef<HTMLDivElement>(null);
  const districtsRef = useRef<HTMLDivElement>(null);

  const [saved, setSaved] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("pt_saved") || "[]"); } catch { return []; }
  });
  useEffect(() => { localStorage.setItem("pt_saved", JSON.stringify(saved)); }, [saved]);
  const toggleSave = (id: string) =>
    setSaved((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  // Kéo ngang hàng quận + tòa nhà: vuốt trên mobile (native) + kéo chuột trên desktop.
  useEffect(() => {
    const els = [propsRef.current, districtsRef.current].filter(Boolean) as HTMLDivElement[];
    const cleanups = els.map((el) => {
      let down = false, startX = 0, startScroll = 0, moved = false;
      const onDown = (e: MouseEvent) => { down = true; moved = false; startX = e.pageX; startScroll = el.scrollLeft; el.classList.add("dragging"); };
      const onMove = (e: MouseEvent) => { if (!down) return; const dx = e.pageX - startX; if (Math.abs(dx) > 4) moved = true; el.scrollLeft = startScroll - dx; };
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
    });
    return () => cleanups.forEach((c) => c());
  }, []);

  const districts = useMemo(
    () => ["all", ...Array.from(new Set(buildings.map((p) => p.district)))],
    [buildings],
  );
  const visibleBuildings = useMemo(
    () => buildings.filter((p) => district === "all" || p.district === district),
    [buildings, district],
  );
  const totalFree = useMemo(
    () => visibleBuildings.reduce((n, p) => n + p.freeCount, 0),
    [visibleBuildings],
  );
  const building = buildings.find((p) => p.id === propId) || buildings[0];

  const pickDistrict = (d: string) => {
    setDistrict(d);
    if (isOverview) return; // giữ chế độ "Tổng hợp" khi đổi quận
    const first = buildings.find((p) => d === "all" || p.district === d);
    if (first) setPropId(first.id);
  };

  const listRooms = useMemo(() => {
    return building.rooms
      .filter((r) => showRented || r.status !== "rented")
      .sort((a, b) => b.floor - a.floor || a.no - b.no);
  }, [building]);

  const openRoom = (r: Room) => { setRoom(r); requestAnimationFrame(() => setSheetShow(true)); };
  const closeSheet = () => { setSheetShow(false); window.setTimeout(() => setRoom(null), 300); };

  const showToast = (msg: string) => {
    setToast({ msg, show: true });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast((x) => ({ ...x, show: false })), 2200);
  };

  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
  const alwaysTrue = () => true;

  if (token && isLoading && !(data && data.length)) {
    return (
      <div id="stage"><div className="app"><div className="empty" style={{ marginTop: 80 }}>
        <div className="e-ic">⏳</div><p>Đang tải danh sách phòng…</p>
      </div></div></div>
    );
  }
  if (token && isError) {
    return (
      <div id="stage"><div className="app"><div className="empty" style={{ marginTop: 80 }}>
        <div className="e-ic">🔒</div><p>Liên kết không hợp lệ hoặc đã hết hạn.<br/>Vui lòng liên hệ quản lý để lấy link mới.</p>
      </div></div></div>
    );
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

          <div className="seg">
            <button className={view === "list" ? "on" : ""} onClick={() => setView("list")}>
              <Icon.Photo />Danh sách
            </button>
            <button className={view === "map" ? "on" : ""} onClick={() => setView("map")}>
              <Icon.Grid />Sơ đồ
            </button>
          </div>

          <div className="sel-lbl">Quận</div>
          <div className="districts" ref={districtsRef}>
            {districts.map((d) => (
              <button key={d} className={"dist-chip" + (district === d ? " on" : "")} onClick={() => pickDistrict(d)}>
                {d === "all" ? "Tất cả" : d}
              </button>
            ))}
          </div>

          <div className="sel-lbl">Tòa nhà</div>
          <div className="props" ref={propsRef}>
            <button className={"prop-chip" + (isOverview ? " on" : "")} onClick={() => setPropId(OVERVIEW)}>
              <span className="pc-name">Tổng hợp</span>
              <span className="pc-meta">{visibleBuildings.length} tòa · {totalFree} trống</span>
            </button>
            {visibleBuildings.map((p) => (
              <button key={p.id} className={"prop-chip" + (p.id === propId ? " on" : "")} onClick={() => setPropId(p.id)}>
                <span className="pc-name">{p.name}</span>
                <span className="pc-meta">{p.area} · {p.freeCount} trống</span>
              </button>
            ))}
          </div>
        </div>

        <div className="scroll">
          {view === "map"
            ? (isOverview
                ? visibleBuildings.map((b) => (
                    <FloorPlan key={b.id} building={b} showRented={showRented} bandTest={alwaysTrue} onOpen={openRoom} />
                  ))
                : <FloorPlan building={building} showRented={showRented} bandTest={alwaysTrue} onOpen={openRoom} />)
            : (isOverview
                ? <OverviewView buildings={visibleBuildings} showRented={showRented} bandTest={alwaysTrue} onOpen={openRoom} />
                : <ListView rooms={listRooms} onOpen={openRoom} />)}
        </div>

        <DetailSheet room={room} show={sheetShow} onClose={closeSheet} onToast={showToast} saved={saved} toggleSave={toggleSave} onGo={setRoom} buildings={buildings} />
        <Toast msg={toast.msg} show={toast.show} />
      </div>
    </div>
  );
}
