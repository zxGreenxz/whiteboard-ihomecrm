import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  Copy,
  Pencil,
  FileText,
  Phone,
  MessageCircle,
  Trash2,
  User,
  MapPin,
  Car,
  DoorOpen,
  Calendar,
} from 'lucide-react';
import { toast } from 'sonner';
import '@/styles/mobileApp.css';
import { useCustomer } from '@/hooks/useCustomers';
import { useVehicles } from '@/hooks/useVehicles';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import { supabase } from '@/integrations/supabase/client';
import type { VehicleWithRelations } from '@/types/vehicle';
import DeleteCustomerDialog from '@/components/customers/DeleteCustomerDialog';
import { useDragScroll } from '@/components/contracts/detail/useDragScroll';

const VEHICLE_TYPE_LABELS: Record<string, string> = {
  MOTORBIKE: 'Xe máy',
  CAR: 'Ô tô',
  BICYCLE: 'Xe đạp',
  ELECTRIC_BIKE: 'Xe điện',
  OTHER: 'Khác',
};

const CSTATUS: Record<string, { label: string; c: string; bg: string; line: string }> = {
  ACTIVE: { label: 'Đang hoạt động', c: '#1f9d57', bg: '#e6f5ec', line: '#bfe6cd' },
  EXPIRING: { label: 'Sắp hết hạn', c: '#d97706', bg: '#fbf1da', line: '#f0dca8' },
  EXPIRED: { label: 'Hết hạn', c: '#d6453f', bg: '#fcebe9', line: '#f2c8c4' },
  MOVING_OUT: { label: 'Đang trả phòng', c: '#d97706', bg: '#fbf1da', line: '#f0dca8' },
  TERMINATED: { label: 'Đã thanh lý', c: '#8a8377', bg: '#efece6', line: '#ddd8cd' },
  TRANSFERRED: { label: 'Đã chuyển nhượng', c: '#8a8377', bg: '#efece6', line: '#ddd8cd' },
  DRAFT: { label: 'Nháp', c: '#8d8678', bg: '#efece6', line: '#ddd8cd' },
};

const fmtDate = (s: string | null | undefined) => {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '—';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
};
const fmtNum = (n: number | null | undefined) =>
  n == null ? '—' : new Intl.NumberFormat('vi-VN').format(n);
const telHref = (p?: string | null) => 'tel:' + (p || '').replace(/[^\d+]/g, '');
const zaloHref = (p?: string | null) => 'https://zalo.me/' + (p || '').replace(/[^\d]/g, '');

function Field({ label, value, mono, accent }: { label: string; value?: string | null; mono?: boolean; accent?: boolean }) {
  const empty = !value || value === '—';
  return (
    <div className="cd-kv">
      <span className="cd-kv-l">{label}</span>
      <span
        className="cd-kv-v"
        style={{
          ...(mono ? { fontFamily: 'var(--mono)', fontSize: '13px' } : {}),
          ...(accent ? { color: 'var(--brand-600)' } : {}),
          ...(empty ? { color: 'var(--ink-faint)', fontWeight: 600 } : {}),
        }}
      >
        {value || '—'}
      </span>
    </div>
  );
}

/**
 * Chi tiết khách hàng — màn hình app full-screen trên mobile (web-app).
 * Dựng theo handoff Claude Design (ui_kits/mobile-app: CustomerDetailScreen),
 * nối dữ liệu THẬT: useCustomer + useVehicles(customer_id) + contract_customers
 * như CustomerDetailPage desktop. Tái dùng DeleteCustomerDialog. CSS scope riêng.
 */
