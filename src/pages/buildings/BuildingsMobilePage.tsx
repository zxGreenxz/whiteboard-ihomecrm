import { useMemo, useState } from "react";
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

  const { data: buildingsData = [], isLoading } = useBuildings();
  const buildings = buildingsData as BuildingWithRelations[];
  const { data: allRooms = [] } = useRooms();
  const { data: roomsWithContracts = [] } = useRoomsWithActiveContracts();

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
              <p>{stats.total} toà · {stats.active} đang hoạt động</p>
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
                <div className="n">{stats.total}</div>
                <div className="l">Tổng toà</div>
              </div>
              <div className="bm-stat" style={{ "--bmc": "#15803d" } as React.CSSProperties}>
                <div className="n">{stats.active}</div>
                <div className="l">Đang HĐ</div>
              </div>
              <div className="bm-stat" style={{ "--bmc": "#9ca3af" } as React.CSSProperties}>
                <div className="n">{stats.inactive}</div>
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
              <span className="msub-n">{filtered.length}</span>
            </div>

            {isLoading ? (
              <div className="stub"><p>Đang tải toà nhà…</p></div>
            ) : filtered.length === 0 ? (
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
                        <div className="bld-occ">
                          <div className="track"><div className="fill" style={{ width: `${occ.pct}%` }} /></div>
                          <span className="pct">{occ.pct}%</span>
                        </div>
                        <div className="bld-chips">
                          <span className="bld-chip"><span className="d" style={{ background: "#1f9d57" }} /><b>{occ.occupied}</b> thuê</span>
                          <span className="bld-chip"><span className="d" style={{ background: "#dc2626" }} /><b>{occ.available}</b> trống</span>
                          <span className="bld-chip"><b>{occ.total}</b> căn</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
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
                  <div className="bd-s"><div className="n" style={{ color: "#1b1813" }}>{dOcc.total}</div><div className="l">Tổng căn</div></div>
                  <div className="bd-s"><div className="n" style={{ color: "#15803d" }}>{dOcc.occupied}</div><div className="l">Đang thuê</div></div>
                  <div className="bd-s"><div className="n" style={{ color: "#dc2626" }}>{dOcc.available}</div><div className="l">Trống</div></div>
                </div>

                <div className="vd-sec"><div className="vd-sec-t">Thông tin toà</div></div>
                <div className="vd-table">
                  <div className="vd-row"><div className="vd-row-l">Trạng thái</div><div className="vd-row-v">{detail.status === "ACTIVE" ? "Đang hoạt động" : "Tạm ngừng"}</div></div>
                  <div className="vd-row"><div className="vd-row-l">Mã toà</div><div className="vd-row-v">{detail.code || "—"}</div></div>
                  <div className="vd-row"><div className="vd-row-l">Số tầng</div><div className="vd-row-v">{detail.total_floors || "—"}</div></div>
                  <div className="vd-row"><div className="vd-row-l">Tỷ lệ lấp đầy</div><div className="vd-row-v">{dOcc.pct}%</div></div>
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
