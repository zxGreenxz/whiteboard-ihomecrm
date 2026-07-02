import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, Search, SlidersHorizontal, Car, Phone, MessageCircle, X } from 'lucide-react';
import '@/styles/mobileApp.css';
import { useVehicles } from '@/hooks/useVehicles';
import { useBuildings } from '@/hooks/useBuildings';
import { useRooms } from '@/hooks/useRooms';
import { useMyBuildingScope } from '@/hooks/useMyBuildingScope';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import { usePersistedState } from '@/hooks/usePersistedState';
import VehicleFormDialog from '@/components/vehicles/VehicleFormDialog';
import type { VehicleWithRelations, VehicleFilters, VehicleType } from '@/types/vehicle';
import type { BuildingWithRelations } from '@/types/building';
import type { RoomWithRelations } from '@/types/room';

const VTYPE: Record<VehicleType, { label: string; c: string }> = {
  MOTORBIKE: { label: 'Xe máy', c: '#1f7a52' },
  CAR: { label: 'Ô tô', c: '#2563eb' },
  ELECTRIC_BIKE: { label: 'Xe điện', c: '#7c3aed' },
  BICYCLE: { label: 'Xe đạp', c: '#d97706' },
  OTHER: { label: 'Khác', c: '#8d8678' },
};
const TYPE_KEYS = Object.keys(VTYPE) as VehicleType[];

const telHref = (p?: string | null) => 'tel:' + (p || '').replace(/[^\d+]/g, '');
const zaloHref = (p?: string | null) => 'https://zalo.me/' + (p || '').replace(/[^\d]/g, '');

/**
 * Phương tiện — màn hình app full-screen trên mobile (web-app). Dựng theo handoff
 * Claude Design (ui_kits/mobile-app: VehiclesScreen) nối dữ liệu THẬT: useVehicles
 * + bộ lọc (loại · toà · phòng). Khác desktop: desktop khoá loại = Xe máy, bản
 * mobile cho lọc đủ loại theo thiết kế. Tái dùng VehicleFormDialog. CSS scope riêng.
 */
