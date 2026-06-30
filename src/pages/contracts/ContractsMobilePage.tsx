import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, Search, Clock } from 'lucide-react';
import './contractsMobile.css';
import { useContractsPaged, useContractStats } from '@/hooks/useContracts';
import { useBuildings } from '@/hooks/useBuildings';
import { useRooms } from '@/hooks/useRooms';
import { useMyBuildingScope } from '@/hooks/useMyBuildingScope';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { useRenewedContractIds } from '@/hooks/useRenewedContracts';
import { canUse } from '@/lib/permissionPages';
import { uniqueRoomNames, compareBuildingThenRoom } from '@/lib/roomSort';
import { getRepresentativeName } from '@/lib/contractCustomerHelpers';
import {
  getContractDisplayStatus,
  CONTRACT_STATUS_CONFIG,
  isContractInEffect,
} from '@/types/contract';
import type {
  ContractWithRelations,
  ContractStatFilter,
  ContractLifecycleFilter,
  ContractStats,
  ContractDisplayStatus,
} from '@/types/contract';
import type { BuildingWithRelations } from '@/types/building';
import type { RoomWithRelations } from '@/types/room';
import { ContractFormDialog } from '@/components/contracts/ContractFormDialog';

// Định dạng tiền gọn (khớp DepositBadge desktop): "1.250.000 đ".
const fmtVND = (n: number) => new Intl.NumberFormat('vi-VN').format(n) + ' đ';
const fmtNum = (n: number) => new Intl.NumberFormat('vi-VN').format(n);
const fmtDate = (s: string) => {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '—';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
};

// Ngưỡng làm tròn cọc — khớp DEPOSIT_SHORTFALL_THRESHOLD của ContractListTable.
const DEPOSIT_SHORTFALL_THRESHOLD = 10000;

// Màu hex theo trạng thái HIỂN THỊ (khớp palette data.js của design).
const STATUS_HEX: Record<ContractDisplayStatus, { c: string; bg: string; line: string }> = {
  ACTIVE: { c: '#1f9d57', bg: '#e6f5ec', line: '#bfe6cd' },
  EXPIRING: { c: '#d97706', bg: '#fbf1da', line: '#f0dca8' },
  EXPIRED: { c: '#d6453f', bg: '#fcebe9', line: '#f2c8c4' },
  MOVING_OUT: { c: '#d97706', bg: '#fbf1da', line: '#f0dca8' },
  TERMINATED: { c: '#8a8377', bg: '#efece6', line: '#ddd8cd' },
  TRANSFERRED: { c: '#8a8377', bg: '#efece6', line: '#ddd8cd' },
  DRAFT: { c: '#8d8678', bg: '#efece6', line: '#ddd8cd' },
};

// Badge cọc (chỉ HĐ đang hiệu lực) — logic y hệt DepositBadge desktop, tô theo
// pill của design: Đủ cọc (xanh) / Cọc ở HĐ đầu (xanh dương) / Thiếu cọc (cam).
function depositBadge(c: ContractWithRelations): { label: string; c: string; bg: string; line: string } | null {
  if (!isContractInEffect(c.status)) return null;
  const total = c.total_deposit || 0;
  if (total <= 0) return null;
  const remaining = total - (c.deposit_paid || 0);
  if (remaining < DEPOSIT_SHORTFALL_THRESHOLD) {
    return { label: 'Đủ cọc', c: '#1f9d57', bg: '#e6f5ec', line: '#bfe6cd' };
  }
  const firstInvoice = (c as { deposit_debt_mode?: string | null }).deposit_debt_mode === 'FIRST_INVOICE';
  return firstInvoice
    ? { label: `Cọc ở HĐ đầu ${fmtVND(remaining)}`, c: '#2563eb', bg: '#e7eefc', line: '#c9dafa' }
    : { label: `Thiếu cọc ${fmtVND(remaining)}`, c: '#d97706', bg: '#fbf1da', line: '#f0dca8' };
}

