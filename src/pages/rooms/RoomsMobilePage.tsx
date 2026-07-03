import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, Plus, Search, Map as MapIcon, Pencil, X } from "lucide-react";
import "@/styles/mobileApp.css";
import "@/styles/financeMobile.css";
import "@/styles/estateMobile.css";
import { useRooms } from "@/hooks/useRooms";
import { useBuildings } from "@/hooks/useBuildings";
import { useRoomsWithActiveContracts } from "@/hooks/useRoomsWithContracts";
import { getRoomDisplayStatus, type RoomDisplayStatus } from "@/lib/roomStatus";
import { compareBuildingThenRoom } from "@/lib/roomSort";
import { usePersistedState } from "@/hooks/usePersistedState";
import RoomFormDialog from "@/components/rooms/RoomFormDialog";
import type { RoomWithRelations } from "@/types/room";
import type { BuildingWithRelations } from "@/types/building";

const ST: Record<RoomDisplayStatus, { cls: string; label: string; bar: string }> = {
  OCCUPIED: { cls: "st-occ", label: "Đang thuê", bar: "#1f9d57" },
  AVAILABLE: { cls: "st-free", label: "Trống", bar: "#dc2626" },
  RESERVED: { cls: "st-res", label: "Đã cọc", bar: "#d97706" },
  EXPIRING_SOON: { cls: "st-exp", label: "Sắp trống", bar: "#7c3aed" },
  MAINTENANCE: { cls: "st-main", label: "Ngừng HĐ", bar: "#9ca3af" },
};

const TABS: { id: string; label: string }[] = [
  { id: "all", label: "Tất cả" },
  { id: "AVAILABLE", label: "Trống" },
  { id: "OCCUPIED", label: "Đang thuê" },
  { id: "RESERVED", label: "Đã cọc" },
  { id: "EXPIRING_SOON", label: "Sắp hết hạn" },
];

const fmtTr = (n: number | null | undefined) => (!n ? "0" : (n / 1e6).toFixed(1).replace(/\.0$/, ""));
const fmtVnd = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString("vi-VN") + " đ");

/**
 * Căn hộ — màn hình app full-screen mobile (web-app). Dựng theo handoff Claude
 * Design (iHomeCRM Mobile.dc.html · 1d). Nối dữ liệu thật: useRooms + hợp đồng
 * hiệu lực (trạng thái hiển thị) + lọc như desktop. Thêm/sửa dùng lại
 * RoomFormDialog (desktop). Scope .cm-stage/.cm-app, ngoài MainLayout.
 */
