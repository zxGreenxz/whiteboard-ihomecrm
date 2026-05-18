import { Eye, Pencil, Trash2, Phone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { Customer } from '@/types/customer';
import { useMyBuildingScope } from '@/hooks/useMyBuildingScope';

interface CustomerListTableProps {
  customers: Customer[];
  onView: (customer: Customer) => void;
  onEdit: (customer: Customer) => void;
  onDelete: (customer: Customer) => void;
  isLoading?: boolean;
}

function AvatarInitial({ name }: { name: string }) {
  const initial = name.charAt(0).toUpperCase();
  // Deterministic color based on first char code
  const colors = [
    'bg-blue-500',
    'bg-green-500',
    'bg-orange-500',
    'bg-purple-500',
    'bg-pink-500',
    'bg-teal-500',
    'bg-indigo-500',
    'bg-red-500',
  ];
  const colorIndex = initial.charCodeAt(0) % colors.length;

  return (
    <div
      className={`flex h-8 w-8 items-center justify-center rounded-full text-white text-sm font-medium ${colors[colorIndex]}`}
    >
      {initial}
    </div>
  );
}

function normalizePhoneForTel(phone: string): string {
  return phone.replace(/[^\d+]/g, '');
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '';
  try {
    return new Date(dateStr).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch {
    return '';
  }
}

export default function CustomerListTable({
  customers,
  onView,
  onEdit,
  onDelete,
  isLoading,
}: CustomerListTableProps) {
  const { canManageBuilding, canManageAll } = useMyBuildingScope();
  // Customer "thuộc scope" khi: caller quản tất cả, customer chưa có hợp đồng
  // (current_building_id null = chưa thuê), hoặc tòa hiện tại thuộc scope.
  const canManageCustomer = (customer: Customer) => {
    if (canManageAll) return true;
    const bid = (customer as any).current_building_id as string | null | undefined;
    if (!bid) return true;
    return canManageBuilding(bid);
  };

  if (isLoading) {
    return (
      <div className="p-8 text-center text-muted-foreground">Đang tải dữ liệu...</div>
    );
  }

  if (customers.length === 0) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        Không có khách hàng nào
      </div>
    );
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              <Checkbox disabled />
            </TableHead>
            <TableHead>Khách hàng</TableHead>
            <TableHead>Căn hộ đang ở</TableHead>
            <TableHead>CMND/CCCD/Hộ chiếu</TableHead>
            <TableHead>Ngày sinh</TableHead>
            <TableHead>Địa chỉ</TableHead>
            <TableHead className="w-28">Thao tác</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {customers.map((customer) => (
            <TableRow key={customer.id}>
              <TableCell>
                <Checkbox />
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onView(customer)}
                    className="shrink-0 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    aria-label={`Xem chi tiết ${customer.full_name}`}
                  >
                    {customer.avatar_url ? (
                      <img
                        src={customer.avatar_url}
                        alt={customer.full_name}
                        className="h-8 w-8 rounded-full object-cover"
                      />
                    ) : (
                      <AvatarInitial name={customer.full_name} />
                    )}
                  </button>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{customer.full_name}</p>
                    <div className="flex items-center gap-1.5">
                      <p className="text-xs text-muted-foreground">{customer.phone}</p>
                      {customer.phone && (
                        <a
                          href={`tel:${normalizePhoneForTel(customer.phone)}`}
                          onClick={(e) => e.stopPropagation()}
                          className="md:hidden inline-flex h-6 w-6 items-center justify-center rounded-full bg-green-50 text-green-600 active:bg-green-100"
                          aria-label={`Gọi ${customer.full_name}`}
                        >
                          <Phone className="h-3.5 w-3.5" />
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              </TableCell>
              <TableCell className="text-sm">
                {(customer as any).current_building_name ? (
                  <div className="flex flex-col leading-tight">
                    <span>{(customer as any).current_building_name}</span>
                    {(customer as any).current_room_name && (
                      <span className="text-xs text-muted-foreground">
                        Phòng {(customer as any).current_room_name}
                      </span>
                    )}
                  </div>
                ) : (
                  '—'
                )}
              </TableCell>
              <TableCell className="text-sm">{customer.id_number || '—'}</TableCell>
              <TableCell className="text-sm">{formatDate(customer.date_of_birth) || '—'}</TableCell>
              <TableCell className="text-sm max-w-[200px] truncate">
                {customer.detailed_address || customer.permanent_address || '—'}
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-green-600 hover:text-green-700 hover:bg-green-50"
                    onClick={() => onView(customer)}
                  >
                    <Eye className="h-4 w-4" />
                  </Button>
                  {canManageCustomer(customer) && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-orange-500 hover:text-orange-600 hover:bg-orange-50"
                      onClick={() => onEdit(customer)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                  )}
                  {canManageCustomer(customer) && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-red-500 hover:text-red-600 hover:bg-red-50"
                      onClick={() => onDelete(customer)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
