import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Plus, Search, Home, DoorOpen, Phone, MessageCircle, Copy, Car } from 'lucide-react';
import { toast } from 'sonner';
import '@/styles/mobileApp.css';
import { useCustomers } from '@/hooks/useCustomers';
import { useBuildings } from '@/hooks/useBuildings';
import { useMyBuildingScope } from '@/hooks/useMyBuildingScope';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import { usePersistedState } from '@/hooks/usePersistedState';
import { supabase } from '@/integrations/supabase/client';
import type { Customer, CustomerStatus, CustomerFilters } from '@/types/customer';
import type { BuildingWithRelations } from '@/types/building';

const VEHICLE_TYPE_LABELS: Record<string, string> = {
  MOTORBIKE: 'Xe máy',
  CAR: 'Ô tô',
  BICYCLE: 'Xe đạp',
  ELECTRIC_BIKE: 'Xe điện',
  OTHER: 'Khác',
};

const copyPhone = (phone: string, e: React.MouseEvent) => {
  e.stopPropagation();
  navigator.clipboard.writeText(phone);
  toast.success('Đã sao chép SĐT');
};

const fmtDate = (s: string | null | undefined) => {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
};
const telHref = (p?: string | null) => 'tel:' + (p || '').replace(/[^\d+]/g, '');
const zaloHref = (p?: string | null) => 'https://zalo.me/' + (p || '').replace(/[^\d]/g, '');

const STATUS_TABS: { id: CustomerStatus; label: string }[] = [
  { id: 'RENTING', label: 'Đang thuê' },
  { id: 'MOVED_OUT', label: 'Đã rời đi' },
  { id: 'WALK_IN', label: 'Vãng lai' },
];
/**
 * Khách hàng — màn hình app full-screen trên mobile (web-app).
 * Dựng theo handoff Claude Design (ui_kits/mobile-app: CustomersScreen) nhưng nối
 * dữ liệu THẬT: useCustomers như desktop, lọc toà server-side qua filters.building_id
 * (đúng cách desktop CustomersPage làm). CSS scope riêng (.cm-stage/.cm-app), ngoài
 * MainLayout — ← về trang chủ, chạm thẻ → chi tiết.
 */
