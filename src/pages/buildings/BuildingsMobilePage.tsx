import { useCopilotPageContext } from '@/hooks/useCopilotPageContext';
import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Plus, Search, Building2, Home, Pencil, X } from "lucide-react";
import "@/styles/mobileApp.css";
import "@/styles/financeMobile.css";
import "@/styles/estateMobile.css";
import { useBuildings } from "@/hooks/useBuildings";
import { useRooms } from "@/hooks/useRooms";
import { useRoomsWithActiveContracts } from "@/hooks/useRoomsWithContracts";
import { getRoomDisplayStatus } from "@/lib/roomStatus";
import { usePersistedState } from "@/hooks/usePersistedState";
import BuildingFormDialog from "@/components/buildings/BuildingFormDialog";
import { QueryRegion } from "@/components/errors/QueryRegion";
import { InlineSkeleton, SkeletonBar } from "@/components/loading/LoadingState";
import type { BuildingWithRelations } from "@/types/building";

type Occ = { total: number; occupied: number; available: number; pct: number };

const tagOf = (b: BuildingWithRelations) =>
  b.code ? (b.code.match(/^\d+/)?.[0] ?? b.code.slice(0, 4)) : b.name.slice(0, 3).toUpperCase();

const shortAddr = (b: BuildingWithRelations) => {
  const area = b.areas?.[0]?.name;
  const base = [b.ward, b.district].filter(Boolean).join(", ");
  return area ? `${base} · ${area}` : base || b.province || "—";
};

const fullAddr = (b: BuildingWithRelations) =>
  [b.street_address, b.ward, b.district, b.province].filter(Boolean).join(", ");

/**
 * Toà nhà — màn hình app full-screen mobile (web-app). Dựng theo handoff Claude
 * Design (iHomeCRM Mobile.dc.html · 1c). Nối dữ liệu thật: useBuildings + suy
 * tỉ lệ lấp đầy từ useRooms + hợp đồng hiệu lực. Thêm/sửa dùng lại BuildingFormDialog
 * (desktop). Scope .cm-stage/.cm-app, ngoài MainLayout.
 */
