import { useState, useCallback } from "react";
import MainLayout from "@/components/layout/MainLayout";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Gauge, Plus, FileSpreadsheet } from "lucide-react";
import { MeterReadingStats } from "@/components/meter-readings/MeterReadingStats";
import {
  MeterReadingFiltersBar,
  type MeterReadingFilters,
} from "@/components/meter-readings/MeterReadingFilters";
import MeterReadingList from "@/components/meter-readings/MeterReadingList";
import MeterReadingActions from "@/components/meter-readings/MeterReadingActions";
import MeterReadingForm from "@/components/meter-readings/MeterReadingForm";
import MeterReadingImportDialog from "@/components/meter-readings/MeterReadingImportDialog";
import {
  useMeterReadingsList,
  useApproveMeterReading,
  useUnapproveMeterReading,
  useDeleteMeterReading,
  type MeterReadingDetailed,
} from "@/hooks/useMeterReadings";
import { usePagination } from "@/hooks/usePagination";

const currentMonth = new Date().toISOString().slice(0, 7);

const MeterReadingsPage = () => {
  // --- Filters ---
  const [filters, setFilters] = useState<MeterReadingFilters>({
    building_id: null,
    room_id: null,
    meter_type: null,
    month: currentMonth,
    status: null,
  });

  // --- Selection ---
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // --- Dialogs ---
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [editingReading, setEditingReading] =
    useState<MeterReadingDetailed | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  // --- Pagination ---
  const pagination = usePagination(20);

  // --- Data hooks ---
  const { data: listResult, isLoading } = useMeterReadingsList(
    {
      building_id: filters.building_id ?? undefined,
      room_id: filters.room_id ?? undefined,
      meter_type: filters.meter_type ?? undefined,
      month: filters.month || undefined,
      status: filters.status ?? undefined,
    },
    { page: pagination.page, pageSize: pagination.pageSize }
  );

  const readings = listResult?.data ?? [];
  const totalCount = listResult?.totalCount ?? 0;

  // --- Mutation hooks ---
  const approveMutation = useApproveMeterReading();
  const unapproveMutation = useUnapproveMeterReading();
  const deleteMutation = useDeleteMeterReading();

  // --- Handlers ---
  const handleFiltersChange = useCallback(
    (newFilters: MeterReadingFilters) => {
      setFilters(newFilters);
      setSelectedIds([]);
      pagination.setPage(1);
    },
    [pagination]
  );

  const handleEdit = useCallback((reading: MeterReadingDetailed) => {
    setEditingReading(reading);
    setIsFormOpen(true);
  }, []);

  const handleFormClose = useCallback((open: boolean) => {
    setIsFormOpen(open);
    if (!open) setEditingReading(null);
  }, []);

  const handleDelete = useCallback((id: string) => {
    setDeleteTarget(id);
  }, []);

  const confirmDelete = useCallback(() => {
    if (deleteTarget) {
      deleteMutation.mutate(deleteTarget, {
        onSuccess: () => {
          setSelectedIds((prev) => prev.filter((id) => id !== deleteTarget));
        },
      });
    }
    setDeleteTarget(null);
  }, [deleteTarget, deleteMutation]);

  const handleApprove = useCallback(
    (id: string) => {
      approveMutation.mutate(id);
    },
    [approveMutation]
  );

  const handleUnapprove = useCallback(
    (id: string) => {
      unapproveMutation.mutate(id);
    },
    [unapproveMutation]
  );

  const handleClearSelection = useCallback(() => {
    setSelectedIds([]);
  }, []);

  return (
    <MainLayout title="Ghi chỉ số" subtitle="Tài chính → Ghi chỉ số" icon={Gauge}>
      <div className="space-y-4">
        {/* Header: Action buttons */}
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" onClick={() => setIsImportOpen(true)}>
            <FileSpreadsheet className="h-4 w-4 mr-2" />
            Import
          </Button>
          <Button onClick={() => setIsFormOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Thêm chỉ số
          </Button>
        </div>

        {/* Stats */}
        <MeterReadingStats
          buildingId={filters.building_id ?? undefined}
          month={filters.month}
        />

        {/* Filters */}
        <MeterReadingFiltersBar filters={filters} onChange={handleFiltersChange} />

        {/* Bulk Actions */}
        <MeterReadingActions
          selectedIds={selectedIds}
          onClearSelection={handleClearSelection}
        />

        {/* List */}
        <MeterReadingList
          readings={readings}
          isLoading={isLoading}
          selectedIds={selectedIds}
          onSelectionChange={setSelectedIds}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onApprove={handleApprove}
          onUnapprove={handleUnapprove}
          pagination={pagination}
          totalCount={totalCount}
        />
      </div>

      {/* Form Dialog */}
      <MeterReadingForm
        open={isFormOpen}
        onOpenChange={handleFormClose}
        reading={editingReading}
      />

      {/* Import Dialog */}
      <MeterReadingImportDialog
        open={isImportOpen}
        onOpenChange={setIsImportOpen}
      />

      {/* Single Delete Confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận xoá</AlertDialogTitle>
            <AlertDialogDescription>
              Bạn có chắc chắn muốn xoá chỉ số này không?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className="bg-red-600 hover:bg-red-700">
              Xoá
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </MainLayout>
  );
};

export default MeterReadingsPage;
