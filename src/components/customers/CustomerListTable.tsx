import { Eye, Pencil, Trash2 } from 'lucide-react';
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

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '';
  try {
    return new Date(dateStr).toLocaleDateString('vi-VN');
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
            <TableHead className="w-24">Mã KH</TableHead>
            <TableHead className="w-28">Thao tác</TableHead>
            <TableHead>Khách hàng</TableHead>
            <TableHead>Căn hộ đang ở</TableHead>
            <TableHead>CMND/CCCD/Hộ chiếu</TableHead>
            <TableHead>Ngày sinh</TableHead>
            <TableHead>Địa chỉ</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {customers.map((customer) => (
            <TableRow key={customer.id}>
              <TableCell>
                <Checkbox />
              </TableCell>
              <TableCell className="text-xs text-muted-foreground font-mono">
                {customer.id.slice(0, 8).toUpperCase()}
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
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-orange-500 hover:text-orange-600 hover:bg-orange-50"
                    onClick={() => onEdit(customer)}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-red-500 hover:text-red-600 hover:bg-red-50"
                    onClick={() => onDelete(customer)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  {customer.avatar_url ? (
                    <img
                      src={customer.avatar_url}
                      alt={customer.full_name}
                      className="h-8 w-8 rounded-full object-cover"
                    />
                  ) : (
                    <AvatarInitial name={customer.full_name} />
                  )}
                  <div>
                    <p className="text-sm font-medium">{customer.full_name}</p>
                    <p className="text-xs text-muted-foreground">{customer.phone}</p>
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
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
