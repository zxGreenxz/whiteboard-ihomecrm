import { useState } from "react";
import MainLayout from "@/components/layout/MainLayout";
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
import { Plus, Search, Pencil, Trash2, Building2, Upload, Download, MoreHorizontal, Eye } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { CreateBuildingDialog } from "@/components/buildings/CreateBuildingDialog";
import { EditBuildingDialog } from "@/components/buildings/EditBuildingDialog";
import { DeleteBuildingDialog } from "@/components/buildings/DeleteBuildingDialog";
import { ImportExcelDialog, ExportExcelDialog } from "@/components/import-export";
import type { Database } from "@/integrations/supabase/types";

type BuildingWithRelations = Database["public"]["Tables"]["buildings"]["Row"] & {
  area?: { id: string; name: string; code: string | null } | null;
  rooms_count?: number;
};

export default function BuildingsPage() {
  const navigate = useNavigate();
  const { data: buildingsData, isLoading } = useBuildings();
  // DEFENSIVE CHECK: ensure buildings is array
  const buildings = Array.isArray(buildingsData) ? buildingsData : [];
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [selectedBuilding, setSelectedBuilding] = useState<BuildingWithRelations | null>(null);

  // Filter buildings based on search, status, and type - DEFENSIVE CHECK
  const filteredBuildings = Array.isArray(buildings) ? buildings.filter((building) => {
    const matchesSearch =
      building.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      building.code?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      building.street_address?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      building.area?.name?.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesStatus =
      statusFilter === "all" || building.status === statusFilter;

    const matchesType =
      typeFilter === "all" || building.type === typeFilter;

    return matchesSearch && matchesStatus && matchesType;
  }) : [];

  const handleEdit = (building: BuildingWithRelations) => {
    setSelectedBuilding(building);
    setEditDialogOpen(true);
  };

  const handleDelete = (building: BuildingWithRelations) => {
    setSelectedBuilding(building);
    setDeleteDialogOpen(true);
  };

  const getStatusBadge = (status: string) => {
    const variants: Record<string, "default" | "secondary" | "destructive"> = {
      ACTIVE: "default",
      INACTIVE: "secondary",
      MAINTENANCE: "destructive",
    };

    const labels: Record<string, string> = {
      ACTIVE: "Hoạt động",
      INACTIVE: "Không hoạt động",
      MAINTENANCE: "Bảo trì",
    };

    return (
      <Badge variant={variants[status] || "default"}>
        {labels[status] || status}
      </Badge>
    );
  };

  const getTypeBadge = (type: string) => {
    const labels: Record<string, string> = {
      APARTMENT: "Chung cư",
      DORMITORY: "Ký túc xá",
      HOUSE: "Nhà riêng",
      OFFICE: "Văn phòng",
      SLEEPBOX: "Sleepbox",
    };

    return (
      <Badge variant="outline">
        {labels[type] || type}
      </Badge>
    );
  };

  return (
    <MainLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <Building2 className="h-6 w-6 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">Quản lý Tòa nhà</h1>
              <p className="text-sm text-muted-foreground">Quản lý danh sách và thông tin tòa nhà</p>
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
          <Button onClick={() => setCreateDialogOpen(true)} className="shadow-sm">
            <Plus className="mr-2 h-4 w-4" />
            Tạo tòa nhà
          </Button>
        </div>
      </div>

      <Card className="shadow-sm">
        <CardHeader className="pb-4">
          <CardTitle className="text-lg">Danh sách Tòa nhà</CardTitle>
        </CardHeader>
        <CardContent>
          {/* Search and Filters */}
          <div className="flex gap-4 mb-6">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
              <Input
                placeholder="Tìm kiếm theo tên, mã, địa chỉ, khu vực..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
              />
            </div>
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Loại hình" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tất cả loại hình</SelectItem>
                <SelectItem value="APARTMENT">Chung cư</SelectItem>
                <SelectItem value="DORMITORY">Ký túc xá</SelectItem>
                <SelectItem value="HOUSE">Nhà riêng</SelectItem>
                <SelectItem value="OFFICE">Văn phòng</SelectItem>
                <SelectItem value="SLEEPBOX">Sleepbox</SelectItem>
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Trạng thái" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tất cả</SelectItem>
                <SelectItem value="ACTIVE">Hoạt động</SelectItem>
                <SelectItem value="INACTIVE">Không hoạt động</SelectItem>
                <SelectItem value="MAINTENANCE">Bảo trì</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Table */}
          {isLoading ? (
            <div className="text-center py-8 text-muted-foreground">
              Đang tải...
            </div>
          ) : filteredBuildings && filteredBuildings.length > 0 ? (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Mã</TableHead>
                    <TableHead>Tên tòa nhà</TableHead>
                    <TableHead>Khu vực</TableHead>
                    <TableHead>Loại hình</TableHead>
                    <TableHead>Địa chỉ</TableHead>
                    <TableHead className="text-center">Số phòng</TableHead>
                    <TableHead>Trạng thái</TableHead>
                    <TableHead className="text-right">Thao tác</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredBuildings.map((building) => (
                    <TableRow key={building.id}>
                      <TableCell className="font-medium">
                        {building.code || "-"}
                      </TableCell>
                      <TableCell className="font-medium">{building.name}</TableCell>
                      <TableCell>
                        {building.area ? (
                          <span className="text-sm text-muted-foreground">
                            {building.area.name}
                          </span>
                        ) : (
                          <span className="text-sm text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell>{getTypeBadge(building.type)}</TableCell>
                      <TableCell className="max-w-xs truncate">
                        {building.street_address ? (
                          <span className="text-sm text-muted-foreground">
                            {building.street_address}, {building.ward}, {building.district}, {building.province}
                          </span>
                        ) : (
                          <span className="text-sm text-muted-foreground">
                            {building.ward}, {building.district}, {building.province}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge variant="outline">{building.rooms_count || 0}</Badge>
                      </TableCell>
                      <TableCell>{getStatusBadge(building.status)}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => navigate(`/buildings/${building.id}`)}
                            title="Xem chi tiết"
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleEdit(building)}
                            title="Chỉnh sửa"
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDelete(building)}
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
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              {searchTerm || statusFilter !== "all" || typeFilter !== "all"
                ? "Không tìm thấy tòa nhà nào"
                : "Chưa có tòa nhà nào. Nhấn 'Tạo tòa nhà' để bắt đầu."}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Dialogs */}
      <CreateBuildingDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
      />
      {selectedBuilding && (
        <>
          <EditBuildingDialog
            open={editDialogOpen}
            onOpenChange={setEditDialogOpen}
            building={selectedBuilding}
          />
          <DeleteBuildingDialog
            open={deleteDialogOpen}
            onOpenChange={setDeleteDialogOpen}
            building={selectedBuilding}
          />
        </>
      )}

      {/* Import/Export Dialogs */}
      <ImportExcelDialog
        open={importDialogOpen}
        onOpenChange={setImportDialogOpen}
        importType="buildings"
      />
      <ExportExcelDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
        exportType="buildings"
      />
      </div>
    </MainLayout>
  );
}
