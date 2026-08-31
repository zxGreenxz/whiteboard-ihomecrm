import React, { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import "./phongTrong.css";
import { Icon } from "./icons";
import { FilterBar, FloorPlan, ListView, OverviewView, PRICE_BANDS } from "./PhongTrongParts";
import { DetailSheet, Toast } from "./PhongTrongSheet";
import { SAMPLE_BUILDINGS, type Building, type Room } from "./sampleData";
import { usePhongTrong } from "./usePhongTrong";
import { QuickDepositModal } from "./QuickDepositModal";
import { useSession } from "@/hooks/useAuth";
import { useMyPermissions, can } from "@/hooks/useMyPermissions";
import { useTracking, TrackingProvider } from "./useTracking";
import { usePersistedState } from "@/hooks/usePersistedState";

/** Giá trị đặc biệt cho chip "Tổng hợp" trong hàng chọn tòa nhà (xem tất cả tòa). */
const OVERVIEW = "__overview__";

/**
 * Trang công khai "Phòng trống" cho Sale — 100% giao diện mock, data mẫu.
 * Route gợi ý: /r/:token (xem README). Khi nối Supabase: thay SAMPLE_BUILDINGS
 * bằng dữ liệu thật map sang type Building/Room (giữ nguyên toàn bộ UI bên dưới).
 *
 * Dùng lại in-app (mobile): truyền sẵn `buildings` (đã map qua mapPayloadToBuildings)
 * + `embedded` để bỏ thanh brand `.hdr-top` và KHÔNG fallback data mẫu khi rỗng.
 */
export interface PhongTrongPageProps {
  /** Token public; mặc định đọc từ useParams (route /r/:token). */
  token?: string;
  /** Dữ liệu tòa/phòng có sẵn (in-app authenticated) — ưu tiên hơn token. */
  buildings?: Building[];
  /** Nhúng trong shell mobile: ẩn brand header, rỗng → empty-state thay vì SAMPLE. */
  embedded?: boolean;
}

export default function PhongTrongPage(props: PhongTrongPageProps = {}) {
  const { token: tokenParam } = useParams<{ token: string }>();
  const token = props.token ?? tokenParam;
  const isEmbedded = !!props.embedded;
  // In-app: chỉ gọi RPC token khi KHÔNG được truyền sẵn buildings.
  const { data, isLoading, isError } = usePhongTrong(props.buildings ? undefined : token);
  // Ưu tiên buildings truyền vào; rồi data RPC; cuối cùng data mẫu (chỉ khi không embedded).
  const sourced = props.buildings ?? data;
  const buildings = sourced && sourced.length ? sourced : isEmbedded ? [] : SAMPLE_BUILDINGS;

  const [propId, setPropId] = usePersistedState<string>("flt:phong-trong:propId", OVERVIEW);
  const [view, setView] = usePersistedState<"map" | "list">("flt:phong-trong:view", "list");
  const [district, setDistrict] = usePersistedState("flt:phong-trong:district", "all");
  const [band, setBand] = usePersistedState<string>("flt:phong-trong:band", "all");
  const showRented = false;
  const isOverview = propId === OVERVIEW;
  // Id lạ trong localStorage (dải giá cũ) → coi như "Mọi giá".
  const bandTest = useMemo(
    () => (PRICE_BANDS.find((b) => b.id === band) ?? PRICE_BANDS[0]).test,
    [band],
  );

  const [room, setRoom] = useState<Room | null>(null);
  const [sheetShow, setSheetShow] = useState(false);
  // "Tạo cọc nhanh": chỉ cho user ĐANG ĐĂNG NHẬP có quyền sale_phong.create_deposit.
  const { data: session } = useSession();
  const { data: perms } = useMyPermissions();
  const canQuickDeposit = !!session?.user && can(perms, "sale_phong", "create_deposit");
  // Bộ đo đếm: no-op khi không có token; is_staff = đang đăng nhập (cờ boolean, KHÔNG id/email).
  const tracker = useTracking(token, !!session?.user);
  const [depositRoom, setDepositRoom] = useState<Room | null>(null);
  const openDeposit = (r: Room) => {
    setDepositRoom(r);
    tracker.track("deposit_dialog", {
      room_id: r.id, room_code: r.code, room_name: String(r.no),
      building_id: r.buildingId, building_name: r.buildingName,
    });
  };
  const [toast, setToast] = useState({ msg: "", show: false });
  const toastTimer = useRef<number | undefined>(undefined);
  const propsRef = useRef<HTMLDivElement>(null);
  const districtsRef = useRef<HTMLDivElement>(null);

  const [saved, setSaved] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("pt_saved") || "[]"); } catch { return []; }
  });
  useEffect(() => { localStorage.setItem("pt_saved", JSON.stringify(saved)); }, [saved]);
  const toggleSave = (id: string) => {
    tracker.track("favorite", { room_id: id, metadata: { on: !saved.includes(id) } });
    setSaved((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  };

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
    tracker.track("building_select", { metadata: { kind: "district", district: d } });
    setDistrict(d);
    if (isOverview) return; // giữ chế độ "Tổng hợp" khi đổi quận
    const first = buildings.find((p) => d === "all" || p.district === d);
    if (first) setPropId(first.id);
  };

  // Chọn dải giá (chip) — ghi building_select kèm metadata (event_type có CHECK ở DB, không thêm loại mới).
  const pickBand = (id: string) => {
    tracker.track("building_select", { metadata: { kind: "price_band", band: id } });
    setBand(id);
  };

  // Chọn tòa (chip) — ghi building_select.
  const selectBuilding = (id: string) => {
    setPropId(id);
    if (id === OVERVIEW) {
      tracker.track("building_select", { metadata: { overview: true } });
    } else {
      const b = buildings.find((p) => p.id === id);
      tracker.track("building_select", { building_id: id, building_name: b?.name });
    }
  };

  // Đổi chế độ Danh sách/Sơ đồ — ghi view_mode (+ floorplan_view khi vào Sơ đồ).
  const changeView = (v: "map" | "list") => {
    setView(v);
    tracker.track("view_mode", { metadata: { view: v } });
    if (v === "map") {
      tracker.track("floorplan_view", isOverview
        ? { metadata: { overview: true } }
        : { building_id: building.id, building_name: building.name });
    }
  };

  const listRooms = useMemo(() => {
    if (!building) return [] as Room[];
    return building.rooms
      .filter((r) => (showRented || r.status !== "rented") && bandTest(r.price))
      .sort((a, b) => b.floor - a.floor || a.no - b.no);
  }, [building, bandTest]);

  // Đo thời gian xem chi tiết mỗi phòng: chốt dwell khi đóng / mở phòng khác / rời trang.
  const roomDwell = useRef<{ id: string; code: string; no: number; bid: string; bname: string; at: number } | null>(null);
  const emitRoomDwell = () => {
    const d = roomDwell.current;
    if (!d) return;
    roomDwell.current = null;
    const at = typeof performance !== "undefined" ? performance.now() : Date.now();
    tracker.track("room_open", {
      room_id: d.id, room_code: d.code, room_name: String(d.no),
      building_id: d.bid, building_name: d.bname, dwell_ms: at - d.at,
    });
  };
  const emitDwellRef = useRef(emitRoomDwell);
  emitDwellRef.current = emitRoomDwell;
  useEffect(() => () => emitDwellRef.current(), []); // chốt dwell phòng đang mở khi rời trang

  const openRoom = (r: Room) => {
    emitRoomDwell(); // chốt phòng trước (nếu có)
    roomDwell.current = {
      id: r.id, code: r.code, no: r.no, bid: r.buildingId, bname: r.buildingName,
      at: typeof performance !== "undefined" ? performance.now() : Date.now(),
    };
    setRoom(r);
    requestAnimationFrame(() => setSheetShow(true));
  };
  const closeSheet = () => { emitRoomDwell(); setSheetShow(false); window.setTimeout(() => setRoom(null), 300); };

  const showToast = (msg: string) => {
    setToast({ msg, show: true });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast((x) => ({ ...x, show: false })), 2200);
  };

  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");

  // "Tải ảnh": xuất bảng DANH SÁCH PHÒNG TRỐNG (kiểu file Excel Sale gửi Zalo).
  // Luôn lấy TOÀN BỘ phòng còn chào được, KHÔNG theo bộ lọc đang chọn trên màn
  // hình. Lazy-import để phần vẽ canvas không nằm trong chunk mở trang.
  const [exporting, setExporting] = useState(false);
  const exportImage = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const { downloadRoomListImage } = await import("./exportRoomListImage");
      const n = await downloadRoomListImage(buildings);
      tracker.track("share", { metadata: { kind: "export_image", rooms: n } });
      showToast(n ? `Đã tải ảnh ${n} phòng trống` : "Hiện chưa có phòng trống để xuất ảnh");
    } catch {
      showToast("Không tạo được ảnh. Thử lại nhé.");
    } finally {
      setExporting(false);
    }
  };

  // Ghi lỗi tải dữ liệu / token sai (không log giá trị token).
  useEffect(() => {
    if (token && isError) tracker.trackError({ kind: "fetch_or_token", where: "usePhongTrong", msg: "Tải danh sách phòng trống thất bại" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isError, token]);

  // Chỉ còn `isLoading`: vế `!(data && data.length)` cũ là THỪA, không phải rút gọn cho gọn.
  // React Query v5 khai `isLoading: true` DUY NHẤT ở nhánh QueryObserverLoadingResult, mà nhánh
  // đó có `data: undefined` (xem @tanstack/query-core). Nói cách khác `isLoading` = `isPending &&
  // isFetching`, nên khi đã có dữ liệu và đang refetch nền thì `isLoading` vốn đã là false —
  // đúng thứ mà vế kia định bảo vệ. Giữ lại thì TS thu hẹp `data` xuống `never` và báo lỗi.
  if (token && isLoading) {
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
  // In-app rỗng: không có phòng trống nào → empty-state (không hiện data mẫu).
  if (isEmbedded && buildings.length === 0) {
    return (
      <div id="stage" className="embed"><div className="app"><div className="empty" style={{ marginTop: 40 }}>
        <div className="e-ic">🏠</div><p>Hiện chưa có phòng trống.</p>
      </div></div></div>
    );
  }

  return (
    <TrackingProvider tracker={tracker}>
    <div id="stage" className={isEmbedded ? "embed" : undefined}>
      <div className="app">
        <div className="hdr">
          {!isEmbedded && (
            <div className="hdr-top">
              <div className="brand-mark"><span>R</span></div>
              <div className="brand-txt">
                <div className="brand-name">Phòng trống</div>
                <div className="brand-sub">Bảng phòng trực tiếp cho Sale</div>
              </div>
              <button
                type="button"
                className="hdr-dl"
                onClick={exportImage}
                disabled={exporting}
                title="Tải ảnh danh sách phòng trống"
              >
                <Icon.Download /><span>{exporting ? "Đang tạo…" : "Tải ảnh"}</span>
              </button>
              <div className="live"><i className="dot" />Live · {hh}</div>
            </div>
          )}

          <div className="seg">
            <button className={view === "list" ? "on" : ""} onClick={() => changeView("list")}>
              <Icon.Photo />Danh sách
            </button>
            <button className={view === "map" ? "on" : ""} onClick={() => changeView("map")}>
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
            <button className={"prop-chip" + (isOverview ? " on" : "")} onClick={() => selectBuilding(OVERVIEW)}>
              <span className="pc-name">Tổng hợp</span>
              <span className="pc-meta">{visibleBuildings.length} tòa · {totalFree} trống</span>
            </button>
            {visibleBuildings.map((p) => (
              <button key={p.id} className={"prop-chip" + (p.id === propId ? " on" : "")} onClick={() => selectBuilding(p.id)}>
                <span className="pc-name">{p.name}</span>
                <span className="pc-meta">{p.area} · {p.freeCount} trống</span>
              </button>
            ))}
          </div>

          <div className="sel-lbl">Khoảng giá</div>
          <FilterBar band={band} setBand={pickBand} />
        </div>

        <div className="scroll">
          {view === "map"
            ? (isOverview
                ? visibleBuildings.map((b) => (
                    <FloorPlan key={b.id} building={b} showRented={showRented} bandTest={bandTest} onOpen={openRoom} />
                  ))
                : <FloorPlan building={building} showRented={showRented} bandTest={bandTest} onOpen={openRoom} />)
            : (isOverview
                ? <OverviewView buildings={visibleBuildings} showRented={showRented} bandTest={bandTest} onOpen={openRoom} onQuickDeposit={canQuickDeposit ? openDeposit : undefined} />
                : <ListView rooms={listRooms} onOpen={openRoom} />)}
        </div>

        <DetailSheet room={room} show={sheetShow} onClose={closeSheet} onToast={showToast} saved={saved} toggleSave={toggleSave} onGo={openRoom} buildings={buildings} onQuickDeposit={canQuickDeposit ? (r) => { closeSheet(); openDeposit(r); } : undefined} />
        {/* Chỉ mount khi có quyền tạo cọc: modal gọi useAccounts() ngay lúc render,
            khách vãng lai (anon) sẽ bị RLS chặn và nổ toast đỏ "Không thể tải
            danh sách sổ quỹ" giữa trang công khai. Không có quyền thì depositRoom
            luôn null nên bỏ mount cũng không mất chức năng gì. */}
        {canQuickDeposit && (
          <QuickDepositModal room={depositRoom} onClose={() => setDepositRoom(null)} onDone={showToast} />
        )}
        <Toast msg={toast.msg} show={toast.show} />
      </div>
    </div>
    </TrackingProvider>
  );
}
