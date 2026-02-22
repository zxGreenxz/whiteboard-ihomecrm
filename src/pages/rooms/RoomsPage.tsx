import { useState, useMemo } from "react";
import MainLayout from "@/components/layout/MainLayout";
import { useRooms, useUpdateRoomStatus } from "@/hooks/useRooms";
import { useBuildings } from "@/hooks/useBuildings";
import { useFloors } from "@/hooks/useFloors";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plus, Search, Pencil, Trash2, Home, RefreshCw, Layers, Upload, Download, MoreHorizontal, Eye } from "lucide-react";
import EmptyState from "@/components/ui/EmptyState";
import { useNavigate } from "react-router-dom";
import { CreateRoomDialog } from "@/components/rooms/CreateRoomDialog";
import { EditRoomDialog } from "@/components/rooms/EditRoomDialog";
import { DeleteRoomDialog } from "@/components/rooms/DeleteRoomDialog";
import { BulkCreateRoomsDialog } from "@/components/rooms/BulkCreateRoomsDialog";
import { ImportExcelDialog, ExportExcelDialog } from "@/components/import-export";
import type { Database } from "@/integrations/supabase/types";

type RoomWithBuilding = Database["public"]["Tables"]["rooms"]["Row"] & {
  building?: { id: string; name: string; code: string | null } | null;
};