export default function CustomerDetailMobilePage({ id }: { id: string }) {
  const navigate = useNavigate();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const actsRef = useRef<HTMLDivElement>(null);

  const { data: customer, isLoading } = useCustomer(id);
  const { data: vehiclesData } = useVehicles({ customer_id: id }, { page: 1, pageSize: 50 });
  const vehicles = (vehiclesData?.data ?? []) as VehicleWithRelations[];

  const { data: contractLinks = [] } = useQuery({
    queryKey: ['customer-contracts', id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('contract_customers')
        .select(
          `id, is_representative, notes,
           contract:contracts!contract_customers_contract_id_fkey (
             id, contract_number, status, start_date, end_date, rent_price, deleted_at,
             room:rooms!contracts_room_id_fkey (id, name, building:buildings!rooms_building_id_fkey(id, name))
           )`,
        )
        .eq('customer_id', id)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []).filter((cc: any) => cc.contract && !cc.contract.deleted_at);
    },
  });

  const { data: perms } = useMyPermissions();

  // Drag-to-scroll cho hàng nút (chuột desktop-narrow), không vô tình bấm khi kéo.
  useDragScroll(actsRef);

  if (isLoading) {
    return (
      <Shell onBack={() => navigate('/customers')} title="Đang tải…">
        <div className="stub"><p>Đang tải thông tin khách hàng…</p></div>
      </Shell>
    );
  }
  if (!customer) {
    return (
      <Shell onBack={() => navigate('/customers')} title="Không tìm thấy">
        <div className="stub"><p>Không tìm thấy khách hàng với ID này.</p></div>
      </Shell>
    );
  }

  // Phòng/toà hiển thị ở header — lấy từ HĐ đang hoạt động (nếu có).
  const headerLink =
    (contractLinks as any[]).find((l) => l.contract?.status === 'ACTIVE') || (contractLinks as any[])[0];
  const headerRoom = headerLink?.contract?.room;

  const handleCopy = () => {
    const info = [
      `Họ tên: ${customer.full_name}`,
      `SĐT: ${customer.phone}`,
      customer.email ? `Email: ${customer.email}` : null,
      customer.id_number ? `CMND/CCCD: ${customer.id_number}` : null,
      customer.date_of_birth ? `Ngày sinh: ${fmtDate(customer.date_of_birth)}` : null,
      customer.detailed_address ? `Địa chỉ: ${customer.detailed_address}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    navigator.clipboard.writeText(info);
    toast.success('Đã sao chép thông tin');
  };

  const acts: { key: string; ic: typeof Copy; label: string; danger?: boolean; href?: string; onClick?: () => void; ext?: boolean }[] = [
    { key: 'copy', ic: Copy, label: 'Sao chép', onClick: handleCopy },
    ...(canUse(perms, 'customers', 'edit')
      ? [{ key: 'edit', ic: Pencil, label: 'Sửa', onClick: () => navigate(`/customers/${id}/edit`) }]
      : []),
    ...(canUse(perms, 'customers', 'print')
      ? [{ key: 'ct01', ic: FileText, label: 'Mẫu CT01', onClick: () => navigate(`/customers/${id}/ct01`) }]
      : []),
    ...(customer.phone ? [{ key: 'call', ic: Phone, label: 'Gọi', href: telHref(customer.phone) }] : []),
    ...(customer.phone ? [{ key: 'zalo', ic: MessageCircle, label: 'Zalo', href: zaloHref(customer.phone), ext: true }] : []),
    ...(canUse(perms, 'customers', 'delete')
      ? [{ key: 'delete', ic: Trash2, label: 'Xoá', danger: true, onClick: () => setDeleteOpen(true) }]
      : []),
  ];

  return (
    <Shell onBack={() => navigate('/customers')} title="Chi tiết khách hàng" sub={customer.full_name}>
      {/* Header */}
      <div className="cdh">
        <div className="cdh-av"><User size={22} /></div>
        <div className="cdh-body">
          <h2 className="cdh-name">{customer.full_name}</h2>
          <div className="cdh-sub">
            {headerRoom?.name && (
              <span className="cdh-room">
                <DoorOpen size={12} />
                P.{headerRoom.name}{headerRoom.building?.name ? ` · ${headerRoom.building.name}` : ''}
              </span>
            )}
            {customer.phone && (
              <a className="cdh-phone" href={telHref(customer.phone)}>
                <Phone size={12} />{customer.phone}
              </a>
            )}
          </div>
        </div>
      </div>

      {/* Action row */}
      <div className="cd-acts" ref={actsRef}>
        {acts.map((a) => {
          const Ico = a.ic;
          const inner = (
            <>
              <span className="cd-act-ic"><Ico size={18} /></span>
              <span className="cd-act-l">{a.label}</span>
            </>
          );
          if (a.href) {
            return (
              <a
                key={a.key}
                className={'cd-act' + (a.danger ? ' danger' : '')}
                href={a.href}
                {...(a.ext ? { target: '_blank', rel: 'noreferrer' } : {})}
              >
                {inner}
              </a>
            );
          }
          return (
            <button key={a.key} className={'cd-act' + (a.danger ? ' danger' : '')} onClick={a.onClick}>
              {inner}
            </button>
          );
        })}
      </div>

      {/* Thông tin cá nhân */}
      <div className="cd-card">
        <div className="cd-card-h"><span className="cd-card-t"><User size={16} />Thông tin cá nhân</span></div>
        <div className="cd-grid">
          <Field label="Họ tên" value={customer.full_name} />
          <Field label="SĐT" value={customer.phone} mono accent />
          <Field label="Email" value={customer.email} />
          <Field label="CMND/CCCD" value={customer.id_number} mono />
          <Field label="Ngày sinh" value={fmtDate(customer.date_of_birth)} mono />
          <Field label="Giới tính" value={customer.gender} />
          <Field label="Ngày cấp" value={customer.id_issue_date ? fmtDate(customer.id_issue_date) : ''} mono />
          <Field label="Nơi cấp" value={customer.id_issue_place} />
        </div>
      </div>

      {/* Địa chỉ */}
      <div className="cd-card">
        <div className="cd-card-h"><span className="cd-card-t"><MapPin size={16} />Địa chỉ</span></div>
        <div className="cd-addr-list">
          <Field label="Địa chỉ chi tiết" value={customer.detailed_address} />
          <Field label="Chỗ ở hiện tại" value={customer.current_residence} />
          <Field label="Thường trú" value={customer.permanent_address} />
        </div>
      </div>

      {/* Phương tiện */}
      <div className="cd-card">
        <div className="cd-card-h">
          <span className="cd-card-t"><Car size={16} />Phương tiện</span>
          <span className="cd-count">{vehicles.length}</span>
        </div>
        {vehicles.length === 0 ? (
          <div className="cd-kv-l" style={{ textAlign: 'center', padding: '6px 0' }}>Chưa có phương tiện</div>
        ) : (
          <div className="cd-vtable">
            <div className="cd-vrow cd-vhead">
              <span>Loại</span><span>Tên xe</span><span>Biển số</span><span>Màu</span><span className="r">Phí gửi</span>
            </div>
            {vehicles.map((v) => (
              <div className="cd-vrow" key={v.id}>
                <span>{VEHICLE_TYPE_LABELS[v.vehicle_type] || v.vehicle_type || '—'}</span>
                <span>{v.vehicle_name || '—'}</span>
                <span className="mono">{v.license_plate || '—'}</span>
                <span>{v.color || '—'}</span>
                <span className="r mono">
                  {v.parking_fee != null && v.parking_fee > 0 ? <>{fmtNum(v.parking_fee)}<small>₫</small></> : '—'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Hợp đồng */}
      <div className="cd-card">
        <div className="cd-card-h">
          <span className="cd-card-t"><FileText size={16} />Hợp đồng</span>
          <span className="cd-count">{contractLinks.length}</span>
        </div>
        {contractLinks.length === 0 ? (
          <div className="cd-kv-l" style={{ textAlign: 'center', padding: '6px 0' }}>Chưa có hợp đồng</div>
        ) : (
          <div className="cd-clist">
            {(contractLinks as any[]).map((link) => {
              const ct = link.contract;
              const st = CSTATUS[ct.status] || { label: ct.status, c: '#8d8678', bg: '#efece6', line: '#ddd8cd' };
              return (
                <div className="cd-citem" key={link.id} onClick={() => navigate('/contracts/' + ct.id)}>
                  <div className="cd-citem-h">
                    <span className="cd-citem-code">{ct.contract_number || ct.id.slice(0, 8)}</span>
                    <span className="pill" style={{ color: st.c, background: st.bg, borderColor: st.line }}>
                      <span className="bd" style={{ background: st.c }} />{st.label}
                    </span>
                  </div>
                  <div className="cd-citem-room">
                    {ct.room?.building?.name}{ct.room?.name ? ` · P.${ct.room.name}` : ''}
                  </div>
                  <div className="cd-citem-range">
                    <Calendar size={12} />{fmtDate(ct.start_date)} → {fmtDate(ct.end_date)}
                  </div>
                  <div className="cd-citem-price">
                    {fmtNum(ct.rent_price)}<small>₫</small><span className="cd-citem-per">/ tháng</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <DeleteCustomerDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        customerId={customer.id}
        customerName={customer.full_name}
        onSuccess={() => {
          setDeleteOpen(false);
          navigate('/customers');
        }}
      />
    </Shell>
  );
}

function Shell({ onBack, title, sub, children }: { onBack: () => void; title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="cm-stage">
      <div className="cm-app">
        <div className="route route-anim">
          <div className="mtop">
            <button className="mback" onClick={onBack} aria-label="Quay lại"><ArrowLeft /></button>
            <div className="mtitle">
              <h1>{title}</h1>
              {sub ? <p>{sub}</p> : null}
            </div>
          </div>
          <div className="mbody">{children}</div>
        </div>
      </div>
    </div>
  );
}
