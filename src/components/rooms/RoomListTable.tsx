import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Pencil, Trash2, QrCode } from 'lucide-react';
import type { RoomWithRelations } from '@/types/room';

interface RoomListTableProps {
  rooms: RoomWithRelations[];
  onEdit: (room: RoomWithRelations) => void;
  onDelete: (room: RoomWithRelations) => void;
  onToggleStatus: (id: string, isActive: boolean) => void;
  onShowQR?: (room: RoomWithRelations) => void;
}

const formatCurrency = (amount: number) => {
  return new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND',
  }).format(amount);
};

export default function RoomListTable({
  rooms,
  onEdit,
  onDelete,
  onToggleStatus,
  onShowQR,
}: RoomListTableProps) {
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Tên phòng</TableHead>
            <TableHead>Toà nhà</TableHead>
            <TableHead className="text-center">Tầng</TableHead>
            <TableHead className="text-right">Diện tích</TableHead>
            <TableHead className="text-right">Giá thuê</TableHead>
            <TableHead className="text-right">Tiền cọc</TableHead>
            <TableHead className="text-center">Số khách tối đa</TableHead>
            <TableHead className="text-center">Hoạt động</TableHead>
            <TableHead className="w-[140px]">Thao tác</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rooms.map((room) => (
            <TableRow key={room.id}>
              <TableCell className="font-medium">
                {room.name}
                {room.code && (
                  <span className="text-sm text-muted-foreground ml-2">
                    ({room.code})
                  </span>
                )}
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {room.building?.name || '-'}
              </TableCell>
              <TableCell className="text-center text-sm">
                {room.floor}
              </TableCell>
              <TableCell className="text-right text-sm">
                {room.area ? `${room.area} m²` : '-'}
              </TableCell>
              <TableCell className="text-right font-medium">
                {formatCurrency(room.rent_price)}
              </TableCell>
              <TableCell className="text-right">
                {formatCurrency(room.deposit_amount)}
              </TableCell>
              <TableCell className="text-center text-sm">
                {room.max_occupants ?? '-'}
              </TableCell>
              <TableCell className="text-center">
                <Switch
                  checked={room.status === 'AVAILABLE'}
                  onCheckedChange={(checked) =>
                    onToggleStatus(room.id, checked)
                  }
                />
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-1">
                  {onShowQR && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                      onClick={() => onShowQR(room)}
                      title="QR phòng (khách quét xem hoá đơn)"
                    >
                      <QrCode className="h-4 w-4" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-green-600 hover:text-green-700 hover:bg-green-50"
                    onClick={() => onEdit(room)}
                    title="Sửa"
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-red-600 hover:text-red-700 hover:bg-red-50"
                    onClick={() => onDelete(room)}
                    title="Xoá"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
