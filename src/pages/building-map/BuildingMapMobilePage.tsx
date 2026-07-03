import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Search, Boxes, X } from "lucide-react";
import { differenceInDays } from "date-fns";
import "@/styles/mobileApp.css";
import "@/styles/financeMobile.css";
import "@/styles/estateMobile.css";
import { useBuildings } from "@/hooks/useBuildings";
import { useRooms } from "@/hooks/useRooms";
import { useFloors } from "@/hooks/useFloors";
import { useRoomsWithActiveContracts } from "@/hooks/useRoomsWithContracts";
import { getRoomDisplayStatus, type RoomDisplayStatus } from "@/lib/roomStatus";
import { usePersistedState } from "@/hooks/usePersistedState";

const ST: Record<RoomDisplayStatus, { cls: string; label: string }> = {
  OCCUPIED: { cls: "st-occ", label: "Đang thuê" },
  AVAILABLE: { cls: "st-free", label: "Trống" },
  RESERVED: { cls: "st-res", label: "Đã cọc" },
  EXPIRING_SOON: { cls: "st-exp", label: "Sắp trống" },
  MAINTENANCE: { cls: "st-main", label: "Ngừng HĐ" },
};

const TABS: { id: string; label: string }[] = [
  { id: "all", label: "Tất cả" },
  { id: "OCCUPIED", label: "Đang thuê" },
  { id: "AVAILABLE", label: "Trống" },
  { id: "RESERVED", label: "Đã cọc" },
  { id: "EXPIRING_SOON", label: "Sắp trống" },
  { id: "MAINTENANCE", label: "Ngừng HĐ" },
];

const fmtTr = (n: number | null | undefined) => {
  if (!n) return "0";
  return (n / 1e6).toFixed(1).replace(/\.0$/, "");
};

const fmtDate = (s?: string | null) => {
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
};

type EnrichedRoom = {
  id: string;
  name: string;
  floor: number | null;
  rent_price: number | null;
  displayStatus: RoomDisplayStatus;
  tenantName?: string;
  contractRange?: string;
  daysUntilExpiry?: number;
  area?: number;
  roomType?: string;
};

/**
 * Sơ đồ toà nhà — màn hình app full-screen mobile (web-app). Dựng theo handoff
 * Claude Design (iHomeCRM Mobile.dc.html · 1b) nối DỮ LIỆU THẬT: cùng hook +
 * bộ lọc persisted như desktop BuildingMapPage. Chi tiết căn hộ mở bottom-sheet.
 * Scope .cm-stage/.cm-app, ngoài MainLayout.
 */