export default function VehiclesMobilePage() {
  const navigate = useNavigate();

  const [search, setSearch] = usePersistedState('flt:vehicles-mb:search', '');
  const [debounced, setDebounced] = useState('');
  const [vtype, setVtype] = usePersistedState<VehicleType | 'all'>('flt:vehicles-mb:vtype', 'all');
  const [buildingId, setBuildingId] = usePersistedState('flt:vehicles-mb:buildingId', 'all');
  const [roomId, setRoomId] = usePersistedState('flt:vehicles-mb:roomId', 'all');
  const [showFilter, setShowFilter] = useState(false);
  const [pageSize, setPageSize] = useState(30);

  // Dialog
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<VehicleWithRelations | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  const filters = useMemo<VehicleFilters>(
    () => ({
      search: debounced || undefined,
      vehicle_type: vtype !== 'all' ? vtype : undefined,
      building_id: buildingId !== 'all' ? buildingId : undefined,
      room_id: roomId !== 'all' ? roomId : undefined,
    }),
    [debounced, vtype, buildingId, roomId],
  );

  const { data: paged, isLoading } = useVehicles(filters, { page: 1, pageSize });
  const rows = (paged?.data ?? []) as VehicleWithRelations[];
  const totalCount = paged?.count ?? 0;

  const { data: buildingsData } = useBuildings();
  const buildings = (Array.isArray(buildingsData) ? buildingsData : []) as unknown as BuildingWithRelations[];
  const { data: roomsData } = useRooms();
  const rooms = useMemo(() => {
    const all = (Array.isArray(roomsData) ? roomsData : []) as RoomWithRelations[];
    return buildingId !== 'all' ? all.filter((r) => r.building_id === buildingId) : [];
  }, [roomsData, buildingId]);

  const { hasAnyScope } = useMyBuildingScope();
  const { data: perms } = useMyPermissions();
  const canCreate = hasAnyScope && canUse(perms, 'vehicles', 'create');
  const canEdit = canUse(perms, 'vehicles', 'edit');

  const activeCount =
    (vtype !== 'all' ? 1 : 0) + (buildingId !== 'all' ? 1 : 0) + (roomId !== 'all' ? 1 : 0) + (debounced ? 1 : 0);

  const bldName = buildings.find((b) => b.id === buildingId)?.name;
  const roomName = rooms.find((r) => r.id === roomId)?.name;
  const chips: { label: string; clear: () => void }[] = [];
  if (vtype !== 'all') chips.push({ label: VTYPE[vtype].label, clear: () => setVtype('all') });
  if (buildingId !== 'all') chips.push({ label: bldName || 'Toà', clear: () => { setBuildingId('all'); setRoomId('all'); } });
  if (roomId !== 'all') chips.push({ label: 'P.' + (roomName || ''), clear: () => setRoomId('all') });
  const clearAll = () => { setVtype('all'); setBuildingId('all'); setRoomId('all'); setSearch(''); };

  const openEdit = (v: VehicleWithRelations) => {
    if (!canEdit) return;
    setEditing(v);
    setFormOpen(true);
  };

  return (
    <div className="cm-stage">
      <div className="cm-app">
        <div className="route route-anim">
          <div className="mtop">
            <button className="mback" onClick={() => navigate('/')} aria-label="Về trang chủ">
              <ArrowLeft />
            </button>
            <div className="mtitle">
              <h1>Phương tiện</h1>
              <p>{totalCount} xe đăng ký</p>
            </div>
            <div className="mtop-act">
              <button
                className={'mtop-btn ghost fbtn' + (activeCount ? ' act' : '')}
                onClick={() => setShowFilter((v) => !v)}
                aria-label="Bộ lọc"
              >
                <SlidersHorizontal size={15} />
                {activeCount ? <span className="fbadge">{activeCount}</span> : null}
              </button>
              {canCreate && (
                <button className="mtop-btn" onClick={() => { setEditing(null); setFormOpen(true); }}>
                  <Plus />Thêm
                </button>
              )}
            </div>
          </div>

          <div className="mbody">
            {showFilter && (
              <div className="fpanel">
                <div className="fsearchbar">
                  <Search />
                  <input
                    placeholder="Tìm biển số, tên xe, chủ xe…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <div className="fgroup">
                  <span className="fglabel">Loại phương tiện</span>
                  <div className="fchips">
                    <button className={'fpchip' + (vtype === 'all' ? ' on' : '')} onClick={() => setVtype('all')}>Tất cả</button>
                    {TYPE_KEYS.map((k) => (
                      <button key={k} className={'fpchip' + (vtype === k ? ' on' : '')} onClick={() => setVtype(k)}>
                        {VTYPE[k].label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="fgroup">
                  <span className="fglabel">Toà nhà</span>
                  <div className="fchips">
                    <button
                      className={'fpchip' + (buildingId === 'all' ? ' on' : '')}
                      onClick={() => { setBuildingId('all'); setRoomId('all'); }}
                    >
                      Tất cả toà
                    </button>
                    {buildings.map((b) => (
                      <button
                        key={b.id}
                        className={'fpchip' + (buildingId === b.id ? ' on' : '')}
                        onClick={() => { setBuildingId(b.id); setRoomId('all'); }}
                      >
                        {b.name}
                      </button>
                    ))}
                  </div>
                </div>
                {buildingId !== 'all' && rooms.length > 0 && (
                  <div className="fgroup">
                    <span className="fglabel">Phòng</span>
                    <div className="fchips">
                      <button className={'fpchip' + (roomId === 'all' ? ' on' : '')} onClick={() => setRoomId('all')}>Tất cả phòng</button>
                      {rooms.map((r) => (
                        <button key={r.id} className={'fpchip' + (roomId === r.id ? ' on' : '')} onClick={() => setRoomId(r.id)}>
                          P.{r.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="fp-apply">
                  <button className="fp-btn reset" onClick={clearAll}>Xoá lọc</button>
                  <button className="fp-btn apply" onClick={() => setShowFilter(false)}>Xong</button>
                </div>
              </div>
            )}

            {chips.length > 0 && (
              <div className="achips">
                {chips.map((c, i) => (
                  <button key={i} className="achip" onClick={c.clear}>{c.label}<X size={12} /></button>
                ))}
                {chips.length > 1 && <button className="achip clear" onClick={clearAll}>Xoá tất cả</button>}
              </div>
            )}

            {isLoading ? (
              <div className="stub"><p>Đang tải phương tiện…</p></div>
            ) : rows.length === 0 ? (
              <div className="stub"><p>Không có phương tiện nào phù hợp.</p></div>
            ) : (
              <div className="rowlist">
                {rows.map((v) => {
                  const t = VTYPE[v.vehicle_type] ?? VTYPE.OTHER;
                  const owner = v.owner_name || v.customer?.full_name;
                  const phone = v.customer?.phone;
                  const loc = [v.building?.name, v.room?.name ? `P.${v.room.name}` : ''].filter(Boolean).join(' · ');
                  return (
                    <div className="veh" key={v.id} onClick={() => openEdit(v)}>
                      <span className="veh-ic" style={{ background: t.c + '1c', color: t.c }}><Car size={20} /></span>
                      <div className="veh-body">
                        <div className="veh-l1">
                          <span className="veh-plate">{v.license_plate || '—'}</span>
                          <span className="veh-type" style={{ color: t.c, background: t.c + '18' }}>{t.label}</span>
                          {phone && (
                            <span className="veh-acts">
                              <a className="cust-ic call" href={telHref(phone)} aria-label="Gọi" onClick={(e) => e.stopPropagation()}>
                                <Phone size={14} />
                              </a>
                              <a className="cust-ic zalo" href={zaloHref(phone)} target="_blank" rel="noreferrer" aria-label="Zalo" onClick={(e) => e.stopPropagation()}>
                                <MessageCircle size={14} />
                              </a>
                            </span>
                          )}
                        </div>
                        <div className="veh-name">{[v.vehicle_name, v.color].filter(Boolean).join(' · ') || '—'}</div>
                        <div className="veh-meta">{[owner, loc].filter(Boolean).join(' · ') || '—'}</div>
                      </div>
                    </div>
                  );
                })}
                {totalCount > rows.length && (
                  <button className="loadmore" onClick={() => setPageSize((s) => s + 30)}>
                    Tải thêm ({totalCount - rows.length})
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <VehicleFormDialog open={formOpen} onOpenChange={setFormOpen} vehicle={editing || undefined} />
    </div>
  );
}
