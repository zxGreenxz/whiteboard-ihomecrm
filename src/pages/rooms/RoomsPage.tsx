import { useState, useMemo } from "react";
import { useRooms, useUpdateRoomStatus } from "@/hooks/useRooms";
import { useBuildings } from "@/hooks/useBuildings";
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
import { useNavigate } from "react-router-dom";
import { CreateRoomDialog } from "@/components/rooms/CreateRoomDialog";
import { EditRoomDialog } from "@/components/rooms/EditRoomDialog";
import { DeleteRoomDialog } from "@/components/rooms/DeleteRoomDialog";
import { BulkCreateRoomsDialog } from "@/components/rooms/BulkCreateRoomsDialog";
import { ImportExcelDialog, ExportExcelDialog } from "@/components/import-export";
import type { Database } from "@/integrations/supabase/types";

type RoomWithBuilding = Database["public"]["Tables"]["rooms"]["Row"] & {
  building?: { id: string; name: string; code: string | null; area_id: string | null } | null;
};

export default function RoomsPage() {
  const navigate = useNavigate();
  const [buildingFilter, setBuildingFilter] = useState<string>("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [bulkCreateDialogOpen, setBulkCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [selectedRoom, setSelectedRoom] = useState<RoomWithBuilding | null>(null);

  const { data: buildings } = useBuildings();
  const { data: rooms, isLoading } = useRooms(buildingFilter !== "all" ? buildingFilter : undefined);
  const updateStatus = useUpdateRoomStatus();

  // Filter and group rooms
  const filteredRooms = useMemo(() => {
    if (!rooms) return [];

    return rooms.filter((room) => {
      const matchesSearch =
        room.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        room.code?.toLowerCase().includes(searchTerm.toLowerCase());

      const matchesStatus =
        statusFilter === "all" || room.status === statusFilter;

      return matchesSearch && matchesStatus;
    });
  }, [rooms, searchTerm, statusFilter]);

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
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-3">
          <Home className="h-8 w-8" />
          <h1 className="text-3xl font-bold">Quản lý Phòng</h1>
        </div>
        <div className="flex gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">
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
          <Button variant="outline" onClick={() => setBulkCreateDialogOpen(true)}>
            <Layers className="mr-2 h-4 w-4" />
            Tạo hàng loạt
          </Button>
          <Button onClick={() => setCreateDialogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Tạo phòng
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Danh sách Phòng</CardTitle>
        </CardHeader>
        <CardContent>
          {/* Search and Filters */}
          <div className="flex gap-4 mb-6">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
              <Input
                placeholder="Tìm kiếm theo tên, mã phòng..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
              />
            </div>
            <Select value={buildingFilter} onValueChange={setBuildingFilter}>
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
                      ({rooms.length} phòng)
                    </span>
                  </h3>
                  <div className="rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Tên phòng</TableHead>
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
            <div className="text-center py-8 text-muted-foreground">
              {searchTerm || buildingFilter !== "all" || statusFilter !== "all"
                ? "Không tìm thấy phòng nào"
                : "Chưa có phòng nào. Nhấn 'Tạo phòng' để bắt đầu."}
            </div>
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
  );
}
