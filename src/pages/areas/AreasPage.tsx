import { useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plus, Search, Pencil, Trash2 } from "lucide-react";
import { CreateAreaDialog } from "@/components/areas/CreateAreaDialog";
import { EditAreaDialog } from "@/components/areas/EditAreaDialog";
import { DeleteAreaDialog } from "@/components/areas/DeleteAreaDialog";

export default function AreasPage() {
  const { data: areas, isLoading } = useAreas();
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedArea, setSelectedArea] = useState<any>(null);

  // Filter areas based on search and status
  const filteredAreas = areas?.filter((area) => {
    const matchesSearch =
      area.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      area.code?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      area.description?.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesStatus =
      statusFilter === "all" || area.status === statusFilter;

    return matchesSearch && matchesStatus;
  });

  const handleEdit = (area: any) => {
    setSelectedArea(area);
    setEditDialogOpen(true);
  };

  const handleDelete = (area: any) => {
    setSelectedArea(area);
    setDeleteDialogOpen(true);
  };

  const getStatusBadge = (status: string) => {
    const variants: Record<string, "default" | "secondary" | "destructive"> = {
      active: "default",
      inactive: "secondary",
      maintenance: "destructive",
    };

    const labels: Record<string, string> = {
      active: "Hoạt động",
      inactive: "Không hoạt động",
      maintenance: "Bảo trì",
    };

    return (
      <Badge variant={variants[status] || "default"}>
        {labels[status] || status}
      </Badge>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold">Quản lý Khu vực</h1>
        <Button onClick={() => setCreateDialogOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Tạo khu vực
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Danh sách Khu vực</CardTitle>
        </CardHeader>
        <CardContent>
          {/* Search and Filter */}
          <div className="flex gap-4 mb-6">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
              <Input
                placeholder="Tìm kiếm theo tên, mã, mô tả..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="Lọc theo trạng thái" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tất cả</SelectItem>
                <SelectItem value="active">Hoạt động</SelectItem>
                <SelectItem value="inactive">Không hoạt động</SelectItem>
                <SelectItem value="maintenance">Bảo trì</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Table */}
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
                      <TableCell className="text-muted-foreground max-w-md truncate">
                        {area.description || "-"}
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge variant="outline">{area.buildings_count}</Badge>
                      </TableCell>
                      <TableCell>{getStatusBadge(area.status)}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleEdit(area)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDelete(area)}
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
              {searchTerm || statusFilter !== "all"
                ? "Không tìm thấy khu vực nào"
                : "Chưa có khu vực nào. Nhấn 'Tạo khu vực' để bắt đầu."}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Dialogs */}
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
  );
}
