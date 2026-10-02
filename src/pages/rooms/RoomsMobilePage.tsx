import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, Plus, Search, Map as MapIcon, Pencil, X } from "lucide-react";
import "@/styles/mobileApp.css";
import "@/styles/financeMobile.css";
import "@/styles/estateMobile.css";
import { useRooms } from "@/hooks/useRooms";
import { RoomTurnoverQueue } from '@/components/rooms/RoomTurnoverQueue';
import { useBuildings } from "@/hooks/useBuildings";
import { useRoomsWithActiveContracts } from "@/hooks/useRoomsWithContracts";
import { getRoomDisplayStatus, type RoomDisplayStatus } from "@/lib/roomStatus";
import { resolveRoomPrice } from "@/lib/roomPrice";
import { compareBuildingThenRoom } from "@/lib/roomSort";
import { usePersistedState } from "@/hooks/usePersistedState";
import { useCopilotPageContext } from '@/hooks/useCopilotPageContext';
import RoomFormDialog from "@/components/rooms/RoomFormDialog";
import { QueryRegion } from "@/components/errors/QueryRegion";
import { InlineSkeleton } from "@/components/loading/LoadingState";
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
  useCopilotPageContext('rooms.list', { building_id: buildingId, status, search }, detail);

  useEffect(() => {
    if (preselected) setBuildingId(preselected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preselected]);

  const roomsQuery = useRooms();
  const { data: roomsData = [] } = roomsQuery;
  const rooms = roomsData as RoomWithRelations[];
  const buildingsQuery = useBuildings();
  const { data: buildingsData = [] } = buildingsQuery;
  const buildings = buildingsData as BuildingWithRelations[];
  const contractsQuery = useRoomsWithActiveContracts();
  const { data: roomsWithContracts = [] } = contractsQuery;
  // Số chưa có thì vạch xám, nguồn hỏng thì "—" — không in 0 lúc đang chờ (chủ chốt 02/10/2026).
  // Trạng thái hiển thị / phòng trống / sắp hết hạn cần cả hợp đồng đang hiệu lực.
  const roomsReady = roomsQuery.data !== undefined;
  const statsReady = roomsReady && contractsQuery.data !== undefined;
  const statsFailed = roomsQuery.isError || contractsQuery.isError;
  const countCell = (ready: boolean, failed: boolean, n: number, label: string) =>
    ready ? n : failed ? '—' : <InlineSkeleton label={label} width="1.75rem" />;

  const contractByRoom = useMemo(() => {
    const map = new Map<string, { end?: string; tenant?: string; rent?: number | null }>();
    roomsWithContracts.forEach((r) => map.set(r.id, { end: r.activeContract?.end_date, tenant: r.activeContract?.tenant?.full_name, rent: r.activeContract?.rent_price }));
    return map;
  }, [roomsWithContracts]);

  /**
   * Giá hiển thị lấy từ HỢP ĐỒNG đang hiệu lực, không lấy giá niêm yết của phòng
   * — hai số lệch nhau ở 44% hợp đồng (đo production 13/09/2026).
   */
  const priceOf = (r: RoomWithRelations) =>
    resolveRoomPrice({
      roomRentPrice: r.rent_price,
      contractRentPrice: contractByRoom.get(r.id)?.rent,
    });

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
  const detailPrice = detail ? priceOf(detail) : null;
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
              <p>
                {countCell(roomsReady, roomsQuery.isError, stats.total, "số căn hộ")} căn
                {buildingId ? null : <> · {countCell(buildingsQuery.data !== undefined, buildingsQuery.isError, buildings.length, "số toà nhà")} toà</>}
              </p>
            </div>
            <div className="mtop-act">
              <button className="mtop-btn" onClick={() => setCreateOpen(true)}>
                <Plus />
                Thêm
              </button>
            </div>
          </div>

          <div className="mbody">
            <RoomTurnoverQueue buildingIds={buildingId ? [buildingId] : []} />
            <div className="lfilter">
              {TABS.map((t) => (
                <button key={t.id} className={"lchip" + (status === t.id ? " on" : "")} onClick={() => setStatus(t.id)}>
                  {t.label}
                </button>
              ))}
            </div>

            {/* Ô chọn toà chờ danh sách toà: chưa về thì giữ chỗ đúng hình ô chọn — select
                rỗng sẽ hiện nhầm "Tất cả toà" khi đang lọc một toà đã lưu. */}
            <QueryRegion
              label="danh sách toà nhà"
              queries={[buildingsQuery]}
              loading={
                <div className="cm-filterbar">
                  <div className="cm-select" style={{ cursor: "default" }}>
                    <InlineSkeleton label="danh sách toà nhà" width="7rem" />
                  </div>
                </div>
              }
            >
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
            </QueryRegion>

            {/* Cùng control id với ô tìm của desktop (RoomListFilters): cùng ngữ
                nghĩa, và hai biến thể KHÔNG bao giờ mount cùng lúc (RoomsPage
                chọn đúng một nhánh theo viewport) nên bộ giải vẫn thấy đúng một
                phần tử. Thiếu marker này thì trên điện thoại page-agent ném
                `khong_thay` cho chính control mà hợp đồng trang đã hứa. */}
            <div className="cm-search">
              <Search />
              <input
                data-ai-safe="rooms.list.room.search"
                placeholder="Tìm phòng, mã căn hộ…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            <div className="bm-stats">
              <div className="bm-stat" style={{ "--bmc": "#1b1813" } as React.CSSProperties}>
                <div className="n">{countCell(roomsReady, roomsQuery.isError, stats.total, "tổng phòng")}</div>
                <div className="l">Tổng phòng</div>
              </div>
              <div className="bm-stat" style={{ "--bmc": "#dc2626" } as React.CSSProperties}>
                <div className="n">{countCell(statsReady, statsFailed, stats.available, "số phòng trống")}</div>
                <div className="l">Trống</div>
              </div>
              <div className="bm-stat" style={{ "--bmc": "#7c3aed" } as React.CSSProperties}>
                <div className="n">{countCell(statsReady, statsFailed, stats.expiring, "số phòng sắp hết hạn")}</div>
                <div className="l">Sắp hết hạn</div>
              </div>
            </div>

            {/* Trạng thái + giá của từng phòng lấy từ hợp đồng đang hiệu lực, nên danh sách
                chờ đủ hai nguồn (khối xám dạng thẻ) — hiện sớm sẽ ra trạng thái/giá sai. */}
            <QueryRegion label="danh sách căn hộ và trạng thái hợp đồng" queries={[roomsQuery, contractsQuery]} skeleton="list" rows={6}>
            {filtered.length === 0 ? (
              <div className="stub"><p>Không tìm thấy căn hộ nào khớp bộ lọc.</p></div>
            ) : (
              <div className="rowlist">
                {filtered.map((r) => {
                  const s = ST[displayStatus(r)];
                  const price = priceOf(r);
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
                          {fmtTr(price.primary)}
                          <small> tr</small>
                          {price.listed != null && (
                            <small className="rprice-list"> {fmtTr(price.listed)} tr</small>
                          )}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            </QueryRegion>
          </div>

          {detail && detailStatus && detailPrice && (
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
                  <div className="vd-row"><div className="vd-row-l">Tiền thuê</div><div className="vd-row-v"><b>{fmtTr(detailPrice.primary)} tr</b> / tháng{detailPrice.listed != null && (<span className="vd-row-note">· niêm yết {fmtTr(detailPrice.listed)} tr</span>)}</div></div>
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