export default function RoomsMobilePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const preselected = searchParams.get("building_id") || "";

  const [search, setSearch] = usePersistedState("flt:rooms:search", "");
  const [buildingId, setBuildingId] = usePersistedState<string>("flt:rooms-mb:building", preselected);
  const [status, setStatus] = usePersistedState<string>("flt:rooms-mb:status", "all");
  const [detail, setDetail] = useState<RoomWithRelations | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editRoom, setEditRoom] = useState<RoomWithRelations | null>(null);

  useEffect(() => {
    if (preselected) setBuildingId(preselected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preselected]);

  const { data: roomsData = [], isLoading } = useRooms();
  const rooms = roomsData as RoomWithRelations[];
  const { data: buildingsData = [] } = useBuildings();
  const buildings = buildingsData as BuildingWithRelations[];
  const { data: roomsWithContracts = [] } = useRoomsWithActiveContracts();

  const contractByRoom = useMemo(() => {
    const map = new Map<string, { end?: string; tenant?: string }>();
    roomsWithContracts.forEach((r) => map.set(r.id, { end: r.activeContract?.end_date, tenant: r.activeContract?.tenant?.full_name }));
    return map;
  }, [roomsWithContracts]);

  const displayStatus = (r: RoomWithRelations): RoomDisplayStatus =>
    getRoomDisplayStatus(r.status, contractByRoom.get(r.id)?.end);

  const scoped = useMemo(() => {
    let list = rooms;
    if (buildingId) list = list.filter((r) => r.building_id === buildingId);
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((r) => r.name.toLowerCase().includes(q) || r.code?.toLowerCase().includes(q));
    return list;
  }, [rooms, buildingId, search]);

  const stats = useMemo(() => {
    let available = 0;
    let expiring = 0;
    for (const r of scoped) {
      const s = displayStatus(r);
      if (s === "AVAILABLE") available++;
      else if (s === "EXPIRING_SOON") expiring++;
    }
    return { total: scoped.length, available, expiring };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoped, contractByRoom]);

  const filtered = useMemo(() => {
    const list = status === "all" ? scoped : scoped.filter((r) => displayStatus(r) === status);
    return [...list].sort((a, b) =>
      compareBuildingThenRoom(a.building?.name ?? "", a.name ?? "", b.building?.name ?? "", b.name ?? ""),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoped, status, contractByRoom]);

  const detailStatus = detail ? displayStatus(detail) : null;
  const detailTenant = detail ? contractByRoom.get(detail.id)?.tenant : undefined;

  return (
    <div className="cm-stage">
      <div className="cm-app">
        <div className="route route-anim">
          <div className="mtop">
            <button className="mback" onClick={() => navigate("/")} aria-label="Về trang chủ">
              <ArrowLeft />
            </button>
            <div className="mtitle">
              <h1>Căn hộ</h1>
              <p>{stats.total} căn{buildingId ? "" : ` · ${buildings.length} toà`}</p>
            </div>
            <div className="mtop-act">
              <button className="mtop-btn" onClick={() => setCreateOpen(true)}>
                <Plus />
                Thêm
              </button>
            </div>
          </div>

          <div className="mbody">
            <div className="lfilter">
              {TABS.map((t) => (
                <button key={t.id} className={"lchip" + (status === t.id ? " on" : "")} onClick={() => setStatus(t.id)}>
                  {t.label}
                </button>
              ))}
            </div>

            <div className="cm-filterbar">
              <select className="cm-select" aria-label="Toà nhà" value={buildingId} onChange={(e) => setBuildingId(e.target.value)}>
                <option value="">Tất cả toà</option>
                {buildings.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.code || b.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="cm-search">
              <Search />
              <input placeholder="Tìm phòng, mã căn hộ…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>

            <div className="bm-stats">
              <div className="bm-stat" style={{ "--bmc": "#1b1813" } as React.CSSProperties}>
                <div className="n">{stats.total}</div>
                <div className="l">Tổng phòng</div>
              </div>
              <div className="bm-stat" style={{ "--bmc": "#dc2626" } as React.CSSProperties}>
                <div className="n">{stats.available}</div>
                <div className="l">Trống</div>
              </div>
              <div className="bm-stat" style={{ "--bmc": "#7c3aed" } as React.CSSProperties}>
                <div className="n">{stats.expiring}</div>
                <div className="l">Sắp hết hạn</div>
              </div>
            </div>

            {isLoading ? (
              <div className="stub"><p>Đang tải căn hộ…</p></div>
            ) : filtered.length === 0 ? (
              <div className="stub"><p>Không tìm thấy căn hộ nào khớp bộ lọc.</p></div>
            ) : (
              <div className="rowlist">
                {filtered.map((r) => {
                  const s = ST[displayStatus(r)];
                  const b = r.building;
                  const meta = [b?.code || b?.name, r.floor != null ? `Tầng ${r.floor}` : null, (r as any).room_type, (r as any).area ? `${(r as any).area}m²` : null]
                    .filter(Boolean)
                    .join(" · ");
                  return (
                    <div className="lrow" key={r.id} onClick={() => setDetail(r)}>
                      <span className="lrow-bar" style={{ background: s.bar }} />
                      <div className="lrow-body">
                        <div className="lrow-l1">
                          <span className="lrow-name">{r.name}</span>
                          <span className={`rst ${s.cls}`}>{s.label}</span>
                        </div>
                        <div className="lrow-sub">{meta}</div>
                      </div>
                      <div className="lrow-r">
                        <span className="lrow-amt">
                          {fmtTr(r.rent_price)}
                          <small> tr/th</small>
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {detail && detailStatus && (
            <div className="sheet-ov" onClick={() => setDetail(null)}>
              <div className="sheet" onClick={(e) => e.stopPropagation()}>
                <div className="sheet-grab" />
                <div className="vd-hd">
                  <div className="vd-hd-t">CĂN HỘ · {detail.name}</div>
                  <button className="sheet-x" onClick={() => setDetail(null)} aria-label="Đóng">
                    <X size={18} />
                  </button>
                </div>

                <div className="cdh" style={{ marginTop: 14 }}>
                  <div className="cdh-body">
                    <div className="cdh-name">Phòng {detail.name}</div>
                    <div className="cdh-sub">
                      <span className={`rst ${ST[detailStatus].cls}`}>{ST[detailStatus].label}</span>
                      <span className="cdh-phone">
                        {[detail.building?.code || detail.building?.name, detail.floor != null ? `Tầng ${detail.floor}` : null].filter(Boolean).join(" · ")}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="vd-sec"><div className="vd-sec-t">Thông tin căn hộ</div></div>
                <div className="vd-table">
                  <div className="vd-row"><div className="vd-row-l">Tiền thuê</div><div className="vd-row-v"><b>{fmtTr(detail.rent_price)} tr</b> / tháng</div></div>
                  <div className="vd-row"><div className="vd-row-l">Tiền cọc</div><div className="vd-row-v">{fmtVnd((detail as any).deposit)}</div></div>
                  {((detail as any).room_type || (detail as any).area) && (
                    <div className="vd-row">
                      <div className="vd-row-l">Loại · Diện tích</div>
                      <div className="vd-row-v">{[(detail as any).room_type, (detail as any).area ? `${(detail as any).area} m²` : null].filter(Boolean).join(" · ")}</div>
                    </div>
                  )}
                  {(detail as any).max_occupancy != null && (
                    <div className="vd-row"><div className="vd-row-l">Số khách tối đa</div><div className="vd-row-v">{(detail as any).max_occupancy} người</div></div>
                  )}
                </div>

                {detailTenant && (
                  <>
                    <div className="vd-sec"><div className="vd-sec-t">Khách đang thuê</div></div>
                    <div className="vd-table">
                      <div className="vd-row"><div className="vd-row-l">Họ tên</div><div className="vd-row-v"><b>{detailTenant}</b></div></div>
                    </div>
                  </>
                )}

                <div className="sheet-acts">
                  <button className="ghost" onClick={() => navigate("/building-map")}>
                    <MapIcon />
                    Sơ đồ
                  </button>
                  <button
                    className="primary"
                    onClick={() => {
                      setEditRoom(detail);
                      setDetail(null);
                    }}
                  >
                    <Pencil />
                    Sửa căn hộ
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Thêm / sửa căn hộ — dùng lại dialog desktop */}
      <RoomFormDialog open={createOpen} onOpenChange={setCreateOpen} preselectedBuildingId={buildingId || undefined} />
      {editRoom && (
        <RoomFormDialog
          open={!!editRoom}
          onOpenChange={(o) => {
            if (!o) setEditRoom(null);
          }}
          room={editRoom}
        />
      )}
    </div>
  );
}
