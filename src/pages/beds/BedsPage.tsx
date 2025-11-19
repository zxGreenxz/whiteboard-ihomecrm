import { useState, useMemo } from "react";
import { useBeds } from "@/hooks/useBeds";
import { useRooms } from "@/hooks/useRooms";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plus, Search, Pencil, Trash2, Bed as BedIcon } from "lucide-react";
import { CreateBedDialog } from "@/components/beds/CreateBedDialog";
import { EditBedDialog } from "@/components/beds/EditBedDialog";
import { DeleteBedDialog } from "@/components/beds/DeleteBedDialog";
import type { Database } from "@/integrations/supabase/types";

type BedWithRoom = Database["public"]["Tables"]["beds"]["Row"] & {
  room?: { id: string; name: string; code: string | null; building_id: string; floor: number } | null;
};

export default function BedsPage() {
  const [buildingFilter, setBuildingFilter] = useState<string>("all");
  const [roomFilter, setRoomFilter] = useState<string>("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedBed, setSelectedBed] = useState<BedWithRoom | null>(null);

  const { data: buildings } = useBuildings();
  const { data: allRooms } = useRooms();
  const { data: beds, isLoading } = useBeds(roomFilter !== "all" ? roomFilter : undefined);

  // Filter buildings to only show DORMITORY or SLEEPBOX types
  const dormitoryBuildings = useMemo(() => {
    return buildings?.filter(
      (b) => b.type === "DORMITORY" || b.type === "SLEEPBOX"
    );
  }, [buildings]);

  // Filter rooms based on selected building and type
  const availableRooms = useMemo(() => {
    if (!allRooms || !dormitoryBuildings) return [];
    
    const dormitoryBuildingIds = new Set(dormitoryBuildings.map(b => b.id));
    
    return allRooms.filter((room) => {
      if (buildingFilter === "all") {
        return dormitoryBuildingIds.has(room.building_id);
      }
      return room.building_id === buildingFilter;
    });
  }, [allRooms, dormitoryBuildings, buildingFilter]);

  // Filter beds based on search and status
  const filteredBeds = useMemo(() => {
    if (!beds) return [];

    return beds.filter((bed) => {
      const matchesSearch =
        bed.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        bed.code?.toLowerCase().includes(searchTerm.toLowerCase());

      const matchesStatus =
        statusFilter === "all" || bed.status === statusFilter;

      return matchesSearch && matchesStatus;
    });
  }, [beds, searchTerm, statusFilter]);

  const handleEdit = (bed: BedWithRoom) => {
    setSelectedBed(bed);
    setEditDialogOpen(true);
  };

  const handleDelete = (bed: BedWithRoom) => {
    setSelectedBed(bed);
    setDeleteDialogOpen(true);
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

  // Show message if no DORMITORY or SLEEPBOX buildings
  if (!dormitoryBuildings || dormitoryBuildings.length === 0) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <BedIcon className="h-8 w-8" />
          <h1 className="text-3xl font-bold">Quản lý Giường</h1>
        </div>
        <Card>
          <CardContent className="pt-6">
            <div className="text-center py-12 text-muted-foreground">
              <BedIcon className="h-16 w-16 mx-auto mb-4 opacity-20" />
              <p className="text-lg">Quản lý giường chỉ khả dụng cho Ký túc xá và Sleepbox.</p>
              <p className="text-sm mt-2">
                Vui lòng tạo tòa nhà loại "Ký túc xá" hoặc "Sleepbox" để sử dụng tính năng này.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-3">
          <BedIcon className="h-8 w-8" />
          <h1 className="text-3xl font-bold">Quản lý Giường</h1>
        </div>
        <Button onClick={() => setCreateDialogOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Tạo giường
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Danh sách Giường</CardTitle>
        </CardHeader>
        <CardContent>
          {/* Search and Filters */}
          <div className="flex gap-4 mb-6">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
              <Input
                placeholder="Tìm kiếm theo tên, mã giường..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
              />
            </div>
            <Select value={buildingFilter} onValueChange={(value) => {
              setBuildingFilter(value);
              setRoomFilter("all"); // Reset room filter when building changes
            }}>
              <SelectTrigger className="w-[220px]">
                <SelectValue placeholder="Lọc theo tòa nhà" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tất cả tòa nhà</SelectItem>
                {dormitoryBuildings?.map((building) => (
                  <SelectItem key={building.id} value={building.id}>
                    {building.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={roomFilter} onValueChange={setRoomFilter}>
              <SelectTrigger className="w-[220px]">
                <SelectValue placeholder="Lọc theo phòng" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tất cả phòng</SelectItem>
                {availableRooms?.map((room) => (
                  <SelectItem key={room.id} value={room.id}>
                    {room.name}
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

          {/* Table */}
          {isLoading ? (
            <div className="text-center py-8 text-muted-foreground">
              Đang tải...
            </div>
          ) : filteredBeds && filteredBeds.length > 0 ? (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Tên giường</TableHead>
                    <TableHead>Phòng</TableHead>
                    <TableHead className="text-right">Giá thuê</TableHead>
                    <TableHead className="text-right">Tiền cọc</TableHead>
                    <TableHead>Trạng thái</TableHead>
                    <TableHead className="text-right">Thao tác</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredBeds.map((bed) => (
                    <TableRow key={bed.id}>
                      <TableCell className="font-medium">
                        {bed.name}
                        {bed.code && (
                          <span className="text-sm text-muted-foreground ml-2">
                            ({bed.code})
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {bed.room?.name || "-"}
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {formatCurrency(bed.rent_price)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatCurrency(bed.deposit_amount)}
                      </TableCell>
                      <TableCell>{getStatusBadge(bed.status)}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleEdit(bed)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDelete(bed)}
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
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              {searchTerm || buildingFilter !== "all" || roomFilter !== "all" || statusFilter !== "all"
                ? "Không tìm thấy giường nào"
                : "Chưa có giường nào. Nhấn 'Tạo giường' để bắt đầu."}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Dialogs */}
      <CreateBedDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
      />
      {selectedBed && (
        <>
          <EditBedDialog
            open={editDialogOpen}
            onOpenChange={setEditDialogOpen}
            bed={selectedBed}
          />
          <DeleteBedDialog
            open={deleteDialogOpen}
            onOpenChange={setDeleteDialogOpen}
            bed={selectedBed}
          />
        </>
      )}
    </div>
  );
}
