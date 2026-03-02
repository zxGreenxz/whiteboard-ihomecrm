import { useState, useCallback } from "react";
import MainLayout from "@/components/layout/MainLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { Plus, Upload, Search, Receipt } from "lucide-react";
import { IncomeExpenseStats } from "@/components/income-expenses/IncomeExpenseStats";
import { IncomeExpenseFiltersBar } from "@/components/income-expenses/IncomeExpenseFilters";
import IncomeExpenseList from "@/components/income-expenses/IncomeExpenseList";
import IncomeExpenseForm from "@/components/income-expenses/IncomeExpenseForm";
import IncomeExpenseImportDialog from "@/components/income-expenses/IncomeExpenseImportDialog";
import {
  useIncomeExpenses,
  useIncomeExpenseStats,
  useDeleteIncomeExpense,
  useApproveIncomeExpense,
  useUnapproveIncomeExpense,
  type IncomeExpenseWithRelations,
} from "@/hooks/useIncomeExpenses";
import type { IncomeExpenseFilters } from "@/hooks/useIncomeExpenses";
import { usePagination } from "@/hooks/usePagination";

const EMPTY_FILTERS: IncomeExpenseFilters = {
  area_id: null,
  building_id: null,
  room_id: null,
  bed_id: null,
  account_id: null,
  cash_book_id: null,
  type: null,
  start_date: null,
  end_date: null,
  approval_status: null,
};

const IncomeExpensePage = () => {
  // --- State ---
  const [filters, setFilters] = useState<IncomeExpenseFilters>(EMPTY_FILTERS);
  const [searchQuery, setSearchQuery] = useState("");
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [editingVoucher, setEditingVoucher] =
    useState<IncomeExpenseWithRelations | null>(null);
  const [formType, setFormType] = useState<"INCOME" | "EXPENSE">("INCOME");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  // --- Pagination ---
  const pagination = usePagination(20);

  // --- Data hooks ---
  const { data: listResult, isLoading } = useIncomeExpenses(
    filters,
    { page: pagination.page, pageSize: pagination.pageSize },
    searchQuery || undefined
  );

  const vouchers = listResult?.data ?? [];
  const totalCount = listResult?.totalCount ?? 0;

  const { data: stats, isLoading: isStatsLoading } =
    useIncomeExpenseStats(filters);

  // --- Mutation hooks ---
  const deleteMutation = useDeleteIncomeExpense();
  const approveMutation = useApproveIncomeExpense();
  const unapproveMutation = useUnapproveIncomeExpense();

  // --- Handlers ---
  const handleFiltersChange = useCallback(
    (newFilters: IncomeExpenseFilters) => {
      setFilters(newFilters);
      pagination.setPage(1);
    },
    [pagination]
  );

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearchQuery(e.target.value);
      pagination.setPage(1);
    },
    [pagination]
  );

  const handleAddVoucher = useCallback(() => {
    setEditingVoucher(null);
    setFormType("INCOME");
    setIsFormOpen(true);
  }, []);

  const handleEdit = useCallback((voucher: IncomeExpenseWithRelations) => {
    setEditingVoucher(voucher);
    setFormType(voucher.type);
    setIsFormOpen(true);
  }, []);

  const handleFormClose = useCallback((open: boolean) => {
    setIsFormOpen(open);
    if (!open) setEditingVoucher(null);
  }, []);

  const handleDelete = useCallback((id: string) => {
    setDeleteTarget(id);
  }, []);

  const confirmDelete = useCallback(() => {
    if (deleteTarget) {
      deleteMutation.mutate(deleteTarget);
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

  return (
    <MainLayout title="Thu chi" subtitle="Tài chính → Thu chi" icon={Receipt}>
      <div className="space-y-4">
        {/* Toolbar: Action buttons + Search */}
        <div className="flex items-center gap-2">
          <Button onClick={handleAddVoucher}>
            <Plus className="h-4 w-4 mr-2" />
            Thêm phiếu
          </Button>
          <Button variant="outline" onClick={() => setIsImportOpen(true)}>
            <Upload className="h-4 w-4 mr-2" />
            Import
          </Button>
          <div className="relative flex-1 max-w-sm ml-auto">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Tìm theo tên phiếu, khách hàng, mã phiếu..."
              value={searchQuery}
              onChange={handleSearchChange}
              className="pl-9"
            />
          </div>
        </div>

        {/* Inline Filters */}
        <IncomeExpenseFiltersBar
          filters={filters}
          onChange={handleFiltersChange}
        />

        {/* Stats */}
        <IncomeExpenseStats
          stats={
            stats ?? {
              totalIncome: 0,
              totalExpense: 0,
              difference: 0,
            }
          }
          isLoading={isStatsLoading}
        />

        {/* List */}
        <IncomeExpenseList
          vouchers={vouchers}
          isLoading={isLoading}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onApprove={handleApprove}
          onUnapprove={handleUnapprove}
          pagination={pagination}
          totalCount={totalCount}
        />
      </div>

      {/* Form Dialog */}
      <IncomeExpenseForm
        open={isFormOpen}
        onOpenChange={handleFormClose}
        voucher={editingVoucher}
        defaultType={formType}
      />

      {/* Import Dialog */}
      <IncomeExpenseImportDialog
        open={isImportOpen}
        onOpenChange={setIsImportOpen}
      />

      {/* Delete Confirmation */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={() => setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận xoá</AlertDialogTitle>
            <AlertDialogDescription>
              Bạn có chắc chắn muốn xoá phiếu thu/chi này không? Hành động này
              không thể hoàn tác.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-red-600 hover:bg-red-700"
            >
              Xoá
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </MainLayout>
  );
};

export default IncomeExpensePage;
