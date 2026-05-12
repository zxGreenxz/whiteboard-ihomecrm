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
import { Pencil, Trash2, Printer } from 'lucide-react';
import type { BuildingWithRelations } from '@/types/building';

interface BuildingListTableProps {
  buildings: BuildingWithRelations[];
  onEdit: (building: BuildingWithRelations) => void;
  onDelete: (building: BuildingWithRelations) => void;
  onToggleStatus: (id: string, newStatus: 'ACTIVE' | 'INACTIVE') => void;
  onViewRooms: (buildingId: string) => void;
}

export default function BuildingListTable({
  buildings,
  onEdit,
  onDelete,
  onToggleStatus,
  onViewRooms,
}: BuildingListTableProps) {
  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
  };

  const formatAddress = (building: BuildingWithRelations) => {
    const parts = [
      building.street_address,
      building.ward,
      building.district,
      building.province,
    ].filter(Boolean);
    return parts.join(', ');
  };

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[120px]">Mã</TableHead>
            <TableHead className="w-[120px]">Thao tác</TableHead>
            <TableHead>Tên toà nhà</TableHead>
            <TableHead>Địa chỉ</TableHead>
            <TableHead className="text-center">Số căn hộ</TableHead>
            <TableHead>Ngày TT</TableHead>
            <TableHead className="text-center">Hoạt động</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {buildings.map((building) => (
            <TableRow key={building.id}>
              <TableCell className="font-medium text-sm">
                {building.code || '-'}
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-green-600 hover:text-green-700 hover:bg-green-50"
                    onClick={() => onEdit(building)}
                    title="Sửa"
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-red-600 hover:text-red-700 hover:bg-red-50"
                    onClick={() => onDelete(building)}
                    title="Xoá"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-foreground"
                    onClick={() => window.print()}
                    title="In"
                  >
                    <Printer className="h-4 w-4" />
                  </Button>
                </div>
              </TableCell>
              <TableCell className="font-medium">{building.name}</TableCell>
              <TableCell className="max-w-xs">
                <span className="text-sm text-muted-foreground truncate block">
                  {formatAddress(building)}
                </span>
              </TableCell>
              <TableCell className="text-center">
                <span className="text-sm">
                  {building.rooms_count || 0} căn hộ{' '}
                  <button
                    type="button"
                    className="text-blue-600 hover:text-blue-800 hover:underline font-medium"
                    onClick={() => onViewRooms(building.id)}
                  >
                    (Xem)
                  </button>
                </span>
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {formatDate(building.updated_at || building.created_at)}
              </TableCell>
              <TableCell className="text-center">
                <Switch
                  checked={building.status === 'ACTIVE'}
                  onCheckedChange={(checked) =>
                    onToggleStatus(building.id, checked ? 'ACTIVE' : 'INACTIVE')
                  }
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