export default function CustomersMobilePage() {
  const navigate = useNavigate();

  const [search, setSearch] = usePersistedState('flt:customers-mb:search', '');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = usePersistedState<CustomerStatus>('flt:customers-mb:status', 'RENTING');
  const [buildingId, setBuildingId] = usePersistedState('flt:customers-mb:buildingId', '');
  const [pageSize, setPageSize] = useState(30);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  // Lọc toà server-side (building_id) — lọc client trên trang đã phân trang
  // làm sót khách ở các trang sau + totalCount sai.
  const filters = useMemo<CustomerFilters>(
    () => ({
      status,
      search: debounced || undefined,
      building_id: buildingId || undefined,
    }),
    [status, debounced, buildingId],
  );

  const { data: paged, isLoading } = useCustomers(filters, { page: 1, pageSize });

  const allRows = (paged?.data ?? []) as Customer[];
  const rows = allRows;
  const totalCount = paged?.count ?? 0;

  // Lấy phương tiện (loại + biển số) của các KH trên trang hiện tại — 1 truy vấn
  // gộp theo customer_id, map về xe đầu tiên mỗi khách (để hiện kế bên phòng).
  const custIds = useMemo(() => allRows.map((c) => c.id), [allRows]);
  const { data: vehMap } = useQuery({
    queryKey: ['customers-mobile-vehicles', custIds],
    enabled: custIds.length > 0,
    queryFn: async () => {
      const { data } = await supabase
        .from('vehicles')
        .select('customer_id, vehicle_type, license_plate')
        .in('customer_id', custIds)
        .is('deleted_at', null);
      const m = new Map<string, { type: string | null; plate: string | null }>();
      for (const v of (data ?? []) as any[]) {
        if (v.customer_id && !m.has(v.customer_id)) {
          m.set(v.customer_id, { type: v.vehicle_type, plate: v.license_plate });
        }
      }
      return m;
    },
  });

  const { data: buildingsData } = useBuildings();
  const buildings = (Array.isArray(buildingsData) ? buildingsData : []) as unknown as BuildingWithRelations[];

  const { hasAnyScope } = useMyBuildingScope();
  const { data: perms } = useMyPermissions();
  const canCreate = hasAnyScope && canUse(perms, 'customers', 'create');

  return (
    <div className="cm-stage">
      <div className="cm-app">
        <div className="route route-anim">
          <div className="mtop">
            <button className="mback" onClick={() => navigate('/')} aria-label="Về trang chủ">
              <ArrowLeft />
            </button>
            <div className="mtitle">
              <h1>Khách hàng</h1>
              <p>{totalCount} khách · {STATUS_TABS.find((t) => t.id === status)?.label.toLowerCase()}</p>
            </div>
            {canCreate && (
              <div className="mtop-act">
                <button className="mtop-btn" onClick={() => navigate('/customers/new')}>
                  <Plus />Thêm
                </button>
              </div>
            )}
          </div>

          <div className="mbody">
            <div className="lfilter">
              {STATUS_TABS.map((t) => (
                <button
                  key={t.id}
                  className={'lchip' + (status === t.id ? ' on' : '')}
                  onClick={() => setStatus(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div className="cm-filterbar">
              <select
                className="cm-select"
                value={buildingId}
                onChange={(e) => setBuildingId(e.target.value)}
                aria-label="Toà nhà"
              >
                <option value="">Tất cả toà</option>
                {buildings.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>

            <div className="cm-search">
              <Search />
              <input
                placeholder="Tìm tên, SĐT, email, CCCD…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            {isLoading ? (
              <div className="stub"><p>Đang tải khách hàng…</p></div>
            ) : rows.length === 0 ? (
              <div className="stub"><p>Không tìm thấy khách hàng phù hợp.</p></div>
            ) : (
              <div className="rowlist">
                {rows.map((c) => {
                  const room = (c as any).current_room_name as string | null;
                  const bld = (c as any).current_building_name as string | null;
                  const addr = c.detailed_address || c.current_residence || c.permanent_address;
                  const veh = vehMap?.get(c.id);
                  return (
                    <div className="cust" key={c.id} onClick={() => navigate('/customers/' + c.id)}>
                      <div className="cust-body">
                        <div className="cust-l1">
                          <span className="cust-name">{c.full_name}</span>
                          {c.phone && (
                            <span className="cust-acts">
                              <a
                                className="cust-ic call"
                                href={telHref(c.phone)}
                                aria-label={'Gọi ' + c.full_name}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <Phone size={15} />
                              </a>
                              <a
                                className="cust-ic zalo"
                                href={zaloHref(c.phone)}
                                target="_blank"
                                rel="noreferrer"
                                aria-label={'Zalo ' + c.full_name}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <MessageCircle size={15} />
                              </a>
                            </span>
                          )}
                        </div>
                        {(c.phone || c.id_number || c.date_of_birth) && (
                          <div className="cust-idline">
                            {c.phone && (
                              <button
                                className="cust-copy"
                                onClick={(e) => copyPhone(c.phone, e)}
                                aria-label={'Sao chép SĐT ' + c.full_name}
                              >
                                <span className="cust-mono cust-phone">{c.phone}</span>
                                <Copy size={12} />
                              </button>
                            )}
                            {c.phone && c.id_number && <span className="cust-dot">·</span>}
                            {c.id_number && <span className="cust-mono">{c.id_number}</span>}
                            {(c.phone || c.id_number) && c.date_of_birth && <span className="cust-dot">·</span>}
                            {c.date_of_birth && <span className="cust-meta">{fmtDate(c.date_of_birth)}</span>}
                          </div>
                        )}
                        {addr && (
                          <div className="cust-addr">
                            <Home size={12} />
                            <span>{addr}</span>
                          </div>
                        )}
                        {(room || bld || veh?.plate || veh?.type) && (
                          <div className="cust-l3">
                            {(room || bld) && (
                              <span className="cust-room">
                                <DoorOpen size={12} />
                                {room ? `P.${room}` : ''}{room && bld ? ' · ' : ''}{bld || ''}
                              </span>
                            )}
                            {veh?.type && (
                              <span className="cust-veh">
                                <Car size={12} />
                                {VEHICLE_TYPE_LABELS[veh.type] || veh.type}
                              </span>
                            )}
                            {veh?.plate && <span className="cust-plate">{veh.plate}</span>}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
                {totalCount > allRows.length && (
                  <button className="loadmore" onClick={() => setPageSize((s) => s + 30)}>
                    Tải thêm ({totalCount - allRows.length})
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
