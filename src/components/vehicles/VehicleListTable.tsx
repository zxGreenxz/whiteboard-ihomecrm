import { Pencil, Trash2 } from 'lucide-react';
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
import type { VehicleWithRelations } from '@/types/vehicle';
import { useMyBuildingScope } from '@/hooks/useMyBuildingScope';

const VEHICLE_TYPE_LABELS: Record<string, string> = {
  MOTORBIKE: 'Xe máy',
  CAR: 'Ô tô',
  BICYCLE: 'Xe đạp',
  ELECTRIC_BIKE: 'Xe điện',
  OTHER: 'Khác',
};

interface VehicleListTableProps {
  vehicles: VehicleWithRelations[];
  onEdit: (vehicle: VehicleWithRelations) => void;
  onDelete: (vehicle: VehicleWithRelations) => void;
  isLoading?: boolean;
}

export default function VehicleListTable({
  vehicles,
  onEdit,
  onDelete,
  isLoading,
}: VehicleListTableProps) {
  const { canManageBuilding, canManageAll } = useMyBuildingScope();
  // Phương tiện không gắn building (vd hộp xe chung) chỉ caller toàn quyền
  // quản; staff theo tòa phải khớp building_id.
  const canManageVehicle = (vehicle: VehicleWithRelations) => {
    if (canManageAll) return true;
    return canManageBuilding(vehicle.building_id);
  };

  if (isLoading) {
    return (
      <div className="p-8 text-center text-muted-foreground">Đang tải dữ liệu...</div>
    );
  }

  if (vehicles.length === 0) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        Không có phương tiện nào
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
            <TableHead>Thông tin xe</TableHead>
            <TableHead>Khách hàng</TableHead>
            <TableHead>Vị trí</TableHead>
            <TableHead className="w-24">Thao tác</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {vehicles.map((vehicle) => (
            <TableRow key={vehicle.id}>
              <TableCell>
                <Checkbox />
              </TableCell>
              <TableCell>
                <div>
                  <p className="text-sm font-medium">
                    {VEHICLE_TYPE_LABELS[vehicle.vehicle_type] || vehicle.vehicle_type}
                    {vehicle.vehicle_name ? ` - ${vehicle.vehicle_name}` : ''}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {vehicle.license_plate || '—'}
                    {vehicle.color ? ` · ${vehicle.color}` : ''}
                  </p>
                </div>
              </TableCell>
              <TableCell>
                {vehicle.customer ? (
                  <div>
                    <p className="text-sm font-medium">{vehicle.customer.full_name}</p>
                    <p className="text-xs text-muted-foreground">{vehicle.customer.phone || '—'}</p>
                  </div>
                ) : (
                  <span className="text-sm text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell>
                {vehicle.building || vehicle.room ? (
                  <div>
                    <p className="text-sm">{vehicle.building?.name || '—'}</p>
                    {vehicle.room && (
                      <p className="text-xs text-muted-foreground">{vehicle.room.name}</p>
                    )}
                  </div>
                ) : (
                  <span className="text-sm text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-1">
                  {canManageVehicle(vehicle) && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-orange-500 hover:text-orange-600 hover:bg-orange-50"
                      onClick={() => onEdit(vehicle)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                  )}
                  {canManageVehicle(vehicle) && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-red-500 hover:text-red-600 hover:bg-red-50"
                      onClick={() => onDelete(vehicle)}
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
