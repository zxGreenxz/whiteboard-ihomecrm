import { FileText, User, DoorOpen, Coins, Package, Clock, Phone, Mail, CreditCard, AlertCircle, CheckCircle } from 'lucide-react';
import { format, differenceInDays } from 'date-fns';
import { vi } from 'date-fns/locale';
import {
  getContractDisplayStatus,
  CONTRACT_STATUS_CONFIG,
  type ContractWithRelations,
  type ContractDisplayStatus,
} from '@/types/contract';
import type { ContractServiceItem, ContractDepositVoucher } from './types';

const fmtNum = (n: number) => new Intl.NumberFormat('vi-VN').format(Math.round(n || 0));
const fmtDate = (d?: string | null) => (d ? format(new Date(d), 'dd/MM/yyyy', { locale: vi }) : '—');

const STATUS_HEX: Record<ContractDisplayStatus, { c: string; bg: string; line: string }> = {
  ACTIVE: { c: '#1f9d57', bg: '#e6f5ec', line: '#bfe6cd' },
  EXPIRING: { c: '#d97706', bg: '#fbf1da', line: '#f0dca8' },
  EXPIRED: { c: '#d6453f', bg: '#fcebe9', line: '#f2c8c4' },
  MOVING_OUT: { c: '#d97706', bg: '#fbf1da', line: '#f0dca8' },
  TERMINATED: { c: '#8a8377', bg: '#efece6', line: '#ddd8cd' },
  TRANSFERRED: { c: '#8a8377', bg: '#efece6', line: '#ddd8cd' },
  DRAFT: { c: '#8d8678', bg: '#efece6', line: '#ddd8cd' },
};
const CYCLE: Record<string, string> = { MONTHLY: 'Hàng tháng', QUARTERLY: 'Hàng quý', SEMI_ANNUAL: '6 tháng', ANNUAL: 'Hàng năm' };
const SVC_META: Record<string, string> = { METER_READING: 'Theo chỉ số đồng hồ', FIXED: 'Cố định hàng tháng', PER_PERSON: 'Theo số người', PER_ROOM: 'Theo căn hộ' };

const KV = ({ label, value, accent }: { label: string; value: React.ReactNode; accent?: string }) => (
  <div className="cd-kv"><span className="cd-kv-l">{label}</span><span className="cd-kv-v" style={accent ? { color: accent } : undefined}>{value}</span></div>
);

