import { useState, useMemo, useCallback } from 'react';
import { Search, Car } from 'lucide-react';
import MainLayout from '@/components/layout/MainLayout';
import { Input } from '@/components/ui/input';
import { usePagination, calculatePaginationInfo } from '@/hooks/usePagination';
import { DataTablePagination } from '@/components/ui/data-table-pagination';
import EmptyState from '@/components/ui/EmptyState';
import { useVehicles } from '@/hooks/useVehicles';
import VehicleListToolbar, { type ViewMode } from '@/components/vehicles/VehicleListToolbar';
import VehicleListTable from '@/components/vehicles/VehicleListTable';
import VehicleFormDialog from '@/components/vehicles/VehicleFormDialog';
import DeleteVehicleDialog from '@/components/vehicles/DeleteVehicleDialog';

import type { VehicleWithRelations, VehicleFilters } from '@/types/vehicle';

export default function VehiclesPage() {
  // State
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [formDialogOpen, setFormDialogOpen] = useState(false);
  const [selectedVehicle, setSelectedVehicle] = useState<VehicleWithRelations | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [vehicleToDelete, setVehicleToDelete] = useState<VehicleWithRelations | null>(null);

  // Pagination
  const { page, pageSize, setPage, setPageSize } = usePagination(20);

  // Build filters
  const filters = useMemo<VehicleFilters>(
    () => ({ search: searchQuery || undefined }),
    [searchQuery]
  );

  // Data fetching
  const { data: vehiclesData, isLoading } = useVehicles(filters, { page, pageSize });
  const vehicles = vehiclesData?.data ?? [];
  const totalCount = vehiclesData?.count ?? 0;

  // Pagination info
  const paginationInfo = useMemo(
    () => calculatePaginationInfo(page, pageSize, totalCount),
    [page, pageSize, totalCount]
  );

  // Handlers
  const handleSearch = useCallback(
    (query: string) => {
      setSearchQuery(query);
      setPage(1);
    },
    [setPage]
  );

  const handleAdd = useCallback(() => {
    setSelectedVehicle(null);
    setFormDialogOpen(true);
  }, []);

  const handleEdit = useCallback((vehicle: VehicleWithRelations) => {
    setSelectedVehicle(vehicle);
    setFormDialogOpen(true);
  }, []);

  const handleDelete = useCallback((vehicle: VehicleWithRelations) => {
    setVehicleToDelete(vehicle);
    setDeleteDialogOpen(true);
  }, []);

  const handleExport = useCallback(() => {
    console.log('Export vehicles');
  }, []);

  const handleImport = useCallback(() => {
    console.log('Import vehicles');
  }, []);

  const handlePrint = useCallback(() => {
    window.print();
  }, []);

  return (
    <MainLayout title="Quản lý Phương tiện" subtitle="Khách hàng > Phương tiện" icon={Car}>
      <div className="space-y-4">
        {/* Search + Toolbar */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="relative w-full sm:w-72">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Tìm kiếm phương tiện..."
              value={searchQuery}
              onChange={(e) => handleSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <VehicleListToolbar
            onAdd={handleAdd}
            onExport={handleExport}
            onImport={handleImport}
            onPrint={handlePrint}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
          />
        </div>

        {/* Table */}
        <div className="bg-white rounded-lg border">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground">Đang tải dữ liệu...</div>
          ) : vehicles.length === 0 ? (
            <EmptyState
              icon={Car}
              title="Chưa có phương tiện nào"
              description="Hãy thêm phương tiện đầu tiên để bắt đầu quản lý"
              actionLabel="Thêm phương tiện"
              onAction={handleAdd}
            />
          ) : (
            <>
              <VehicleListTable
                vehicles={vehicles}
                onEdit={handleEdit}
                onDelete={handleDelete}
                isLoading={isLoading}
              />
              <DataTablePagination
                paginationInfo={paginationInfo}
                onPageChange={setPage}
                onPageSizeChange={setPageSize}
                showPageSizeSelector
                showItemCount
              />
            </>
          )}
        </div>

        {/* Form Dialog (Add/Edit) */}
        <VehicleFormDialog
          open={formDialogOpen}
          onOpenChange={setFormDialogOpen}
          vehicle={selectedVehicle || undefined}
        />

        {/* Delete Confirmation Dialog */}
        {vehicleToDelete && (
          <DeleteVehicleDialog
            open={deleteDialogOpen}
            onOpenChange={setDeleteDialogOpen}
            vehicleId={vehicleToDelete.id}
            vehicleName={
              vehicleToDelete.vehicle_name
                ? `${vehicleToDelete.vehicle_name} (${vehicleToDelete.license_plate || ''})`
                : vehicleToDelete.license_plate || vehicleToDelete.id.slice(0, 8)
            }
          />
        )}
      </div>
    </MainLayout>
  );
}
