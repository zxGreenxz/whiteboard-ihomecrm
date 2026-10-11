import { useCommissionAudit } from '@/hooks/useCommissionAudit';
import { COMMISSION_STAGE_LABELS, type CommissionIntervention } from '@/lib/commissionAudit';
import { formatVND } from '@/lib/utils';
import { formatLogMoment } from './voucherHistoryFormat';
import { Button } from '@/components/ui/button';

const labels: Record<string, string> = {
  total_amount: 'Số tiền hoa hồng', amount: 'Số tiền', gross: 'Hoa hồng trước khấu trừ', net: 'Thực chi', withheld: 'Khấu trừ hỗ trợ',
  rent_price: 'Giá thuê', start_date: 'Ngày bắt đầu', end_date: 'Ngày kết thúc', voucher_date: 'Ngày phiếu',
  rate_percent: 'Tỷ lệ cấu hình', default_amount: 'Tiền theo cấu hình', submitted_amount: 'Tiền đề nghị',
  approval_status: 'Trạng thái duyệt', status: 'Trạng thái', payer_name: 'Người nộp/nhận', recipient_name: 'Người nhận',
  posting_status: 'Trạng thái ghi sổ', contract_number: 'Hợp đồng',
  receive_bank_account: 'Tài khoản nhận', receive_bank_name: 'Ngân hàng nhận', notes: 'Ghi chú', name: 'Tên phiếu',
  account_name: 'Sổ quỹ', manager_name: 'Quản lý nhận hoa hồng', room_name: 'Phòng', building_name: 'Tòa nhà',
  commission_tiers: 'Cấu hình các mức hoa hồng', attachments: 'Chứng từ', items: 'Hạng mục', description: 'Diễn giải',
  business_result_accounting: 'Hạch toán kết quả kinh doanh', deleted_at: 'Thời điểm xóa',
  unit_price: 'Đơn giá', quantity: 'Số lượng', gross_amount: 'Hoa hồng trước khấu trừ', withheld_amount: 'Khấu trừ hỗ trợ', net_amount: 'Thực chi',
};
const money = new Set(['total_amount', 'amount', 'gross', 'net', 'withheld', 'rent_price', 'default_amount', 'submitted_amount', 'unit_price', 'gross_amount', 'withheld_amount', 'net_amount']);
const statuses: Record<string, string> = {UNAPPROVED:'Chờ duyệt', APPROVED:'Đã duyệt', CANCELLED:'Đã hủy', ACTIVE:'Đang hiệu lực',UNPOSTED:'Chưa ghi sổ',POSTED:'Đã ghi sổ',REVERSED:'Đã hoàn tác ghi sổ',NOT_APPLICABLE:'Không ghi sổ quỹ'};

function valueText(key: string, value: unknown): string {
  if (value === null || value === undefined) return 'Chưa có';
  if (money.has(key) && (typeof value === 'number' || typeof value === 'string') && Number.isFinite(Number(value))) return formatVND(Number(value));
  if (key === 'rate_percent' && typeof value === 'number') return `${value}%`;
  if (typeof value === 'boolean') return value ? 'Có' : 'Không';
  if (typeof value === 'string') return statuses[value] ?? value;
  if (Array.isArray(value)) {
    if (key === 'attachments') return `${value.length} chứng từ`;
    return value.map(item => {
      if (!item || typeof item !== 'object') return String(item);
      const row: Record<string, unknown> = item;
      if (key === 'commission_tiers') return `${row.min_months}–${row.max_months} tháng: ${row.rate_percent}%`;
      return [row.description, row.quantity !== undefined ? `Số lượng ${row.quantity}` : null,
        row.unit_price !== undefined ? `Đơn giá ${valueText('unit_price', row.unit_price)}` : null,
        row.amount !== undefined ? valueText('amount',row.amount) : null].filter(Boolean).join(' · ');
    }).join('\n') || 'Chưa có';
  }
  if (typeof value === 'number') return String(value);
  return 'Đã cập nhật';
}

function snapshotFields(snapshot: CommissionIntervention['before']): Record<string, unknown> {
  if (!snapshot) return {};
  const header = snapshot.header;
  return header && typeof header === 'object' && !Array.isArray(header) ? {...header, ...snapshot, header:undefined} : snapshot;
}

export function CommissionAuditEntry({event}: {event: CommissionIntervention}) {
  const before = snapshotFields(event.before), after = snapshotFields(event.after);
  const changed = Object.keys(labels).filter(key => (key in before || key in after) && JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  return <li className="space-y-2 rounded-md border p-3 text-sm">
    <p className="font-medium">{COMMISSION_STAGE_LABELS[event.stage] ?? 'Can thiệp hoa hồng'}</p>
    <p className="text-xs text-muted-foreground">{event.actor_name || (event.actor_id ? 'Người dùng chưa có tên hiển thị' : 'Hệ thống')} · {formatLogMoment(event.at)}</p>
    <p className="whitespace-pre-wrap break-words"><b>Lý do: </b>{event.reason || 'Thực hiện theo cấu hình/quy trình đã xác nhận.'}</p>
    {event.baseline && <div className="rounded bg-muted/50 p-2 text-xs space-y-1">
      <p className="font-medium">Căn cứ tại thời điểm xử lý</p>
      {['rent_price','months','rate_percent','default_amount','gross_amount','withheld_amount','submitted_amount'].filter(key => key in event.baseline!).map(key => <p key={key}>
        {key === 'months' ? 'Thời hạn hợp đồng' : labels[key]}: {valueText(key, event.baseline![key])}{key === 'months' ? ' tháng' : ''}
      </p>)}
    </div>}
    {changed.length > 0 && <dl className="space-y-2">{changed.map(key => <div key={key}>
      <dt className="font-medium">{labels[key]}</dt>
      <dd className="grid gap-1 sm:grid-cols-2 whitespace-pre-wrap break-words"><span>Trước: {valueText(key,before[key])}</span><span>Sau: {valueText(key,after[key])}</span></dd>
    </div>)}</dl>}
  </li>;
}

export function CommissionAuditHistory({voucherId, enabled = true, showLegacyNotice = false}: {voucherId: string; enabled?: boolean; showLegacyNotice?: boolean}) {
  const query = useCommissionAudit(voucherId, enabled);
  if (!enabled) return null;
  if (query.isLoading) return <p className="text-xs text-muted-foreground">Đang tải lịch sử hoa hồng…</p>;
  if (query.isError) return <div role="alert" className="text-sm text-destructive">Chưa đọc được lịch sử hoa hồng. <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>Tải lại</Button></div>;
  const legacyNotice = showLegacyNotice && !query.data?.some(event => event.stage.startsWith('CREATE'))
    ? <p className="text-xs text-amber-700">Chưa có lịch sử lý do tại thời điểm lập phiếu này. Các lần can thiệp được lưu sau đó không xác nhận lý do của số tiền ban đầu.</p> : null;
  if (!query.data?.length) return legacyNotice;
  return <section className="space-y-2" aria-label="Lịch sử can thiệp hoa hồng"><h3 className="font-semibold text-sm">Lịch sử can thiệp hoa hồng</h3>{legacyNotice}<ol className="space-y-2">{query.data.map(event => <CommissionAuditEntry key={event.id} event={event} />)}</ol></section>;
}