export default function RoomsPage() {
  const navigate = useNavigate();
  const [buildingFilter, setBuildingFilter] = useState<string>("all");
  const [floorFilter, setFloorFilter] = useState<string>("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [bulkCreateDialogOpen, setBulkCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [selectedRoom, setSelectedRoom] = useState<RoomWithBuilding | null>(null);

  const { data: buildingsData } = useBuildings();
  // DEFENSIVE CHECK: ensure buildings is array
  const buildings = Array.isArray(buildingsData) ? buildingsData : [];
  const { data: floorsData } = useFloors(buildingFilter !== "all" ? buildingFilter : undefined);
  const floors = Array.isArray(floorsData) ? floorsData : [];
  const { data: roomsData, isLoading } = useRooms(buildingFilter !== "all" ? buildingFilter : undefined);
  // DEFENSIVE CHECK: ensure rooms is array
  const rooms = Array.isArray(roomsData) ? roomsData : [];
  const updateStatus = useUpdateRoomStatus();

  // Filter and group rooms
  const filteredRooms = useMemo(() => {
    // DEFENSIVE CHECK: ensure rooms is array
    if (!Array.isArray(rooms)) return [];

    return rooms.filter((room) => {
      const matchesSearch =
        room.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        room.code?.toLowerCase().includes(searchTerm.toLowerCase());

      const matchesStatus =
        statusFilter === "all" || room.status === statusFilter;

      const matchesFloor =
        floorFilter === "all" || room.floor === parseInt(floorFilter);

      return matchesSearch && matchesStatus && matchesFloor;
    });
  }, [rooms, searchTerm, statusFilter, floorFilter]);

  // Group by floor
  const roomsByFloor = useMemo(() => {
    const grouped = new Map<number, RoomWithBuilding[]>();
    
    filteredRooms.forEach((room) => {
      const floor = room.floor || 0;
      if (!grouped.has(floor)) {
        grouped.set(floor, []);
      }
      grouped.get(floor)!.push(room);
    });

    // Convert to array and sort by floor number
    return Array.from(grouped.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([floor, rooms]) => ({ floor, rooms }));
  }, [filteredRooms]);

  const handleEdit = (room: RoomWithBuilding) => {
    setSelectedRoom(room);
    setEditDialogOpen(true);
  };

  const handleDelete = (room: RoomWithBuilding) => {
    setSelectedRoom(room);
    setDeleteDialogOpen(true);
  };

  const handleStatusChange = async (
    roomId: string,
    newStatus: Database["public"]["Enums"]["room_status"]
  ) => {
    await updateStatus.mutateAsync({ id: roomId, status: newStatus });
  };

  const getStatusBadge = (status: string) => {
    const variants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
      AVAILABLE: "default",
      OCCUPIED: "secondary",
      RESERVED: "outline",
      MAINTENANCE: "destructive",
      UNAVAILABLE: "destructive",
    };

    const labels: Record<string, string> = {
      AVAILABLE: "Trống",
      OCCUPIED: "Đã thuê",
      RESERVED: "Đã đặt",
      MAINTENANCE: "Bảo trì",
      UNAVAILABLE: "Không khả dụng",
    };

    return (
      <Badge variant={variants[status] || "default"}>
        {labels[status] || status}
      </Badge>
    );
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("vi-VN", {
      style: "currency",
      currency: "VND",
    }).format(amount);
  };

  return (
    <MainLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <Home className="h-6 w-6 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">Quản lý Căn hộ</h1>
              <p className="text-sm text-muted-foreground">Quản lý danh sách căn hộ và trạng thái cho thuê</p>
            </div>
          </div>
        <div className="flex gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="shadow-sm">
                <MoreHorizontal className="h-4 w-4 mr-2" />
                Thêm
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setImportDialogOpen(true)}>
                <Upload className="h-4 w-4 mr-2" />
                Import từ Excel
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setExportDialogOpen(true)}>
                <Download className="h-4 w-4 mr-2" />
                Xuất ra Excel
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="outline" onClick={() => setBulkCreateDialogOpen(true)} className="shadow-sm">
            <Layers className="mr-2 h-4 w-4" />
            Tạo hàng loạt
          </Button>
          <Button onClick={() => setCreateDialogOpen(true)} className="shadow-sm">
            <Plus className="mr-2 h-4 w-4" />
            Tạo căn hộ
          </Button>
        </div>
      </div>

      <Card className="shadow-sm">
        <CardHeader className="pb-4">
          <CardTitle className="text-lg">Danh sách Căn hộ</CardTitle>
        </CardHeader>
        <CardContent>
          {/* Search and Filters */}
          <div className="flex gap-4 mb-6">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
              <Input
                placeholder="Tìm kiếm theo tên, mã căn hộ..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
              />
            </div>
            <Select value={buildingFilter} onValueChange={(val) => { setBuildingFilter(val); setFloorFilter("all"); }}>
              <SelectTrigger className="w-[220px]">
                <SelectValue placeholder="Lọc theo tòa nhà" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tất cả tòa nhà</SelectItem>
                {buildings?.map((building) => (
                  <SelectItem key={building.id} value={building.id}>
                    {building.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={floorFilter} onValueChange={setFloorFilter}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Lọc theo tầng" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tất cả tầng</SelectItem>
                {floors.map((floor) => (
                  <SelectItem key={floor.id} value={floor.floor_number.toString()}>
                    Tầng {floor.floor_number}{floor.name ? ` - ${floor.name}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Trạng thái" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tất cả</SelectItem>
                <SelectItem value="AVAILABLE">Trống</SelectItem>
                <SelectItem value="OCCUPIED">Đã thuê</SelectItem>
                <SelectItem value="RESERVED">Đã đặt</SelectItem>
                <SelectItem value="MAINTENANCE">Bảo trì</SelectItem>
                <SelectItem value="UNAVAILABLE">Không khả dụng</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Table Grouped by Floor */}
          {isLoading ? (
            <div className="text-center py-8 text-muted-foreground">
              Đang tải...
            </div>
          ) : roomsByFloor.length > 0 ? (
            <div className="space-y-6">
              {roomsByFloor.map(({ floor, rooms }) => (
                <div key={floor} className="space-y-2">
                  <h3 className="text-lg font-semibold">
                    Tầng {floor}
                    <span className="text-sm text-muted-foreground ml-2">
                      ({rooms.length} căn hộ)
                    </span>
                  </h3>
                  <div className="rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Tên căn hộ</TableHead>
                          <TableHead>Tòa nhà</TableHead>
                          <TableHead className="text-right">Diện tích</TableHead>
                          <TableHead className="text-right">Giá thuê</TableHead>
                          <TableHead className="text-right">Tiền cọc</TableHead>
                          <TableHead>Trạng thái</TableHead>
                          <TableHead className="text-right">Thao tác</TableHead>
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
                              {room.building?.name || "-"}
                            </TableCell>
                            <TableCell className="text-right text-sm">
                              {room.area ? `${room.area} m²` : "-"}
                            </TableCell>
                            <TableCell className="text-right font-medium">
                              {formatCurrency(room.rent_price)}
                            </TableCell>
                            <TableCell className="text-right">
                              {formatCurrency(room.deposit_amount)}
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                {getStatusBadge(room.status)}
                                {room.status === "AVAILABLE" && (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6"
                                    onClick={() =>
                                      handleStatusChange(room.id, "OCCUPIED")
                                    }
                                    title="Đánh dấu đã thuê"
                                  >
                                    <RefreshCw className="h-3 w-3" />
                                  </Button>
                                )}
                              </div>
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="flex justify-end gap-2">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => navigate(`/rooms/${room.id}`)}
                                  title="Xem chi tiết"
                                >
                                  <Eye className="h-4 w-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => handleEdit(room)}
                                  title="Chỉnh sửa"
                                >
                                  <Pencil className="h-4 w-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => handleDelete(room)}
                                  title="Xóa"
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
                </div>
              ))}
            </div>
          ) : (
            searchTerm || buildingFilter !== "all" || statusFilter !== "all" || floorFilter !== "all" ? (
              <div className="text-center py-8 text-muted-foreground">
                Không tìm thấy căn hộ nào
              </div>
            ) : (
              <EmptyState
                icon={Home}
                title="Chưa có căn hộ nào"
                description="Hãy thêm căn hộ đầu tiên để bắt đầu quản lý"
                actionLabel="Tạo căn hộ"
                onAction={() => setCreateDialogOpen(true)}
              />
            )
          )}
        </CardContent>
      </Card>

      {/* Dialogs */}
      <CreateRoomDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
      />
      <BulkCreateRoomsDialog
        open={bulkCreateDialogOpen}
        onOpenChange={setBulkCreateDialogOpen}
      />
      {selectedRoom && (
        <>
          <EditRoomDialog
            open={editDialogOpen}
            onOpenChange={setEditDialogOpen}
            room={selectedRoom}
          />
          <DeleteRoomDialog
            open={deleteDialogOpen}
            onOpenChange={setDeleteDialogOpen}
            room={selectedRoom}
          />
        </>
      )}

      {/* Import/Export Dialogs */}
      <ImportExcelDialog
        open={importDialogOpen}
        onOpenChange={setImportDialogOpen}
        importType="rooms"
      />
      <ExportExcelDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
        exportType="rooms"
      />
      </div>
    </MainLayout>
  );
}
