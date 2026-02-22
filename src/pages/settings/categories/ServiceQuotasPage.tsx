import { useState, useMemo } from "react";
import MainLayout from "@/components/layout/MainLayout";
import {
  useServiceQuotas,
  type ServiceQuotaWithTiers,
} from "@/hooks/useServices";
import { Button } from "@/components/ui/button";
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Plus,
  RefreshCw,
  Pencil,
  Trash2,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { CreateQuotaDialog } from "@/components/service-quotas/CreateQuotaDialog";
import { EditQuotaDialog } from "@/components/service-quotas/EditQuotaDialog";
import { DeleteQuotaDialog } from "@/components/service-quotas/DeleteQuotaDialog";
import { useQueryClient } from "@tanstack/react-query";

export default function ServiceQuotasPage() {
  const queryClient = useQueryClient();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedQuota, setSelectedQuota] =
    useState<ServiceQuotaWithTiers | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [pageSize, setPageSize] = useState(10);
  const [currentPage, setCurrentPage] = useState(1);

  const { data: quotas, isLoading } = useServiceQuotas();

  const totalCount = quotas?.length || 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const startIndex = (currentPage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalCount);
  const paginatedQuotas = useMemo(
    () => (quotas || []).slice(startIndex, endIndex),
    [quotas, startIndex, endIndex]
  );

  const handleEdit = (quota: ServiceQuotaWithTiers) => {
    setSelectedQuota(quota);
    setEditDialogOpen(true);
  };

  const handleDelete = (quota: ServiceQuotaWithTiers) => {
    setSelectedQuota(quota);
    setDeleteDialogOpen(true);
  };

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ["service_quotas"] });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === paginatedQuotas.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(paginatedQuotas.map((q) => q.id)));
    }
  };

  const toggleSelect = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  return (
    <MainLayout>
      <div className="space-y-4">
        {/* Breadcrumb */}
        <div className="text-sm text-muted-foreground">
          Cài đặt hệ thống &gt; Danh mục khác &gt; Tài chính &gt;{" "}
          <span className="text-foreground font-medium">
            Định mức dịch vụ
          </span>
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => setCreateDialogOpen(true)}>
            <Plus className="h-4 w-4 mr-1" />
            Thêm
          </Button>
          <Button size="sm" variant="outline" onClick={handleRefresh}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>

        {/* Table */}
        {isLoading ? (
          <div className="text-center py-8 text-muted-foreground">
            Đang tải...
          </div>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={
                        paginatedQuotas.length > 0 &&
                        selectedIds.size === paginatedQuotas.length
                      }
                      onCheckedChange={toggleSelectAll}
                    />
                  </TableHead>
                  <TableHead>Tên định mức</TableHead>
                  <TableHead className="text-center">Số bậc</TableHead>
                  <TableHead>Mô tả</TableHead>
                  <TableHead>Thao tác</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginatedQuotas.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="text-center py-8 text-muted-foreground"
                    >
                      Không có dữ liệu
                    </TableCell>
                  </TableRow>
                ) : (
                  paginatedQuotas.map((quota) => (
                    <TableRow key={quota.id}>
                      <TableCell>
                        <Checkbox
                          checked={selectedIds.has(quota.id)}
                          onCheckedChange={() => toggleSelect(quota.id)}
                        />
                      </TableCell>
                      <TableCell className="font-medium">
                        {quota.name}
                      </TableCell>
                      <TableCell className="text-center">
                        {quota.service_quota_tiers?.length || 0}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {quota.description || "-"}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-green-600 hover:text-green-700"
                            onClick={() => handleEdit(quota)}
                            title="Cập nhật"
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-red-600 hover:text-red-700"
                            onClick={() => handleDelete(quota)}
                            title="Xóa"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Pagination */}
        <div className="flex items-center justify-between text-sm">
          <div className="flex items-center gap-2">
            <span>Số bản ghi:</span>
            <Select
              value={String(pageSize)}
              onValueChange={(v) => {
                setPageSize(Number(v));
                setCurrentPage(1);
              }}
            >
              <SelectTrigger className="w-[70px] h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="10">10</SelectItem>
                <SelectItem value="25">25</SelectItem>
                <SelectItem value="50">50</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">
              {totalCount > 0
                ? `${startIndex + 1}-${endIndex} trên tổng số ${totalCount} bản ghi`
                : "0 bản ghi"}
            </span>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              disabled={currentPage <= 1}
              onClick={() => setCurrentPage((p) => p - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              disabled={currentPage >= totalPages}
              onClick={() => setCurrentPage((p) => p + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Dialogs */}
        <CreateQuotaDialog
          open={createDialogOpen}
          onOpenChange={setCreateDialogOpen}
        />
        {selectedQuota && (
          <>
            <EditQuotaDialog
              open={editDialogOpen}
              onOpenChange={setEditDialogOpen}
              quota={selectedQuota}
            />
            <DeleteQuotaDialog
              open={deleteDialogOpen}
              onOpenChange={setDeleteDialogOpen}
              quota={selectedQuota}
            />
          </>
        )}
      </div>
    </MainLayout>
  );
}
