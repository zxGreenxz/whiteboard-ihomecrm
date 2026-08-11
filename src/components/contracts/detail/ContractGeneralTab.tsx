import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  FileText,
  User,
  Home,
  Building2,
  Phone,
  Mail,
  CreditCard,
  Zap,
  Droplets,
  ExternalLink,
} from 'lucide-react';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import type { ContractWithRelations } from '@/hooks/useContracts';
import type { InvoiceWithRelations } from '@/hooks/useInvoices';
import type { ContractTerminationInfo } from '@/hooks/contracts/useContractDetailData';
import { RenewedBadge } from '@/components/contracts/RenewedBadge';
import type {
  ContractVehicle,
  ContractDepositVoucher,
} from '@/components/contracts/detail/types';
import { ContractSummary } from './ContractSummary';
import { formatCurrency } from './formatCurrency';

const getStatusBadge = (status: string) => {
  const variants: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; label: string; className?: string }> = {
    DRAFT: { variant: 'outline', label: 'Nháp' },
    ACTIVE: { variant: 'default', label: 'Đang hoạt động', className: 'bg-green-500 hover:bg-green-600' },
    TRANSFERRED: { variant: 'secondary', label: 'Đã chuyển nhượng', className: 'bg-purple-500 hover:bg-purple-600 text-white' },
    TERMINATED: { variant: 'destructive', label: 'Đã thanh lý' },
    EXPIRED: { variant: 'outline', label: 'Hết hạn' },
  };

  const config = variants[status] || { variant: 'outline' as const, label: status };
  return (
    <Badge variant={config.variant} className={config.className}>
      {config.label}
    </Badge>
  );
};

// `contract.payment_cycle` là nullable trong DB (HĐ nháp có thể chưa chọn chu kỳ),
// nên tham số phải nhận cả null thay vì ép người gọi bẻ dữ liệu.
const getPaymentCycleLabel = (cycle: string | null) => {
  if (!cycle) return 'N/A';
  const labels: Record<string, string> = {
    MONTHLY: 'Hàng tháng',
    QUARTERLY: 'Hàng quý',
    SEMI_ANNUAL: '6 tháng',
    ANNUAL: 'Hàng năm',
  };
  return labels[cycle] || cycle;
};

const getLocationDisplay = (contract: ContractWithRelations) => {
  const room = contract.room;
  if (!room) return 'N/A';
  // Quan hệ `building` được khai `| null` — join có thể không trả về (toà đã xoá,
  // hoặc query nạp room mà không nạp building). Thiếu toà thì vẫn hiện tên phòng.
  return room.building ? `${room.name} - ${room.building.name}` : room.name;
};

interface ContractGeneralTabProps {
  contract: ContractWithRelations;
  /** Khách trong HĐ, đã sort đại diện lên đầu (giữ nguyên thứ tự từ root). */
  contractCustomers: NonNullable<ContractWithRelations['contract_customers']>;
  vehiclesByCustomer: Map<string, ContractVehicle[]>;
  isExpiringSoon: boolean;
  isExpired: boolean;
  daysRemaining: number;
  progressPercent: number;
  // Props chuyển tiếp cho cột phải (ContractSummary)
  terminationInfo: ContractTerminationInfo | null | undefined;
  pendingForfeitCount: number;
  pendingRefundCount: number;
  depositVouchers: ContractDepositVoucher[];
  invoices: InvoiceWithRelations[] | undefined;
  totalInvoiced: number;
  totalPaid: number;
  outstandingAmount: number;
  totalDays: number;
  daysElapsed: number;
}

/** Tab "Thông tin chung" (desktop) — cột trái (HĐ / khách hàng / căn hộ) +
 *  cột phải (ContractSummary). Tách nguyên văn từ ContractDetailView (Phase 10D). */