/**
 * Hợp đồng — màn hình app trên mobile (web-app).
 * Dựng pixel theo handoff Claude Design (ui_kits/mobile-app: ContractsScreen),
 * nhưng nối dữ liệu THẬT: cùng useContractsPaged + useContractStats + lọc như
 * desktop, helper trạng thái/cọc/khách tái dùng. CSS scope riêng (.cm-stage/
 * .cm-app), full-screen ngoài MainLayout — nút ← về trang chủ, chạm thẻ → chi tiết.
 */
export default function ContractsMobilePage() {
  const navigate = useNavigate();

  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [buildingId, setBuildingId] = useState(''); // '' = tất cả toà
  const [roomName, setRoomName] = useState('all');
  const [stat, setStat] = useState<ContractStatFilter>('ALL');
  const [pageSize, setPageSize] = useState(30);
  const [formOpen, setFormOpen] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  // Mặc định "Còn hạn" = LOẠI BỎ hợp đồng đã thanh lý (lifecycle ACTIVE). Chỉ
  // tab "Đã thanh lý" mới xem nhóm terminated. (Bỏ chế độ "Tất cả" gồm cả thanh lý.)
  const lifecycle: ContractLifecycleFilter =
    stat === 'TERMINATED' ? 'TERMINATED' : 'ACTIVE';
  const buildingIds = buildingId ? [buildingId] : undefined;

  const { data: paged, isLoading, isError, refetch } = useContractsPaged(
    {
      search: debounced || undefined,
      building_ids: buildingIds,
      room_name: roomName !== 'all' ? roomName : undefined,
      lifecycle,
      stat,
    },
    { page: 1, pageSize },
  );

  const rows = useMemo(
    () =>
      ((paged?.data ?? []) as ContractWithRelations[]).slice().sort((a, b) =>
        compareBuildingThenRoom(
          a.room?.building?.name ?? '',
          a.room?.name ?? '',
          b.room?.building?.name ?? '',
          b.room?.name ?? '',
        ),
      ),
    [paged],
  );
  const totalCount = paged?.count ?? 0;

  const { data: statsData } = useContractStats(buildingId ? [buildingId] : []);
  const stats: ContractStats = statsData ?? { total: 0, expiring: 0, expired: 0, terminated: 0 };

  const { data: buildingsData } = useBuildings();
  const buildings = useMemo(
    () => (Array.isArray(buildingsData) ? buildingsData : []) as unknown as BuildingWithRelations[],
    [buildingsData],
  );
  const { data: roomsData } = useRooms();
  const roomOpts = useMemo(() => {
    const all = (Array.isArray(roomsData) ? roomsData : []) as RoomWithRelations[];
    return uniqueRoomNames(buildingId ? all.filter((r) => r.building_id === buildingId) : all);
  }, [roomsData, buildingId]);

  const { data: renewedSet } = useRenewedContractIds(rows.map((r) => r.id));

  const { hasAnyScope: hasBuildingScope } = useMyBuildingScope();
  const { data: perms } = useMyPermissions();
  const canCreate = hasBuildingScope && canUse(perms, 'contracts', 'create');

  // Tab đầu "Còn hạn" (mặc định) = tổng trừ đã thanh lý.
  const statTabs: { id: ContractStatFilter; label: string; n: number }[] = [
    { id: 'ALL', label: 'Còn hạn', n: Math.max(0, stats.total - stats.terminated) },
    { id: 'EXPIRING', label: 'Sắp hết hạn', n: stats.expiring },
    { id: 'EXPIRED', label: 'Quá hạn', n: stats.expired },
    { id: 'TERMINATED', label: 'Đã thanh lý', n: stats.terminated },
  ];

  return (
    <div className="cm-stage">
      <div className="cm-app">
        <div className="route route-anim">
          <div className="mtop">
            <button className="mback" onClick={() => navigate('/')} aria-label="Về trang chủ">
              <ArrowLeft />
            </button>
            <div className="mtitle">
              <h1>Hợp đồng</h1>
              <p>{stats.total} hợp đồng thuê</p>
            </div>
            {canCreate && (
              <div className="mtop-act">
                <button className="mtop-btn" onClick={() => setFormOpen(true)}>
                  <Plus />Tạo
                </button>
              </div>
            )}
          </div>

          <div className="mbody">
            <div className="lfilter">
              {statTabs.map((t) => (
                <button
                  key={t.id}
                  className={'lchip' + (stat === t.id ? ' on' : '')}
                  onClick={() => setStat(t.id)}
                >
                  {t.label}<span className="cnt">{t.n}</span>
                </button>
              ))}
            </div>

            {/* Bộ lọc thường trực: dropdown Toà nhà · Phòng (1 dòng) + ô tìm kiếm
                nhanh — chạy server như ô tìm kiếm desktop. */}
            <div className="cm-filterbar">
              <select
                className="cm-select"
                value={buildingId}
                onChange={(e) => { setBuildingId(e.target.value); setRoomName('all'); }}
                aria-label="Toà nhà"
              >
                <option value="">Tất cả toà</option>
                {buildings.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
              <select
                className="cm-select"
                value={roomName}
                onChange={(e) => setRoomName(e.target.value)}
                aria-label="Phòng"
              >
                <option value="all">Tất cả phòng</option>
                {roomOpts.map((rn) => (
                  <option key={rn} value={rn}>{rn}</option>
                ))}
              </select>
            </div>

            <div className="cm-search">
              <Search />
              <input
                placeholder="Tìm mã HĐ, tên khách, SĐT, tên phòng…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            {isLoading ? (
              <div className="stub"><p>Đang tải hợp đồng…</p></div>
            ) : isError ? (
              <div className="stub">
                <p>Không tải được hợp đồng.</p>
                <button onClick={() => refetch()} style={{ marginTop: 8, textDecoration: 'underline' }}>Thử lại</button>
              </div>
            ) : rows.length === 0 ? (
              <div className="stub"><p>Không có hợp đồng nào phù hợp bộ lọc.</p></div>
            ) : (
              <div className="rowlist">
                {rows.map((c) => {
                  const ds = getContractDisplayStatus(c);
                  const sc = STATUS_HEX[ds] ?? STATUS_HEX.ACTIVE;
                  const label = CONTRACT_STATUS_CONFIG[ds]?.label ?? '';
                  const dep = depositBadge(c);
                  const renewed = !!renewedSet?.has(c.id);
                  return (
                    <div
                      className="ctr"
                      key={c.id}
                      style={{ borderColor: sc.line }}
                      onClick={() => navigate('/contracts/' + c.id)}
                    >
                      <span className="ctr-bar" style={{ background: sc.c }} />
                      <div className="ctr-body">
                        <div className="ctr-l1">
                          <span className="ctr-loc">P.{c.room?.name ?? '—'} · {c.room?.building?.name ?? '—'}</span>
                          <div className="ctr-badges">
                            {renewed && (
                              <span className="pill" style={{ color: '#2563eb', background: '#e7eefc', borderColor: '#c9dafa' }}>
                                Đã gia hạn
                              </span>
                            )}
                            <span className="pill" style={{ color: sc.c, background: sc.bg, borderColor: sc.line }}>
                              <span className="bd" style={{ background: sc.c }} />{label}
                            </span>
                          </div>
                        </div>
                        <div className="ctr-tenant">{getRepresentativeName(c)}</div>
                        <div className="ctr-meta">
                          <span className="ctr-rent">{fmtNum(c.rent_price || 0)}<small>₫/th</small></span>
                          <span className="ctr-dates"><Clock />{fmtDate(c.start_date)} → {fmtDate(c.end_date)}</span>
                        </div>
                        {dep && (
                          <div className="ctr-foot">
                            <span
                              className="pill"
                              style={{ color: dep.c, background: dep.bg, borderColor: dep.line, fontSize: 10.5 }}
                            >
                              {dep.label}
                            </span>
                          </div>
                        )}
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

      <ContractFormDialog open={formOpen} onOpenChange={setFormOpen} />
    </div>
  );
}
