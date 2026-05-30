import { useState } from "react";
import MainLayout from "@/components/layout/MainLayout";
import { useAreas } from "@/hooks/useAreas";
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
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plus, Search, Pencil, Trash2, MapPin } from "lucide-react";
import EmptyState from "@/components/ui/EmptyState";
import { CreateAreaDialog } from "@/components/areas/CreateAreaDialog";
import { EditAreaDialog } from "@/components/areas/EditAreaDialog";
import { DeleteAreaDialog } from "@/components/areas/DeleteAreaDialog";
import type { Database } from "@/integrations/supabase/types";

type AreaWithRelations = Database["public"]["Tables"]["areas"]["Row"] & {
  buildings_count?: number;
};

export default function AreasPage() {
  const { data: areasData, isLoading } = useAreas();
  const areas = Array.isArray(areasData) ? areasData : [];
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedArea, setSelectedArea] = useState<AreaWithRelations | null>(null);

  const filteredAreas = Array.isArray(areas) ? areas.filter((area) => {
    const matchesSearch =
      area.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      area.code?.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesStatus =
      statusFilter === "all" || area.status === statusFilter;

    return matchesSearch && matchesStatus;
  }) : [];

  const handleEdit = (area: AreaWithRelations) => {
    setSelectedArea(area);
    setEditDialogOpen(true);
  };

  const handleDelete = (area: AreaWithRelations) => {
    setSelectedArea(area);
    setDeleteDialogOpen(true);
  };

  const getStatusBadge = (status: string) => {
    const variants: Record<string, "default" | "secondary"> = {
      ACTIVE: "default",
      INACTIVE: "secondary",
    };

    const labels: Record<string, string> = {
      ACTIVE: "Hoạt động",
      INACTIVE: "Không hoạt động",
    };

    return (
      <Badge variant={variants[status] || "default"}>
        {labels[status] || status}
      </Badge>
    );
  };

  return (
    <MainLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <MapPin className="h-6 w-6 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">Quản lý Khu vực</h1>
              <p className="text-sm text-muted-foreground">Quản lý danh sách và thông tin khu vực</p>
            </div>
          </div>
          <Button onClick={() => setCreateDialogOpen(true)} className="shadow-sm">
            <Plus className="mr-2 h-4 w-4" />
            Tạo khu vực
          </Button>
        </div>

        <Card className="shadow-sm">
          <CardHeader className="pb-4">
            <CardTitle className="text-lg">Danh sách Khu vực</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-4 mb-6">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
                <Input
                  placeholder="Tìm kiếm theo tên, mã khu vực..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10"
                />
              </div>
              <SearchableSelect
                value={statusFilter}
                onValueChange={setStatusFilter}
                className="w-[180px]"
                placeholder="Trạng thái"
                options={[
                  { value: "all", label: "Tất cả" },
                  { value: "ACTIVE", label: "Hoạt động" },
                  { value: "INACTIVE", label: "Không hoạt động" },
                ]}
              />
            </div>

            {isLoading ? (
              <div className="text-center py-8 text-muted-foreground">
                Đang tải...
              </div>
            ) : filteredAreas && filteredAreas.length > 0 ? (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Mã</TableHead>
                      <TableHead>Tên khu vực</TableHead>
                      <TableHead>Mô tả</TableHead>
                      <TableHead className="text-center">Số tòa nhà</TableHead>
                      <TableHead>Trạng thái</TableHead>
                      <TableHead className="text-right">Thao tác</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredAreas.map((area) => (
                      <TableRow key={area.id}>
                        <TableCell className="font-medium">
                          {area.code || "-"}
                        </TableCell>
                        <TableCell className="font-medium">{area.name}</TableCell>
                        <TableCell className="max-w-xs truncate">
                          <span className="text-sm text-muted-foreground">
                            {area.description || "-"}
                          </span>
                        </TableCell>
                        <TableCell className="text-center">
                          <Badge variant="outline">{area.buildings_count || 0}</Badge>
                        </TableCell>
                        <TableCell>{getStatusBadge(area.status)}</TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleEdit(area)}
                              title="Chỉnh sửa"
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleDelete(area)}
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
              searchTerm || statusFilter !== "all" ? (
                <div className="text-center py-8 text-muted-foreground">
                  Không tìm thấy khu vực nào
                </div>
              ) : (
                <EmptyState
                  icon={MapPin}
                  title="Chưa có khu vực nào"
                  description="Hãy thêm khu vực đầu tiên để bắt đầu quản lý"
                  actionLabel="Tạo khu vực"
                  onAction={() => setCreateDialogOpen(true)}
                />
              )
            )}
          </CardContent>
        </Card>

        <CreateAreaDialog
          open={createDialogOpen}
          onOpenChange={setCreateDialogOpen}
        />
        {selectedArea && (
          <>
            <EditAreaDialog
              open={editDialogOpen}
              onOpenChange={setEditDialogOpen}
              area={selectedArea}
            />
            <DeleteAreaDialog
              open={deleteDialogOpen}
              onOpenChange={setDeleteDialogOpen}
              area={selectedArea}
            />
          </>
        )}
      </div>
    </MainLayout>
  );
}