export function ContractGeneralTab({
  contract,
  contractCustomers,
  vehiclesByCustomer,
  isExpiringSoon,
  isExpired,
  daysRemaining,
  progressPercent,
  terminationInfo,
  pendingForfeitCount,
  pendingRefundCount,
  depositVouchers,
  invoices,
  totalInvoiced,
  totalPaid,
  outstandingAmount,
  totalDays,
  daysElapsed,
}: ContractGeneralTabProps) {
  const navigate = useNavigate();

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Left Column - Main Info */}
      <div className="lg:col-span-2 space-y-6">
        {/* Contract Details Card */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <FileText className="h-5 w-5" />
                Thông tin hợp đồng
              </CardTitle>
              <div className="flex items-center gap-2">
                {getStatusBadge(contract.status)}
                <RenewedBadge contractId={contract.id} />
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <div className="text-gray-600">Số hợp đồng</div>
                <div className="font-medium">{contract.contract_number || 'N/A'}</div>
              </div>
              <div>
                <div className="text-gray-600">Ngày ký</div>
                <div className="font-medium">
                  {contract.signed_date
                    ? format(new Date(contract.signed_date), 'dd/MM/yyyy', { locale: vi })
                    : 'N/A'
                  }
                </div>
              </div>
              <div>
                <div className="text-gray-600">Ngày bắt đầu</div>
                <div className="font-medium">
                  {format(new Date(contract.start_date), 'dd/MM/yyyy', { locale: vi })}
                </div>
              </div>
              <div>
                <div className="text-gray-600">Ngày kết thúc</div>
                <div className={`font-medium ${isExpiringSoon ? 'text-orange-600' : ''} ${isExpired ? 'text-red-600' : ''}`}>
                  {format(new Date(contract.end_date), 'dd/MM/yyyy', { locale: vi })}
                  {isExpiringSoon && <span className="ml-2 text-xs">({daysRemaining} ngày)</span>}
                  {isExpired && <span className="ml-2 text-xs">(Đã hết hạn)</span>}
                </div>
              </div>
              <div>
                <div className="text-gray-600">Giá thuê</div>
                <div className="font-medium text-green-600">
                  {formatCurrency(contract.rent_price || 0)}
                </div>
              </div>
              <div>
                <div className="text-gray-600">Chu kỳ thanh toán</div>
                <div className="font-medium">
                  {getPaymentCycleLabel(contract.payment_cycle)}
                </div>
              </div>
            </div>

            {/* Progress bar */}
            <div className="pt-4 border-t">
              <div className="flex justify-between text-sm text-gray-600 mb-2">
                <span>Tiến độ hợp đồng</span>
                <span>{Math.round(progressPercent)}%</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div
                  className={`h-2 rounded-full ${isExpired ? 'bg-red-500' : isExpiringSoon ? 'bg-orange-500' : 'bg-green-500'}`}
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>

            {contract.notes && (
              <div className="pt-4 border-t">
                <div className="text-gray-600 text-sm mb-1">Ghi chú</div>
                <div className="text-sm bg-gray-50 p-3 rounded">{contract.notes}</div>
              </div>
            )}

            {contract.contract_file_url && (
              <div className="pt-4 border-t">
                <a
                  href={contract.contract_file_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-blue-600 hover:text-blue-800 hover:underline text-sm"
                >
                  <FileText className="h-4 w-4" />
                  Xem file hợp đồng
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Tenant Info Card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <User className="h-5 w-5" />
              Thông tin khách hàng
              {contractCustomers.length > 1 && (
                <Badge variant="secondary" className="ml-2">
                  {contractCustomers.length} người
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {contractCustomers.length > 0 ? (
              <div className="space-y-4">
                {contractCustomers.map((cc, index) => {
                  const vehicles = vehiclesByCustomer.get(cc.customer_id) ?? [];
                  return (
                  <div key={cc.id} className={index > 0 ? 'pt-4 border-t' : ''}>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="font-medium text-sm">
                        {cc.customer?.full_name || 'N/A'}
                      </span>
                      {cc.is_representative && (
                        <Badge variant="default" className="text-xs bg-green-500 hover:bg-green-600">
                          Đại diện
                        </Badge>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <div className="text-gray-600 flex items-center gap-1">
                          <Phone className="h-3 w-3" />
                          Số điện thoại
                        </div>
                        <div className="font-medium">{cc.customer?.phone || 'N/A'}</div>
                      </div>
                      <div>
                        <div className="text-gray-600 flex items-center gap-1">
                          <Mail className="h-3 w-3" />
                          Email
                        </div>
                        <div className="font-medium">{cc.customer?.email || 'N/A'}</div>
                      </div>
                      <div>
                        <div className="text-gray-600 flex items-center gap-1">
                          <CreditCard className="h-3 w-3" />
                          CCCD/CMND
                        </div>
                        <div className="font-medium">
                          {cc.customer?.id_number || 'N/A'}
                        </div>
                      </div>
                    </div>
                    {vehicles.length > 0 && (
                      <div className="mt-3">
                        <div className="text-gray-600 text-xs mb-1">
                          Phương tiện ({vehicles.length})
                        </div>
                        <div className="space-y-1">
                          {vehicles.map((v) => (
                            <div
                              key={v.id}
                              className="text-sm bg-gray-50 rounded px-2 py-1.5 flex items-center justify-between gap-2"
                            >
                              <span>
                                <span className="font-medium">
                                  {v.license_plate || 'Chưa có biển số'}
                                </span>
                                {v.vehicle_name && (
                                  <span className="text-gray-600 ml-2">
                                    · {v.vehicle_name}
                                  </span>
                                )}
                                {v.color && (
                                  <span className="text-gray-500 ml-2">· {v.color}</span>
                                )}
                              </span>
                              {v.parking_fee != null && v.parking_fee > 0 && (
                                <span className="text-xs text-gray-600">
                                  {formatCurrency(v.parking_fee)}/tháng
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {cc.notes && (
                      <div className="mt-3">
                        <div className="text-gray-600 text-xs mb-1">
                          {cc.is_representative ? 'Ghi chú đại diện' : 'Ghi chú'}
                        </div>
                        <div className="text-sm bg-amber-50 border border-amber-200 rounded p-2 whitespace-pre-wrap">
                          {cc.notes}
                        </div>
                      </div>
                    )}
                    <div className="mt-3">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => navigate(`/customers/${cc.customer_id}`)}
                      >
                        Xem chi tiết
                      </Button>
                    </div>
                  </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-sm text-gray-500 py-4 text-center">
                Hợp đồng chưa có khách hàng nào.
              </div>
            )}
          </CardContent>
        </Card>

        {/* Location Info Card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Home className="h-5 w-5" />
              Thông tin căn hộ
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <div className="text-gray-600">Vị trí</div>
                <div className="font-medium">{getLocationDisplay(contract)}</div>
              </div>
              <div>
                <div className="text-gray-600 flex items-center gap-1">
                  <Building2 className="h-3 w-3" />
                  Tòa nhà
                </div>
                <div className="font-medium">
                  {contract.room?.building?.name || 'N/A'}
                </div>
              </div>
              {contract.initial_electricity_reading !== null && (
                <div>
                  <div className="text-gray-600 flex items-center gap-1">
                    <Zap className="h-3 w-3 text-yellow-500" />
                    Chỉ số điện ban đầu
                  </div>
                  <div className="font-medium">{contract.initial_electricity_reading} kWh</div>
                </div>
              )}
              {contract.initial_water_reading !== null && (
                <div>
                  <div className="text-gray-600 flex items-center gap-1">
                    <Droplets className="h-3 w-3 text-blue-500" />
                    Chỉ số nước ban đầu
                  </div>
                  <div className="font-medium">{contract.initial_water_reading} m³</div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Right Column - Summary */}
      <ContractSummary
        contract={contract}
        terminationInfo={terminationInfo}
        pendingForfeitCount={pendingForfeitCount}
        pendingRefundCount={pendingRefundCount}
        depositVouchers={depositVouchers}
        invoices={invoices}
        totalInvoiced={totalInvoiced}
        totalPaid={totalPaid}
        outstandingAmount={outstandingAmount}
        totalDays={totalDays}
        daysElapsed={daysElapsed}
        daysRemaining={daysRemaining}
      />
    </div>
  );
}
