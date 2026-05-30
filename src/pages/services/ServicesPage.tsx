import { useState, useMemo } from "react";
import MainLayout from "@/components/layout/MainLayout";
import {
  useServices,
  FEE_TYPE_LABELS,
  PRICING_TYPE_LABELS,
  type ServiceWithBuildings,
} from "@/hooks/useServices";
import { useBuildings } from "@/hooks/useBuildings";
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
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Plus, RefreshCw, Pencil, Trash2, ChevronLeft, ChevronRight } from "lucide-react";
import { CreateServiceDialog } from "@/components/services/CreateServiceDialog";
import { EditServiceDialog } from "@/components/services/EditServiceDialog";
import { DeleteServiceDialog } from "@/components/services/DeleteServiceDialog";
import { useQueryClient } from "@tanstack/react-query";

export default function ServicesPage() {
  const queryClient = useQueryClient();
  const [buildingFilter, setBuildingFilter] = useState<string>("");
  const [feeTypeFilter, setFeeTypeFilter] = useState<string>("");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedService, setSelectedService] = useState<ServiceWithBuildings | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [pageSize, setPageSize] = useState(10);
  const [currentPage, setCurrentPage] = useState(1);

  const { data: services, isLoading } = useServices({
    building_id: buildingFilter || undefined,
    fee_type: feeTypeFilter || undefined,
  });
  const { data: buildings } = useBuildings();

  const totalCount = services?.length || 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const startIndex = (currentPage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalCount);
  const paginatedServices = useMemo(
    () => (services || []).slice(startIndex, endIndex),
    [services, startIndex, endIndex]
  );

  const handleEdit = (service: ServiceWithBuildings) => {
    setSelectedService(service);
    setEditDialogOpen(true);
  };

  const handleDelete = (service: ServiceWithBuildings) => {
    setSelectedService(service);
    setDeleteDialogOpen(true);
  };

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ["services"] });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === paginatedServices.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(paginatedServices.map((s) => s.id)));
    }
  };

  const toggleSelect = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  const formatPrice = (amount: number, unit?: string | null) => {
    const formatted = new Intl.NumberFormat("vi-VN").format(amount);
    return unit ? `${formatted}/${unit}` : formatted;
  };

  return (
    <MainLayout>
      <div className="space-y-4">
        {/* Breadcrumb */}
        <div className="text-sm text-muted-foreground">
          Danh mục dữ liệu &gt; <span className="text-foreground font-medium">Dịch vụ</span>
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

        {/* Filters */}
        <div className="flex items-center gap-3">
          <SearchableSelect
            value={buildingFilter}
            onValueChange={(v) => { setBuildingFilter(v === "ALL" ? "" : v); setCurrentPage(1); }}
            className="w-[200px]"
            placeholder="Chọn tòa nhà"
            options={[
              { value: 'ALL', label: 'Tất cả tòa nhà' },
              ...(buildings || []).map((b) => ({ value: b.id, label: b.name })),
            ]}
          />

          <SearchableSelect
            value={feeTypeFilter}
            onValueChange={(v) => { setFeeTypeFilter(v === "ALL" ? "" : v); setCurrentPage(1); }}
            className="w-[200px]"
            placeholder="Loại dịch vụ"
            options={[
              { value: 'ALL', label: 'Tất cả loại' },
              ...Object.entries(FEE_TYPE_LABELS).map(([key, label]) => ({ value: key, label })),
            ]}
          />
        </div>

        {/* Table */}
        {isLoading ? (
          <div className="text-center py-8 text-muted-foreground">Đang tải...</div>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={paginatedServices.length > 0 && selectedIds.size === paginatedServices.length}
                      onCheckedChange={toggleSelectAll}
                    />
                  </TableHead>
                  <TableHead>Mã</TableHead>
                  <TableHead>Thao tác</TableHead>
                  <TableHead>Tên dịch vụ</TableHead>
                  <TableHead>Loại dịch vụ</TableHead>
                  <TableHead>Loại tính tiền</TableHead>
                  <TableHead className="text-right">Giá dịch vụ</TableHead>
                  <TableHead className="text-center">Mặc định</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginatedServices.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                      Không có dữ liệu
                    </TableCell>
                  </TableRow>
                ) : (
                  paginatedServices.map((service) => (
                    <TableRow key={service.id}>
                      <TableCell>
                        <Checkbox
                          checked={selectedIds.has(service.id)}
                          onCheckedChange={() => toggleSelect(service.id)}
                        />
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {service.code || "-"}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-green-600 hover:text-green-700"
                            onClick={() => handleEdit(service)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-red-600 hover:text-red-700"
                            onClick={() => handleDelete(service)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                      <TableCell className="font-medium">{service.name}</TableCell>
                      <TableCell>{service.fee_type ? FEE_TYPE_LABELS[service.fee_type] || service.fee_type : "-"}</TableCell>
                      <TableCell>{service.pricing_type ? PRICING_TYPE_LABELS[service.pricing_type] || service.pricing_type : "-"}</TableCell>
                      <TableCell className="text-right">
                        {formatPrice(service.unit_price, service.unit)}
                      </TableCell>
                      <TableCell className="text-center">
                        <Switch checked={service.is_default || false} disabled />
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
            <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(Number(v)); setCurrentPage(1); }}>
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
        <CreateServiceDialog
          open={createDialogOpen}
          onOpenChange={setCreateDialogOpen}
        />
        {selectedService && (
          <>
            <EditServiceDialog
              open={editDialogOpen}
              onOpenChange={setEditDialogOpen}
              service={selectedService}
            />
            <DeleteServiceDialog
              open={deleteDialogOpen}
              onOpenChange={setDeleteDialogOpen}
              service={selectedService}
            />
          </>
        )}
      </div>
    </MainLayout>
  );
}