export default function BuildingsMobilePage() {
  const navigate = useNavigate();

  const [search, setSearch] = usePersistedState("flt:buildings:search", "");
  const [detail, setDetail] = useState<BuildingWithRelations | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editBuilding, setEditBuilding] = useState<BuildingWithRelations | undefined>(undefined);

  useCopilotPageContext('buildings.list', { search }, detail);
  const buildingsQuery = useBuildings();
  const { data: buildingsData = [] } = buildingsQuery;
  const buildings = buildingsData as BuildingWithRelations[];
  const roomsQuery = useRooms();
  const { data: allRooms = [] } = roomsQuery;
  const contractsQuery = useRoomsWithActiveContracts();
  const { data: roomsWithContracts = [] } = contractsQuery;
  // Chủ chốt 02/10/2026: số chưa có thì vạch xám, không in 0. Thẻ toà hiện ngay khi danh
  // sách toà về; phần lấp đầy (từ phòng + hợp đồng) là vạch xám tới khi đủ hai nguồn —
  // hiện sớm sẽ ra "0% · 0 căn" sai. Nguồn hỏng thì ô lấp đầy để "—", lỗi báo phía trên.
  const buildingsReady = buildingsQuery.data !== undefined;
  const occReady = roomsQuery.data !== undefined && contractsQuery.data !== undefined;
  const occFailed = roomsQuery.isError || contractsQuery.isError;
  const bar = (width: string) => (
    <span className="ld-appear inline-flex align-middle" aria-hidden="true">
      <SkeletonBar className="inline-block" style={{ width }} />
    </span>
  );
  const countOf = (n: number, label: string) =>
    buildingsReady ? n : buildingsQuery.isError ? "—" : <InlineSkeleton label={label} width="1.75rem" />;
  const occOrBar = (value: ReactNode) => (occReady ? value : occFailed ? "—" : bar("1.75rem"));

  const contractEndByRoom = useMemo(() => {
    const map = new Map<string, string | undefined>();
    roomsWithContracts.forEach((r) => map.set(r.id, r.activeContract?.end_date));
    return map;
  }, [roomsWithContracts]);

  const occByBuilding = useMemo(() => {
    const map = new Map<string, Occ>();
    const grouped: Record<string, any[]> = {};
    (allRooms as any[]).forEach((r) => {
      (grouped[r.building_id] ||= []).push(r);
    });
    Object.entries(grouped).forEach(([bid, rooms]) => {
      let occupied = 0;
      let available = 0;
      rooms.forEach((r) => {
        const st = getRoomDisplayStatus(r.status, contractEndByRoom.get(r.id));
        if (st === "OCCUPIED" || st === "EXPIRING_SOON") occupied++;
        else if (st === "AVAILABLE") available++;
      });
      const total = rooms.length;
      map.set(bid, { total, occupied, available, pct: total ? Math.round((occupied / total) * 100) : 0 });
    });
    return map;
  }, [allRooms, contractEndByRoom]);

  const occOf = (id: string): Occ => occByBuilding.get(id) ?? { total: 0, occupied: 0, available: 0, pct: 0 };

  const stats = useMemo(() => {
    const total = buildings.length;
    const active = buildings.filter((b) => b.status === "ACTIVE").length;
    return { total, active, inactive: total - active };
  }, [buildings]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return buildings;
    return buildings.filter(
      (b) =>
        b.name.toLowerCase().includes(q) ||
        b.code?.toLowerCase().includes(q) ||
        b.street_address?.toLowerCase().includes(q) ||
        b.district?.toLowerCase().includes(q),
    );
  }, [buildings, search]);

  const dOcc = detail ? occOf(detail.id) : null;

  return (
    <div className="cm-stage">
      <div className="cm-app">
        <div className="route route-anim">
          <div className="mtop">
            <button className="mback" onClick={() => navigate("/")} aria-label="Về trang chủ">
              <ArrowLeft />
            </button>
            <div className="mtitle">
              <h1>Toà nhà</h1>
              <p>{countOf(stats.total, "số toà nhà")} toà · {countOf(stats.active, "số toà đang hoạt động")} đang hoạt động</p>
            </div>
            <div className="mtop-act">
              <button className="mtop-btn" onClick={() => setCreateOpen(true)}>
                <Plus />
                Thêm
              </button>
            </div>
          </div>

          <div className="mbody">
            <div className="bm-stats">
              <div className="bm-stat" style={{ "--bmc": "#1b1813" } as React.CSSProperties}>
                <div className="n">{countOf(stats.total, "tổng toà")}</div>
                <div className="l">Tổng toà</div>
              </div>
              <div className="bm-stat" style={{ "--bmc": "#15803d" } as React.CSSProperties}>
                <div className="n">{countOf(stats.active, "số toà đang hoạt động")}</div>
                <div className="l">Đang HĐ</div>
              </div>
              <div className="bm-stat" style={{ "--bmc": "#9ca3af" } as React.CSSProperties}>
                <div className="n">{countOf(stats.inactive, "số toà tạm ngừng")}</div>
                <div className="l">Tạm ngừng</div>
              </div>
            </div>

            <div className="cm-search">
              <Search />
              <input
                placeholder="Tìm toà nhà, khu vực…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            <div className="msub">
              <span className="msub-t">Danh sách toà</span>
              <span className="msub-n">{countOf(filtered.length, "số toà trong danh sách")}</span>
            </div>

            {/* Nguồn lấp đầy chỉ báo lỗi ở đây; lúc chờ thì ô lấp đầy trong từng thẻ là vạch xám. */}
            <QueryRegion label="tỉ lệ lấp đầy của toà nhà" queries={[roomsQuery, contractsQuery]} skeleton="none"><></></QueryRegion>

            <QueryRegion label="toà nhà" queries={[buildingsQuery]} skeleton="list" rows={5}>
            {filtered.length === 0 ? (
              <div className="stub"><p>Không tìm thấy toà nhà nào.</p></div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {filtered.map((b) => {
                  const occ = occOf(b.id);
                  return (
                    <div key={b.id} className="sp-bcard" style={{ alignItems: "flex-start" }} onClick={() => setDetail(b)}>
                      <span className="sp-btag">{tagOf(b)}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <span className="nm">{b.name}</span>
                        <span className="sub">{shortAddr(b)}</span>
                        {occReady ? (
                          <>
                            <div className="bld-occ">
                              <div className="track"><div className="fill" style={{ width: `${occ.pct}%` }} /></div>
                              <span className="pct">{occ.pct}%</span>
                            </div>
                            <div className="bld-chips">
                              <span className="bld-chip"><span className="d" style={{ background: "#1f9d57" }} /><b>{occ.occupied}</b> thuê</span>
                              <span className="bld-chip"><span className="d" style={{ background: "#dc2626" }} /><b>{occ.available}</b> trống</span>
                              <span className="bld-chip"><b>{occ.total}</b> căn</span>
                            </div>
                          </>
                        ) : occFailed ? null : (
                          <>
                            <div className="bld-occ">
                              <span className="ld-appear flex-1" aria-hidden="true"><SkeletonBar className="h-1.5" /></span>
                            </div>
                            <div className="bld-chips">{bar("9rem")}</div>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            </QueryRegion>
          </div>

          {detail && dOcc && (
            <div className="sheet-ov" onClick={() => setDetail(null)}>
              <div className="sheet" onClick={(e) => e.stopPropagation()}>
                <div className="sheet-grab" />
                <div className="vd-hd">
                  <div className="vd-hd-t">TOÀ NHÀ · {detail.code || tagOf(detail)}</div>
                  <button className="sheet-x" onClick={() => setDetail(null)} aria-label="Đóng">
                    <X size={18} />
                  </button>
                </div>

                <div className="bd-hero">
                  <div className="bd-tag">{tagOf(detail)}</div>
                  <div style={{ minWidth: 0 }}>
                    <div className="nm">{detail.name}</div>
                    <div className="ad">{fullAddr(detail)}</div>
                  </div>
                </div>

                <div className="bd-stat3">
                  <div className="bd-s"><div className="n" style={{ color: "#1b1813" }}>{occOrBar(dOcc.total)}</div><div className="l">Tổng căn</div></div>
                  <div className="bd-s"><div className="n" style={{ color: "#15803d" }}>{occOrBar(dOcc.occupied)}</div><div className="l">Đang thuê</div></div>
                  <div className="bd-s"><div className="n" style={{ color: "#dc2626" }}>{occOrBar(dOcc.available)}</div><div className="l">Trống</div></div>
                </div>

                <div className="vd-sec"><div className="vd-sec-t">Thông tin toà</div></div>
                <div className="vd-table">
                  <div className="vd-row"><div className="vd-row-l">Trạng thái</div><div className="vd-row-v">{detail.status === "ACTIVE" ? "Đang hoạt động" : "Tạm ngừng"}</div></div>
                  <div className="vd-row"><div className="vd-row-l">Mã toà</div><div className="vd-row-v">{detail.code || "—"}</div></div>
                  <div className="vd-row"><div className="vd-row-l">Số tầng</div><div className="vd-row-v">{detail.total_floors || "—"}</div></div>
                  <div className="vd-row"><div className="vd-row-l">Tỷ lệ lấp đầy</div><div className="vd-row-v">{occOrBar(`${dOcc.pct}%`)}</div></div>
                  {detail.areas && detail.areas.length > 0 && (
                    <div className="vd-row"><div className="vd-row-l">Khu vực</div><div className="vd-row-v">{detail.areas.map((a) => a.name).join(", ")}</div></div>
                  )}
                </div>

                <div className="sheet-acts">
                  <button className="ghost" onClick={() => navigate(`/apartments?building_id=${detail.id}`)}>
                    <Home />
                    Xem căn hộ
                  </button>
                  <button
                    className="primary"
                    onClick={() => {
                      setEditBuilding(detail);
                      setDetail(null);
                    }}
                  >
                    <Pencil />
                    Sửa toà
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Thêm / sửa toà — dùng lại dialog desktop */}
      <BuildingFormDialog open={createOpen} onOpenChange={setCreateOpen} />
      <BuildingFormDialog
        open={!!editBuilding}
        onOpenChange={(o) => {
          if (!o) setEditBuilding(undefined);
        }}
        building={editBuilding}
      />
    </div>
  );
}
