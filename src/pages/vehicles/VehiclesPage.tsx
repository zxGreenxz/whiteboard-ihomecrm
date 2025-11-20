import { useState } from "react";
import { Plus, Search, Car } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useVehicles, type VehicleWithRelations } from "@/hooks/useVehicles";
import { useBuildings } from "@/hooks/useBuildings";
import { CreateVehicleDialog } from "@/components/vehicles/CreateVehicleDialog";
import { EditVehicleDialog } from "@/components/vehicles/EditVehicleDialog";
import { formatCurrency } from "@/lib/utils";

const VEHICLE_TYPE_CONFIG = {
  MOTORBIKE: { label: "Xe máy", color: "bg-blue-100 text-blue-800", icon: "🏍️" },
  CAR: { label: "Ô tô", color: "bg-purple-100 text-purple-800", icon: "🚗" },
  BICYCLE: { label: "Xe đạp", color: "bg-green-100 text-green-800", icon: "🚲" },
  ELECTRIC_BIKE: { label: "Xe điện", color: "bg-yellow-100 text-yellow-800", icon: "⚡" },
  OTHER: { label: "Khác", color: "bg-gray-100 text-gray-800", icon: "🚛" },
};

const VehiclesPage = () => {
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [selectedVehicle, setSelectedVehicle] = useState<VehicleWithRelations | null>(null);
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState("");

  const { data: vehicles = [], isLoading } = useVehicles({
    vehicle_type: typeFilter || undefined,
  });

  const { data: buildings = [] } = useBuildings();

  const handleEdit = (vehicle: VehicleWithRelations) => {
    setSelectedVehicle(vehicle);
    setEditDialogOpen(true);
  };

  const filteredVehicles = vehicles.filter((vehicle) => {
    if (!searchQuery) return true;
    const search = searchQuery.toLowerCase();
    return (
      vehicle.license_plate?.toLowerCase().includes(search) ||
      vehicle.brand?.toLowerCase().includes(search) ||
      vehicle.model?.toLowerCase().includes(search) ||
      vehicle.tenant?.full_name?.toLowerCase().includes(search) ||
      vehicle.contract?.contract_number?.toLowerCase().includes(search)
    );
  });

  // Calculate summary stats
  const totalVehicles = filteredVehicles.length;
  const totalParkingFees = filteredVehicles.reduce((sum, v) => sum + (v.parking_fee || 0), 0);
  const byType = filteredVehicles.reduce((acc, v) => {
    const type = v.vehicle_type || "OTHER";
    acc[type] = (acc[type] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="flex items-center justify-center h-96">
          <p className="text-muted-foreground">Đang tải...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Quản lý Phương tiện</h1>
          <p className="text-muted-foreground mt-1">
            Theo dõi và quản lý phương tiện của khách thuê
          </p>
        </div>
        <Button onClick={() => setCreateDialogOpen(true)}>
          <Plus className="w-4 h-4 mr-2" />
          Thêm phương tiện
        </Button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Tổng số xe
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalVehicles}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Tổng phí gửi xe
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">
              {formatCurrency(totalParkingFees)}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <span>🏍️</span> Xe máy
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">
              {byType.MOTORBIKE || 0}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <span>🚗</span> Ô tô
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-purple-600">
              {byType.CAR || 0}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <span>⚡</span> Xe điện
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-yellow-600">
              {byType.ELECTRIC_BIKE || 0}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground w-4 h-4" />
          <Input
            placeholder="Tìm kiếm theo biển số, hãng xe, chủ xe..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="Lọc theo loại" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">Tất cả loại</SelectItem>
            {Object.entries(VEHICLE_TYPE_CONFIG).map(([key, config]) => (
              <SelectItem key={key} value={key}>
                {config.icon} {config.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Vehicles Table */}
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Loại xe</TableHead>
              <TableHead>Biển số</TableHead>
              <TableHead>Hãng / Model</TableHead>
              <TableHead>Chủ xe</TableHead>
              <TableHead>Hợp đồng</TableHead>
              <TableHead>Vị trí</TableHead>
              <TableHead>Phí gửi xe</TableHead>
              <TableHead>Thao tác</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredVehicles.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                  Không tìm thấy phương tiện nào
                </TableCell>
              </TableRow>
            ) : (
              filteredVehicles.map((vehicle) => (
                <TableRow key={vehicle.id}>
                  <TableCell>
                    <Badge
                      className={
                        VEHICLE_TYPE_CONFIG[vehicle.vehicle_type as keyof typeof VEHICLE_TYPE_CONFIG]?.color || ""
                      }
                    >
                      {VEHICLE_TYPE_CONFIG[vehicle.vehicle_type as keyof typeof VEHICLE_TYPE_CONFIG]?.icon}{" "}
                      {VEHICLE_TYPE_CONFIG[vehicle.vehicle_type as keyof typeof VEHICLE_TYPE_CONFIG]?.label ||
                        vehicle.vehicle_type}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono font-semibold">
                    {vehicle.license_plate || "-"}
                  </TableCell>
                  <TableCell>
                    {vehicle.brand && vehicle.model
                      ? `${vehicle.brand} ${vehicle.model}`
                      : vehicle.brand || vehicle.model || "-"}
                  </TableCell>
                  <TableCell>
                    <div>
                      <div className="font-medium">{vehicle.tenant?.full_name || "-"}</div>
                      {vehicle.tenant?.phone && (
                        <div className="text-sm text-muted-foreground">
                          {vehicle.tenant.phone}
                        </div>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-sm">
                    {vehicle.contract?.contract_number || "-"}
                  </TableCell>
                  <TableCell>
                    {vehicle.contract?.room?.building?.name}
                    {vehicle.contract?.room && ` - ${vehicle.contract.room.name}`}
                  </TableCell>
                  <TableCell className="font-semibold text-blue-600">
                    {vehicle.parking_fee ? formatCurrency(vehicle.parking_fee) : "-"}
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleEdit(vehicle)}
                    >
                      Sửa
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      {/* Dialogs */}
      <CreateVehicleDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
      />

      {selectedVehicle && (
        <EditVehicleDialog
          open={editDialogOpen}
          onOpenChange={setEditDialogOpen}
          vehicle={selectedVehicle}
        />
      )}
    </div>
  );
};

export default VehiclesPage;