export default function BuildingMapMobilePage() {
  const navigate = useNavigate();

  const [selectedBuildingId, setSelectedBuildingId] = usePersistedState<string>("flt:building-map:buildingId", "");
  const [selectedFloor, setSelectedFloor] = usePersistedState<string>("flt:building-map:floor", "all");
  const [selectedStatus, setSelectedStatus] = usePersistedState<string>("flt:building-map:status", "all");
  const [search, setSearch] = usePersistedState<string>("flt:building-map:search", "");
  const [detail, setDetail] = useState<EnrichedRoom | null>(null);

  const { data: buildings = [] } = useBuildings();
  const { data: allRooms = [] } = useRooms();
  const { data: floors = [] } = useFloors(selectedBuildingId || undefined);
  const { data: roomsWithContracts = [] } = useRoomsWithActiveContracts(selectedBuildingId || undefined);

  // Auto-chọn toà đầu tiên (đồng bộ desktop)
  if (!selectedBuildingId && buildings.length > 0) {
    setSelectedBuildingId(buildings[0].id);
  }

  const contractByRoomId = useMemo(() => {
    const map = new Map<string, (typeof roomsWithContracts)[number]>();
    roomsWithContracts.forEach((r) => map.set(r.id, r));
    return map;
  }, [roomsWithContracts]);

  const building = buildings.find((b) => b.id === selectedBuildingId);

  const enrichedAll: EnrichedRoom[] = useMemo(() => {
    let rooms = allRooms as any[];
    if (selectedBuildingId) rooms = rooms.filter((r) => r.building_id === selectedBuildingId);
    return rooms.map((room) => {
      const c = contractByRoomId.get(room.id);
      const end = c?.activeContract?.end_date;
      return {
        id: room.id,
        name: room.name,
        floor: room.floor ?? null,
        rent_price: room.rent_price,
        displayStatus: getRoomDisplayStatus(room.status, end),
        tenantName: c?.activeContract?.tenant?.full_name,
        contractRange: end ? `Đến ${fmtDate(end)}` : undefined,
        daysUntilExpiry: end ? differenceInDays(new Date(end), new Date()) : undefined,
        area: room.area ?? undefined,
        roomType: room.room_type ?? undefined,
      };
    });
  }, [allRooms, selectedBuildingId, contractByRoomId]);

  const stats = useMemo(() => {
    const total = enrichedAll.length;
    const occupied = enrichedAll.filter((r) => r.displayStatus === "OCCUPIED").length;
    const available = enrichedAll.filter((r) => r.displayStatus === "AVAILABLE").length;
    return { total, occupied, available };
  }, [enrichedAll]);

  const filtered = useMemo(() => {
    let rooms = enrichedAll;
    if (selectedFloor !== "all") rooms = rooms.filter((r) => String(r.floor ?? 0) === selectedFloor);
    if (selectedStatus !== "all") rooms = rooms.filter((r) => r.displayStatus === selectedStatus);
    const q = search.trim().toLowerCase();
    if (q) rooms = rooms.filter((r) => r.name.toLowerCase().includes(q) || r.tenantName?.toLowerCase().includes(q));
    return rooms;
  }, [enrichedAll, selectedFloor, selectedStatus, search]);

  const byFloor = useMemo(() => {
    const grouped: Record<number, EnrichedRoom[]> = {};
    filtered.forEach((r) => {
      const f = r.floor ?? 0;
      (grouped[f] ||= []).push(r);
    });
    return Object.entries(grouped).sort(([a], [b]) => Number(b) - Number(a));
  }, [filtered]);

  const floorLabel = (n: number) => floors.find((f) => f.floor_number === n)?.name || `Tầng ${n}`;

  return (
    <div className="cm-stage">
      <div className="cm-app">
        <div className="route route-anim">
          <div className="mtop">
            <button className="mback" onClick={() => navigate("/")} aria-label="Về trang chủ">
              <ArrowLeft />
            </button>
            <div className="mtitle">
              <h1>Sơ đồ toà nhà</h1>
              <p>{building ? `${building.name} · ${stats.total} căn hộ` : "Chọn toà nhà"}</p>
            </div>
          </div>

          <div className="mbody">
            <div className="cm-filterbar">
              <select
                className="cm-select"
                aria-label="Toà nhà"
                value={selectedBuildingId}
                onChange={(e) => {
                  setSelectedBuildingId(e.target.value);
                  setSelectedFloor("all");
                }}
              >
                {buildings.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
              <select
                className="cm-select"
                aria-label="Tầng"
                value={selectedFloor}
                onChange={(e) => setSelectedFloor(e.target.value)}
              >
                <option value="all">Tất cả tầng</option>
                {floors.map((f) => (
                  <option key={f.id} value={String(f.floor_number)}>
                    {f.name || `Tầng ${f.floor_number}`}
                  </option>
                ))}
              </select>
            </div>

            <div className="cm-search">
              <Search />
              <input
                placeholder="Tìm phòng, tên khách…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            <div className="bm-stats">
              <div className="bm-stat" style={{ "--bmc": "#1b1813" } as React.CSSProperties}>
                <div className="n">{stats.total}</div>
                <div className="l">Tổng căn</div>
              </div>
              <div className="bm-stat" style={{ "--bmc": "#15803d" } as React.CSSProperties}>
                <div className="n">{stats.occupied}</div>
                <div className="l">Đang thuê</div>
              </div>
              <div className="bm-stat" style={{ "--bmc": "#dc2626" } as React.CSSProperties}>
                <div className="n">{stats.available}</div>
                <div className="l">Trống</div>
              </div>
            </div>

            <div className="bm-legend">
              <span className="bm-leg"><span className="dot" style={{ background: "#1f9d57" }} />Đang thuê</span>
              <span className="bm-leg"><span className="dot" style={{ background: "#dc2626" }} />Trống</span>
              <span className="bm-leg"><span className="dot" style={{ background: "#d97706" }} />Đã cọc</span>
              <span className="bm-leg"><span className="dot" style={{ background: "#7c3aed" }} />Sắp trống</span>
              <span className="bm-leg"><span className="dot" style={{ background: "#9ca3af" }} />Ngừng HĐ</span>
            </div>

            <div className="lfilter">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  className={"lchip" + (selectedStatus === t.id ? " on" : "")}
                  onClick={() => setSelectedStatus(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {filtered.length === 0 ? (
              <div className="stub">
                <p>Không có căn hộ nào khớp bộ lọc. Thử đổi tầng, trạng thái hoặc từ khoá.</p>
              </div>
            ) : (
              byFloor.map(([floorNum, rooms]) => (
                <div className="bm-floor" key={floorNum}>
                  <div className="bm-floor-h">
                    <Boxes />
                    {floorLabel(Number(floorNum))}
                    <span className="cnt">{rooms.length} căn</span>
                  </div>
                  <div className="bm-grid">
                    {rooms.map((r) => {
                      const st = ST[r.displayStatus];
                      return (
                        <button key={r.id} className={`bm-room ${st.cls}`} onClick={() => setDetail(r)}>
                          <div className="bm-room-h">
                            <span className="rno">{r.name}</span>
                            <span className="rdot" />
                          </div>
                          <div className="rprice">
                            {fmtTr(r.rent_price)}
                            <small> tr/th</small>
                          </div>
                          <div className="rlabel">{st.label}</div>
                          {r.tenantName && <div className="rtenant">{r.tenantName}</div>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>

          {detail && (
            <div className="sheet-ov" onClick={() => setDetail(null)}>
              <div className="sheet" onClick={(e) => e.stopPropagation()}>
                <div className="sheet-grab" />
                <div className="vd-hd">
                  <div className="vd-hd-t">CĂN HỘ {detail.name}</div>
                  <button className="sheet-x" onClick={() => setDetail(null)} aria-label="Đóng">
                    <X size={18} />
                  </button>
                </div>
                <div className="cdh" style={{ marginTop: 14 }}>
                  <div className="cdh-body">
                    <div className="cdh-name">Phòng {detail.name}</div>
                    <div className="cdh-sub">
                      <span className={`rst ${ST[detail.displayStatus].cls}`}>{ST[detail.displayStatus].label}</span>
                      {building && <span className="cdh-phone">{building.name}</span>}
                    </div>
                  </div>
                </div>

                <div className="vd-sec"><div className="vd-sec-t">Thông tin căn hộ</div></div>
                <div className="vd-table">
                  <div className="vd-row">
                    <div className="vd-row-l">Giá thuê</div>
                    <div className="vd-row-v"><b>{fmtTr(detail.rent_price)} tr</b> / tháng</div>
                  </div>
                  {(detail.roomType || detail.area) && (
                    <div className="vd-row">
                      <div className="vd-row-l">Loại · Diện tích</div>
                      <div className="vd-row-v">
                        {[detail.roomType, detail.area ? `${detail.area} m²` : null].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                  )}
                  <div className="vd-row">
                    <div className="vd-row-l">Tầng</div>
                    <div className="vd-row-v">{floorLabel(detail.floor ?? 0)}</div>
                  </div>
                </div>

                {detail.tenantName && (
                  <>
                    <div className="vd-sec"><div className="vd-sec-t">Khách đang thuê</div></div>
                    <div className="vd-table">
                      <div className="vd-row">
                        <div className="vd-row-l">Họ tên</div>
                        <div className="vd-row-v"><b>{detail.tenantName}</b></div>
                      </div>
                      {detail.contractRange && (
                        <div className="vd-row">
                          <div className="vd-row-l">Hợp đồng</div>
                          <div className="vd-row-v">{detail.contractRange}</div>
                        </div>
                      )}
                    </div>
                  </>
                )}

                <div className="sheet-acts">
                  <button className="ghost" onClick={() => navigate(`/apartments?building_id=${selectedBuildingId}`)}>
                    Xem căn hộ
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
