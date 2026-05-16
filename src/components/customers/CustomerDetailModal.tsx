import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Copy, Pencil, Trash2, FileText, Phone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import { useCustomer } from '@/hooks/useCustomers';
import { useVehicles } from '@/hooks/useVehicles';
import type { VehicleWithRelations } from '@/types/vehicle';
import DeleteCustomerDialog from './DeleteCustomerDialog';

interface CustomerDetailModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: string;
}

const VEHICLE_TYPE_LABELS: Record<string, string> = {
  MOTORBIKE: 'Xe máy',
  CAR: 'Ô tô',
  BICYCLE: 'Xe đạp',
  ELECTRIC_BIKE: 'Xe điện',
  OTHER: 'Khác',
};

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch {
    return '—';
  }
}

/**
 * CustomerDetailModal
 * Dialog showing personal info, CCCD images, address, vehicle info
 * Actions: Copy, Edit, Delete, Link CT01
 * Requirements: 4.1-4.9
 */
export default function CustomerDetailModal({
  open,
  onOpenChange,
  customerId,
}: CustomerDetailModalProps) {
  const navigate = useNavigate();
  const [deleteOpen, setDeleteOpen] = useState(false);

  const { data: customer, isLoading } = useCustomer(customerId);
  const { data: vehiclesData } = useVehicles(
    { customer_id: customerId },
    { page: 1, pageSize: 50 }
  );

  const vehicles = vehiclesData?.data ?? [];

  const handleCopy = () => {
    if (!customer) return;
    const info = [
      `Họ tên: ${customer.full_name}`,
      `SĐT: ${customer.phone}`,
      customer.email ? `Email: ${customer.email}` : null,
      customer.id_number ? `CMND/CCCD: ${customer.id_number}` : null,
      customer.date_of_birth ? `Ngày sinh: ${formatDate(customer.date_of_birth)}` : null,
      customer.gender ? `Giới tính: ${customer.gender}` : null,
      customer.detailed_address ? `Địa chỉ: ${customer.detailed_address}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    navigator.clipboard.writeText(info);
    toast.success('Đã sao chép thông tin');
  };

  const handleEdit = () => {
    onOpenChange(false);
    navigate(`/customers/${customerId}/edit`);
  };

  const handleCT01 = () => {
    onOpenChange(false);
    navigate(`/customers/${customerId}/ct01`);
  };

  const handleDeleteSuccess = () => {
    setDeleteOpen(false);
    onOpenChange(false);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Chi tiết khách hàng</DialogTitle>
          </DialogHeader>

          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground">Đang tải...</div>
          ) : !customer ? (
            <div className="p-8 text-center text-muted-foreground">Không tìm thấy khách hàng</div>
          ) : (
            <div className="space-y-4">
              {/* Actions */}
              <div className="flex gap-2 flex-wrap">
                <Button variant="outline" size="sm" onClick={handleCopy} className="gap-1">
                  <Copy className="h-3.5 w-3.5" /> Sao chép
                </Button>
                <Button variant="outline" size="sm" onClick={handleEdit} className="gap-1">
                  <Pencil className="h-3.5 w-3.5" /> Sửa
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setDeleteOpen(true)}
                  className="gap-1 text-red-600 hover:text-red-700 hover:bg-red-50"
                >
                  <Trash2 className="h-3.5 w-3.5" /> Xoá
                </Button>
              </div>

              {/* Personal Info Table */}
              <div className="space-y-2">
                <h4 className="text-sm font-semibold text-gray-700">Thông tin cá nhân</h4>
                <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                  <div>
                    <span className="text-muted-foreground">Họ tên:</span>{' '}
                    <span className="font-medium">{customer.full_name}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted-foreground">SĐT:</span>{' '}
                    <span className="font-medium">{customer.phone}</span>
                    {customer.phone && (
                      <a
                        href={`tel:${customer.phone.replace(/[^\d+]/g, '')}`}
                        className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-green-50 text-green-600 hover:bg-green-100"
                        aria-label="Gọi khách hàng"
                      >
                        <Phone className="h-3.5 w-3.5" />
                      </a>
                    )}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Email:</span>{' '}
                    <span>{customer.email || '—'}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Ngày sinh:</span>{' '}
                    <span>{formatDate(customer.date_of_birth)}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Giới tính:</span>{' '}
                    <span>{customer.gender || '—'}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">CMND/CCCD:</span>{' '}
                    <span>{customer.id_number || '—'}</span>
                  </div>
                  {customer.id_issue_date && (
                    <div>
                      <span className="text-muted-foreground">Ngày cấp:</span>{' '}
                      <span>{formatDate(customer.id_issue_date)}</span>
                    </div>
                  )}
                  {customer.id_issue_place && (
                    <div>
                      <span className="text-muted-foreground">Nơi cấp:</span>{' '}
                      <span>{customer.id_issue_place}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* CCCD Images */}
              {customer.id_images && Object.keys(customer.id_images).length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-sm font-semibold text-gray-700">Ảnh CCCD</h4>
                  <div className="flex gap-3">
                    {customer.id_images.front && (
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">Mặt trước</p>
                        <img
                          src={customer.id_images.front}
                          alt="CCCD mặt trước"
                          className="h-24 w-auto rounded border object-cover"
                        />
                      </div>
                    )}
                    {customer.id_images.back && (
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">Mặt sau</p>
                        <img
                          src={customer.id_images.back}
                          alt="CCCD mặt sau"
                          className="h-24 w-auto rounded border object-cover"
                        />
                      </div>
                    )}
                  </div>
                </div>
              )}

              <Separator />

              {/* Address */}
              <div className="space-y-2">
                <h4 className="text-sm font-semibold text-gray-700">Địa chỉ</h4>
                <div className="grid grid-cols-1 gap-y-1 text-sm">
                  {customer.detailed_address && (
                    <div>
                      <span className="text-muted-foreground">Địa chỉ chi tiết:</span>{' '}
                      <span>{customer.detailed_address}</span>
                    </div>
                  )}
                  {customer.current_residence && (
                    <div>
                      <span className="text-muted-foreground">Chỗ ở hiện tại:</span>{' '}
                      <span>{customer.current_residence}</span>
                    </div>
                  )}
                  {customer.permanent_address && (
                    <div>
                      <span className="text-muted-foreground">Thường trú:</span>{' '}
                      <span>{customer.permanent_address}</span>
                    </div>
                  )}
                </div>
              </div>

              <Separator />

              {/* Vehicle Info Table */}
              <div className="space-y-2">
                <h4 className="text-sm font-semibold text-gray-700">Thông tin phương tiện</h4>
                {vehicles.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Chưa có phương tiện</p>
                ) : (
                  <div className="rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Loại phương tiện</TableHead>
                          <TableHead>Tên dòng xe</TableHead>
                          <TableHead>Biển số xe</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {vehicles.map((v: VehicleWithRelations) => (
                          <TableRow key={v.id}>
                            <TableCell>{VEHICLE_TYPE_LABELS[v.vehicle_type] || v.vehicle_type}</TableCell>
                            <TableCell>{v.vehicle_name || '—'}</TableCell>
                            <TableCell>{v.license_plate || '—'}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>

              <Separator />

              {/* CT01 Link */}
              <button
                type="button"
                onClick={handleCT01}
                className="text-sm text-green-600 hover:text-green-700 hover:underline flex items-center gap-1"
              >
                <FileText className="h-4 w-4" />
                Bản khai nhân khẩu / Mẫu CT01 - Tờ khai thay đổi thông tin cư trú
              </button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      {customer && (
        <DeleteCustomerDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          customerId={customer.id}
          customerName={customer.full_name}
          onSuccess={handleDeleteSuccess}
        />
      )}
    </>
  );
}
