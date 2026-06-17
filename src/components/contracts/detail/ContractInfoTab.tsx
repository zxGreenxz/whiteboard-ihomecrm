import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { FileText, User, Settings, Zap, ExternalLink, Car } from 'lucide-react';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import { formatCurrency } from '@/lib/utils';
import type { ContractWithRelations } from '@/types/contract';
import type { ContractServiceItem, ContractVehicle } from './types';

const CYCLE: Record<string, string> = {
  MONTHLY: 'Hàng tháng', QUARTERLY: 'Hàng quý', SEMI_ANNUAL: '6 tháng', ANNUAL: 'Hàng năm',
};

function Row({ label, value, valueClass }: { label: string; value: React.ReactNode; valueClass?: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-sm font-medium ${valueClass ?? ''}`}>{value}</div>
    </div>
  );
}

/** Tab "Thông tin": Hợp đồng + Khách hàng + Dịch vụ áp dụng (KHÔNG có "Tóm tắt hoá đơn"). */
export function ContractInfoTab({
  contract, services, customers, vehiclesByCustomer,
}: {
  contract: ContractWithRelations;
  services: ContractServiceItem[];
  customers: NonNullable<ContractWithRelations['contract_customers']>;
  vehiclesByCustomer: Map<string, ContractVehicle[]>;
}) {
  const fmt = (d?: string | null) => (d ? format(new Date(d), 'dd/MM/yyyy', { locale: vi }) : 'N/A');
  const depLeft = contract.deposit_remaining || 0;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2"><FileText className="h-4 w-4" />Hợp đồng</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3">
          <Row label="Ngày ký" value={fmt(contract.signed_date)} />
          <Row label="Chu kỳ" value={CYCLE[contract.payment_cycle] ?? contract.payment_cycle} />
          <Row label="Bắt đầu" value={fmt(contract.start_date)} />
          <Row label="Kết thúc" value={fmt(contract.end_date)} />
          <Row label="Giá thuê" value={formatCurrency(contract.rent_price || 0)} valueClass="text-green-600" />
          <Row label="Tiền cọc" value={formatCurrency(contract.total_deposit || 0)} />
          <Row label="Đã thu cọc" value={formatCurrency(contract.deposit_paid || 0)} valueClass="text-green-600" />
          <Row label="Còn lại cọc" value={formatCurrency(depLeft)} valueClass={depLeft > 0 ? 'text-orange-600' : ''} />
          {contract.notes && (
            <div className="col-span-2">
              <div className="text-xs text-muted-foreground mb-1">Ghi chú</div>
              <div className="text-sm bg-muted/50 rounded p-2 whitespace-pre-wrap">{contract.notes}</div>
            </div>
          )}
          {contract.contract_file_url && (
            <a className="col-span-2 inline-flex items-center gap-1.5 text-sm text-blue-600" href={contract.contract_file_url} target="_blank" rel="noopener noreferrer">
              <FileText className="h-4 w-4" />Xem file hợp đồng<ExternalLink className="h-3 w-3" />
            </a>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2"><User className="h-4 w-4" />Khách hàng</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {customers.length ? customers.map((cc, i) => {
            const vs = vehiclesByCustomer.get(cc.customer_id) ?? [];
            return (
              <div key={cc.id} className={i > 0 ? 'pt-3 border-t' : ''}>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{cc.customer?.full_name || 'N/A'}</span>
                  {cc.is_representative && <Badge className="text-[10px] bg-green-500 hover:bg-green-600">Đại diện</Badge>}
                </div>
                <div className="text-[13px] text-muted-foreground">{cc.customer?.phone || 'N/A'}</div>
                {vs.map((v) => (
                  <div key={v.id} className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Car className="h-3 w-3 shrink-0" />
                    <span className="truncate">
                      {v.license_plate || 'Chưa có biển số'}{v.vehicle_name ? ` · ${v.vehicle_name}` : ''}
                      {v.parking_fee ? ` · ${formatCurrency(v.parking_fee)}/th` : ''}
                    </span>
                  </div>
                ))}
              </div>
            );
          }) : <div className="text-sm text-muted-foreground text-center py-2">Chưa có khách hàng.</div>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2"><Settings className="h-4 w-4" />Dịch vụ áp dụng</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5">
          {services.length ? services.map((s) => {
            const meter = s.service.type === 'METER_READING';
            return (
              <div key={s.id} className="flex items-center justify-between gap-3 text-sm">
                <div className="min-w-0 flex items-center gap-2">
                  {meter ? <Zap className="h-4 w-4 text-yellow-500 shrink-0" /> : <Settings className="h-4 w-4 text-muted-foreground shrink-0" />}
                  <div className="min-w-0">
                    <div className="font-medium truncate">{s.service.name}</div>
                    {meter && s.initial_reading != null && (
                      <div className="text-xs text-muted-foreground">Chỉ số đầu: {s.initial_reading} {s.service.unit}</div>
                    )}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="font-medium">{formatCurrency(s.unit_price)}</div>
                  <div className="text-xs text-muted-foreground">/{s.service.unit || '—'}</div>
                </div>
              </div>
            );
          }) : <div className="text-sm text-muted-foreground text-center py-2">Không có dịch vụ.</div>}
        </CardContent>
      </Card>
    </div>
  );
}
