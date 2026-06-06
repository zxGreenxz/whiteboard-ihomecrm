import React, { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import "./phongTrong.css";
import { Icon } from "./icons";
import { Summary, FilterBar, FloorPlan, ListView, PRICE_BANDS } from "./PhongTrongParts";
import { DetailSheet, Toast } from "./PhongTrongSheet";
import { SAMPLE_BUILDINGS, type Room } from "./sampleData";

/**
 * Trang công khai "Phòng trống" cho Sale — 100% giao diện mock, data mẫu.
 * Route gợi ý: /r/:token (xem README). Khi nối Supabase: thay SAMPLE_BUILDINGS
 * bằng dữ liệu thật map sang type Building/Room (giữ nguyên toàn bộ UI bên dưới).
 */
export default function PhongTrongPage() {
  const { token } = useParams<{ token: string }>();
  const buildings = SAMPLE_BUILDINGS;

  const [propId, setPropId] = useState(buildings[0].id);
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
  }, []);

  const building = buildings.find((p) => p.id === propId)!;
  const bandTest = PRICE_BANDS.find((b) => b.id === band)!.test as (p: number) => boolean;

  const listRooms = useMemo(() => {
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

        <DetailSheet room={room} show={sheetShow} onClose={closeSheet} onToast={showToast} saved={saved} toggleSave={toggleSave} />
        <Toast msg={toast.msg} show={toast.show} />
      </div>
    </div>
  );
}