export function ContractInfoTab({
  contract, services, customers, depositVouchers, onOpenCustomer,
}: {
  contract: ContractWithRelations;
  services: ContractServiceItem[];
  customers: NonNullable<ContractWithRelations['contract_customers']>;
  depositVouchers: ContractDepositVoucher[];
  onOpenCustomer: (customerId: string) => void;
}) {
  const ds = getContractDisplayStatus(contract);
  const sc = STATUS_HEX[ds] ?? STATUS_HEX.ACTIVE;
  const label = CONTRACT_STATUS_CONFIG[ds]?.label ?? '';

  // Tiến độ + thời gian (ngày)
  const start = new Date(contract.start_date);
  const end = new Date(contract.end_date);
  const total = Math.max(1, differenceInDays(end, start));
  const elapsed = Math.min(total, Math.max(0, differenceInDays(new Date(), start)));
  const remaining = Math.max(0, total - elapsed);
  const progress = Math.min(100, Math.max(0, Math.round((elapsed / total) * 100)));

  // Tiền cọc
  const depTotal = contract.total_deposit || 0;
  const depPaid = contract.deposit_paid || 0;
  const depLeft = contract.deposit_remaining ?? depTotal - depPaid;

  return (
    <>
      <div className="cd-card">
        <div className="cd-card-h">
          <span className="cd-card-t"><FileText size={16} />Thông tin hợp đồng</span>
          <span className="pill" style={{ color: sc.c, background: sc.bg, borderColor: sc.line }}><span className="bd" style={{ background: sc.c }} />{label}</span>
        </div>
        <div className="cd-grid">
          <KV label="Số hợp đồng" value={contract.contract_number || contract.id.slice(0, 8)} />
          <KV label="Ngày ký" value={fmtDate(contract.signed_date)} />
          <KV label="Ngày bắt đầu" value={fmtDate(contract.start_date)} />
          <KV label="Ngày kết thúc" value={fmtDate(contract.end_date)} />
          <KV label="Giá thuê" value={`${fmtNum(contract.rent_price || 0)} ₫`} accent="var(--brand-600)" />
          <KV label="Chu kỳ thanh toán" value={CYCLE[contract.payment_cycle] ?? contract.payment_cycle} />
        </div>
        <div className="cd-prog">
          <div className="cd-prog-h"><span>Tiến độ hợp đồng</span><span className="cd-prog-pct">{progress}%</span></div>
          <div className="cd-prog-track"><div className="cd-prog-fill" style={{ width: progress + '%' }} /></div>
        </div>
      </div>

      <div className="cd-card">
        <div className="cd-card-h">
          <span className="cd-card-t"><User size={16} />Thông tin khách hàng</span>
          {customers.length > 1 && <span className="cd-count">{customers.length}</span>}
        </div>
        {customers.length ? customers.map((cc, i) => {
          const name = cc.customer?.full_name || '—';
          const ini = name.trim().split(/\s+/).slice(-1)[0]?.[0]?.toUpperCase() || '?';
          return (
            <div className={'cd-cust-block' + (i > 0 ? ' sep' : '')} key={cc.id}>
              <div className="cd-cust">
                <button
                  className="cd-cust-av cd-cust-av-btn"
                  onClick={() => onOpenCustomer(cc.customer_id)}
                  title="Xem chi tiết khách hàng"
                  aria-label={'Xem chi tiết ' + name}
                >
                  {ini}
                </button>
                <div className="cd-cust-body">
                  <div className="cd-cust-name">{name}{cc.is_representative && <span className="cd-rep">Đại diện</span>}</div>
                  <div className="cd-cust-sub">{cc.is_representative ? 'Khách thuê chính' : 'Khách ở cùng'}</div>
                </div>
              </div>
              <div className="cd-contact">
                <div className="cd-ct"><span className="cd-ct-l"><Phone size={13} />Số điện thoại</span><span className="cd-ct-v">{cc.customer?.phone || '—'}</span></div>
                <div className="cd-ct"><span className="cd-ct-l"><Mail size={13} />Email</span><span className="cd-ct-v">{cc.customer?.email || '—'}</span></div>
                <div className="cd-ct"><span className="cd-ct-l"><CreditCard size={13} />CCCD/CMND</span><span className="cd-ct-v">{cc.customer?.id_number || '—'}</span></div>
              </div>
            </div>
          );
        }) : <div className="cd-cust-sub">Chưa có khách hàng.</div>}
      </div>

      <div className="cd-card">
        <div className="cd-card-h"><span className="cd-card-t"><DoorOpen size={16} />Thông tin căn hộ</span></div>
        <div className="cd-grid">
          <KV label="Vị trí" value={`P.${contract.room?.name ?? '—'}`} />
          <KV label="Toà nhà" value={contract.room?.building?.name ?? '—'} />
        </div>
      </div>

      <div className="cd-card">
        <div className="cd-card-h"><span className="cd-card-t"><Coins size={16} />Tiền cọc</span></div>
        <div className="cd-money">
          <div className="cd-money-row"><span>Tổng tiền cọc</span><b>{fmtNum(depTotal)} ₫</b></div>
          <div className="cd-money-row"><span>Đã thu</span><b className="pos">{fmtNum(depPaid)} ₫</b></div>
          <div className="cd-money-row total"><span>Còn lại</span><b style={{ color: depLeft > 0 ? '#d6453f' : 'var(--ink)' }}>{fmtNum(depLeft)} ₫</b></div>
        </div>
        <div className={'cd-banner ' + (depLeft > 0 ? 'warn' : 'ok')}>
          {depLeft > 0 ? <AlertCircle size={15} /> : <CheckCircle size={15} />}
          {depLeft > 0 ? `Còn thiếu ${fmtNum(depLeft)}₫ tiền cọc` : 'Đã thu đủ tiền cọc'}
        </div>
        {depositVouchers.length > 0 && (
          <>
            <div className="cd-rcpt-h">Phiếu thu cọc đã ghi nhận</div>
            {depositVouchers.map((r) => (
              <div className="cd-rcpt" key={r.id}>
                <div className="cd-rcpt-l">
                  <span className="lrow-code">{r.code || r.id.slice(0, 8)}</span>
                  <span className="cd-rcpt-sub">{fmtDate(r.voucher_date)}{r.account?.name ? ` · ${r.account.name}` : ''}</span>
                </div>
                <span className="cd-rcpt-amt">{fmtNum(r.total_amount)} ₫</span>
              </div>
            ))}
          </>
        )}
      </div>

      <div className="cd-card">
        <div className="cd-card-h"><span className="cd-card-t"><Package size={16} />Dịch vụ áp dụng</span><span className="cd-count">{services.length}</span></div>
        {services.length ? (
          <div className="cd-svc-list">
            {services.map((sv) => {
              const meter = sv.service.type === 'METER_READING';
              let meta = SVC_META[sv.service.type] ?? sv.service.type;
              if (meter && sv.initial_reading != null) meta += ` · đầu kỳ ${sv.initial_reading}`;
              return (
                <div className="cd-svc" key={sv.id}>
                  <div className="cd-svc-body"><div className="cd-svc-name">{sv.service.name}</div><div className="cd-svc-meta">{meta}</div></div>
                  <div className="cd-svc-price">{fmtNum(sv.unit_price)}<small>đ/{sv.service.unit || 'đv'}</small></div>
                </div>
              );
            })}
          </div>
        ) : <div className="cd-svc-meta">Không có dịch vụ.</div>}
      </div>

      <div className="cd-card" style={{ marginBottom: 4 }}>
        <div className="cd-card-h"><span className="cd-card-t"><Clock size={16} />Thời gian</span></div>
        <div className="cd-time">
          <div className="cd-time-it"><span className="cd-time-n">{total}</span><span className="cd-time-l">Tổng thời hạn</span></div>
          <div className="cd-time-it"><span className="cd-time-n" style={{ color: 'var(--brand-600)' }}>{elapsed}</span><span className="cd-time-l">Đã thuê</span></div>
          <div className="cd-time-it"><span className="cd-time-n">{remaining}</span><span className="cd-time-l">Còn lại</span></div>
        </div>
        <div className="cd-time-unit">đơn vị: ngày</div>
      </div>
    </>
  );
}
