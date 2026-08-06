import { useState, lazy, Suspense } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { usePhoneViewport } from '@/hooks/use-mobile';
import {
  ArrowLeft,
  Copy,
  Pencil,
  Trash2,
  FileText,
  User,
  Phone,
  Mail,
  CreditCard,
  MapPin,
  Car,
  ExternalLink,
} from 'lucide-react';
import MainLayout from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { StorageImage } from '@/components/ui/storage-image';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from 'sonner';
import { useCustomer } from '@/hooks/useCustomers';
import { useVehicles } from '@/hooks/useVehicles';
import type { VehicleWithRelations } from '@/types/vehicle';
import { supabase } from '@/integrations/supabase/client';
import DeleteCustomerDialog from '@/components/customers/DeleteCustomerDialog';

const CustomerDetailMobilePage = lazy(() => import('./CustomerDetailMobilePage'));

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

function formatCurrency(amount: number | null | undefined): string {
  if (amount == null) return '—';
  return new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND',
  }).format(amount);
}

const CONTRACT_STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  ACTIVE: { label: 'Đang hoạt động', cls: 'bg-green-500 hover:bg-green-600 text-white' },
  TRANSFERRED: { label: 'Đã chuyển nhượng', cls: 'bg-purple-500 hover:bg-purple-600 text-white' },
  TERMINATED: { label: 'Đã thanh lý', cls: 'bg-red-500 hover:bg-red-600 text-white' },
  EXPIRED: { label: 'Hết hạn', cls: 'bg-gray-400 hover:bg-gray-500 text-white' },
  DRAFT: { label: 'Nháp', cls: 'bg-gray-200 text-gray-800' },
};

export default function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const isPhone = usePhoneViewport();
  if (isPhone && id) {
    return (
      <Suspense fallback={null}>
        <CustomerDetailMobilePage id={id} />
      </Suspense>
    );
  }
  return <CustomerDetailDesktopPage />;
}

function CustomerDetailDesktopPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [deleteOpen, setDeleteOpen] = useState(false);

  const { data: customer, isLoading } = useCustomer(id || '');
  const { data: vehiclesData } = useVehicles(
    { customer_id: id },
    { page: 1, pageSize: 50 }
  );
  const vehicles = vehiclesData?.data ?? [];

  // Hợp đồng có khách này (qua bảng contract_customers).
  const { data: contractLinks = [] } = useQuery({
    queryKey: ['customer-contracts', id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('contract_customers')
        .select(
          `id, is_representative, notes,
           contract:contracts!contract_customers_contract_id_fkey (
             id, contract_number, status, start_date, end_date, rent_price, deleted_at,
             room:rooms!contracts_room_id_fkey (id, name, building:buildings!rooms_building_id_fkey(id, name))
           )`
        )
        .eq('customer_id', id!)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []).filter((cc: any) => cc.contract && !cc.contract.deleted_at);
    },
  });

  if (!id) {
    return (
      <MainLayout title="Lỗi" subtitle="Không tìm thấy khách hàng" icon={User}>
        <div className="text-center py-12">
          <p className="text-gray-500">ID khách hàng không hợp lệ</p>
          <Button onClick={() => navigate('/customers')} className="mt-4">
            Quay lại danh sách
          </Button>
        </div>
      </MainLayout>
    );
  }

  if (isLoading) {
    return (
      <MainLayout title="Đang tải..." subtitle="Vui lòng đợi" icon={User}>
        <div className="text-center py-12 text-gray-500">
          Đang tải thông tin khách hàng...
        </div>
      </MainLayout>
    );
  }

  if (!customer) {
    return (
      <MainLayout title="Không tìm thấy" subtitle="Khách hàng không tồn tại" icon={User}>
        <div className="text-center py-12">
          <p className="text-gray-500">Không tìm thấy khách hàng với ID này</p>
          <Button onClick={() => navigate('/customers')} className="mt-4">
            Quay lại danh sách
          </Button>
        </div>
      </MainLayout>
    );
  }

  const handleCopy = () => {
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

  const handleDeleteSuccess = () => {
    setDeleteOpen(false);
    navigate('/customers');
  };

  return (
    <MainLayout
      title={customer.full_name}
      subtitle="Chi tiết khách hàng"
      icon={User}
    >
      {/* Header actions */}
      <div className="flex flex-wrap items-center gap-2 mb-6">
        <Button variant="outline" onClick={() => navigate('/customers')}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          Quay lại
        </Button>
        <div className="flex-1" />
        <Button variant="outline" onClick={handleCopy}>
          <Copy className="h-4 w-4 mr-2" />
          Sao chép
        </Button>
        <Button variant="outline" onClick={() => navigate(`/customers/${id}/edit`)}>
          <Pencil className="h-4 w-4 mr-2" />
          Sửa
        </Button>
        <Button variant="outline" onClick={() => navigate(`/customers/${id}/ct01`)}>
          <FileText className="h-4 w-4 mr-2" />
          Mẫu CT01
        </Button>
        <Button
          variant="destructive"
          onClick={() => setDeleteOpen(true)}
        >
          <Trash2 className="h-4 w-4 mr-2" />
          Xoá
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Cột trái */}
        <div className="lg:col-span-2 space-y-6">
          {/* Thông tin cá nhân */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <User className="h-4 w-4" />
                Thông tin cá nhân
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                <Field icon={User} label="Họ tên" value={customer.full_name} />
                <PhoneField label="SĐT" value={customer.phone} />
                <Field icon={Mail} label="Email" value={customer.email} />
                <Field
                  icon={CreditCard}
                  label="CMND/CCCD"
                  value={customer.id_number}
                />
                <Field label="Ngày sinh" value={formatDate(customer.date_of_birth)} />
                <Field label="Giới tính" value={customer.gender} />
                {customer.id_issue_date && (
                  <Field label="Ngày cấp" value={formatDate(customer.id_issue_date)} />
                )}
                {customer.id_issue_place && (
                  <Field label="Nơi cấp" value={customer.id_issue_place} />
                )}
                {customer.occupation && (
                  <Field label="Nghề nghiệp" value={customer.occupation} />
                )}
                {customer.workplace && (
                  <Field label="Nơi làm việc" value={customer.workplace} />
                )}
              </div>
            </CardContent>
          </Card>

          {/* Ảnh CCCD */}
          {customer.id_images &&
            (customer.id_images.front || customer.id_images.back) && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Ảnh CCCD/CMND</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex gap-3 flex-wrap">
                    {customer.id_images.front && (
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">Mặt trước</p>
                        <StorageImage
                          value={customer.id_images.front}
                          alt="CCCD mặt trước"
                          className="h-32 w-auto rounded border object-cover"
                        />
                      </div>
                    )}
                    {customer.id_images.back && (
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">Mặt sau</p>
                        <StorageImage
                          value={customer.id_images.back}
                          alt="CCCD mặt sau"
                          className="h-32 w-auto rounded border object-cover"
                        />
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

          {/* Địa chỉ */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <MapPin className="h-4 w-4" />
                Địa chỉ
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 gap-y-2 text-sm">
                <Field
                  label="Địa chỉ chi tiết"
                  value={customer.detailed_address}
                />
                <Field label="Chỗ ở hiện tại" value={customer.current_residence} />
                <Field label="Thường trú" value={customer.permanent_address} />
                {customer.province && (
                  <Field
                    label="Tỉnh/Quận/Phường"
                    value={[customer.ward, customer.district, customer.province]
                      .filter(Boolean)
                      .join(', ')}
                  />
                )}
              </div>
            </CardContent>
          </Card>

          {/* Phương tiện */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Car className="h-4 w-4" />
                Phương tiện ({vehicles.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              {vehicles.length === 0 ? (
                <p className="text-sm text-gray-500 py-4 text-center">
                  Chưa có phương tiện
                </p>
              ) : (
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Loại</TableHead>
                        <TableHead>Tên xe</TableHead>
                        <TableHead>Biển số</TableHead>
                        <TableHead>Màu</TableHead>
                        <TableHead className="text-right">Phí gửi xe</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {vehicles.map((v: VehicleWithRelations) => (
                        <TableRow key={v.id}>
                          <TableCell>
                            {VEHICLE_TYPE_LABELS[v.vehicle_type] || v.vehicle_type || '—'}
                          </TableCell>
                          <TableCell>{v.vehicle_name || '—'}</TableCell>
                          <TableCell className="font-medium">
                            {v.license_plate || '—'}
                          </TableCell>
                          <TableCell>{v.color || '—'}</TableCell>
                          <TableCell className="text-right">
                            {v.parking_fee != null && v.parking_fee > 0
                              ? formatCurrency(v.parking_fee)
                              : '—'}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Cột phải */}
        <div className="space-y-6">
          {/* Hợp đồng */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <FileText className="h-4 w-4" />
                Hợp đồng ({contractLinks.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              {contractLinks.length === 0 ? (
                <p className="text-sm text-gray-500 py-4 text-center">
                  Chưa có hợp đồng
                </p>
              ) : (
                <div className="space-y-3">
                  {contractLinks.map((link: any) => {
                    const c = link.contract;
                    const status = CONTRACT_STATUS_LABEL[c.status] ?? {
                      label: c.status,
                      cls: 'bg-gray-100 text-gray-800',
                    };
                    return (
                      <button
                        key={link.id}
                        type="button"
                        className="w-full text-left p-3 border rounded-md hover:bg-gray-50 transition-colors"
                        onClick={() => navigate(`/contracts/${c.id}`)}
                      >
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <span className="font-medium text-sm">
                            {c.contract_number || c.id.slice(0, 8)}
                          </span>
                          <Badge className={`text-xs ${status.cls}`}>{status.label}</Badge>
                        </div>
                        <div className="text-xs text-gray-600">
                          {c.room?.building?.name}
                          {c.room?.name && ` / ${c.room.name}`}
                        </div>
                        <div className="text-xs text-gray-500 mt-1">
                          {formatDate(c.start_date)} → {formatDate(c.end_date)}
                        </div>
                        <div className="flex items-center justify-between mt-1">
                          <span className="text-xs text-gray-500">
                            {formatCurrency(c.rent_price)} / tháng
                          </span>
                          {link.is_representative && (
                            <Badge
                              variant="default"
                              className="text-[10px] bg-green-500 hover:bg-green-600"
                            >
                              Đại diện
                            </Badge>
                          )}
                        </div>
                        <ExternalLink className="h-3 w-3 inline-block ml-1 text-gray-400" />
                      </button>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Liên hệ khẩn cấp */}
          {(customer.emergency_contact_name ||
            customer.emergency_contact_phone) && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Liên hệ khẩn cấp</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2 text-sm">
                  <Field label="Họ tên" value={customer.emergency_contact_name} />
                  <Field label="SĐT" value={customer.emergency_contact_phone} />
                  <Field
                    label="Quan hệ"
                    value={customer.emergency_contact_relationship}
                  />
                </div>
              </CardContent>
            </Card>
          )}

          {/* Ghi chú */}
          {customer.notes && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Ghi chú</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm whitespace-pre-wrap bg-gray-50 p-3 rounded">
                  {customer.notes}
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Delete dialog */}
      <DeleteCustomerDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        customerId={customer.id}
        customerName={customer.full_name}
        onSuccess={handleDeleteSuccess}
      />
    </MainLayout>
  );
}

interface FieldProps {
  icon?: React.ElementType;
  label: string;
  value: string | null | undefined;
}

function Field({ icon: Icon, label, value }: FieldProps) {
  return (
    <div>
      <div className="text-gray-600 flex items-center gap-1 text-xs">
        {Icon && <Icon className="h-3 w-3" />}
        {label}
      </div>
      <div className="font-medium">{value || '—'}</div>
    </div>
  );
}

function PhoneField({ label, value }: { label: string; value: string | null | undefined }) {
  const tel = value ? value.replace(/[^\d+]/g, '') : '';
  return (
    <div>
      <div className="text-gray-600 flex items-center gap-1 text-xs">
        <Phone className="h-3 w-3" />
        {label}
      </div>
      <div className="font-medium flex items-center gap-1.5">
        <span>{value || '—'}</span>
        {value && (
          <a
            href={`tel:${tel}`}
            className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-green-50 text-green-600 hover:bg-green-100"
            aria-label="Gọi khách hàng"
          >
            <Phone className="h-3.5 w-3.5" />
          </a>
        )}
      </div>
    </div>
  );
}
