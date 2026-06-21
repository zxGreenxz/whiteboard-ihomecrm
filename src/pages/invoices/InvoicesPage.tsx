import { useState, useMemo, useCallback, useEffect, useRef, lazy, Suspense } from 'react';
import MainLayout from '@/components/layout/MainLayout';
import { usePagination, calculatePaginationInfo } from '@/hooks/usePagination';
import { DataTablePagination } from '@/components/ui/data-table-pagination';
import { Receipt } from 'lucide-react';
import EmptyState from '@/components/ui/EmptyState';
import { usePhoneViewport } from '@/hooks/use-mobile';

const InvoicesMobilePage = lazy(() => import('./InvoicesMobilePage'));
import {
  useInvoices,
  useDeleteInvoice,
  useBulkDeleteInvoices,
  useCheckOverdueInvoices,
  useRestoreInvoice,
  useForceCancelInvoice,
} from '@/hooks/useInvoices';
import { useMyContext } from '@/hooks/useMyContext';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import { getInvoiceTitle } from '@/lib/invoiceUtils';
import type { InvoiceWithRelations, InvoiceFilters } from '@/types/invoice';

import InvoiceStatsSummary, { type StatMethodKey } from '@/components/invoices/InvoiceStatsSummary';
import InvoiceListFilters from '@/components/invoices/InvoiceListFilters';
import InvoiceListToolbar from '@/components/invoices/InvoiceListToolbar';
import InvoiceListTable from '@/components/invoices/InvoiceListTable';
import { useInvoiceColumnVisibility } from '@/components/invoices/invoiceListColumns';
import GenerateInvoiceDialog from '@/components/invoices/GenerateInvoiceDialog';
import RecordPaymentDialog from '@/components/invoices/RecordPaymentDialog';
import RecordRefundDialog from '@/components/invoices/RecordRefundDialog';
import EditInvoiceDialog from '@/components/invoices/EditInvoiceDialog';
import ExcelInvoiceDialog from '@/components/invoices/ExcelInvoiceDialog';
import BulkRecordPaymentDialog from '@/components/invoices/BulkRecordPaymentDialog';
import PaymentsSummaryDialog from '@/components/invoices/PaymentsSummaryDialog';
import InvoiceHistoryDialog from '@/components/invoices/InvoiceHistoryDialog';
import SuperAdminForceDeleteDialog from '@/components/invoices/SuperAdminForceDeleteDialog';
import InvoiceDetailModal from '@/components/invoices/InvoiceDetailModal';

const InvoicesDesktopPage = () => {
  // Filters
  const [filters, setFilters] = useState<InvoiceFilters>({});

  // ctx chỉ còn dùng cho isSuper (restore/force-cancel). Cơ chế khoá staff vào
  // khu vực theo quy ước ngầm username = area.name (lockedAreaId) đã GỠ:
  // scope dữ liệu của staff vốn do RLS per-building quyết định; BuildingMultiSelect
  // (nguồn useBuildings đã bị RLS cắt) tự nhiên chỉ hiện toà staff được quản.
  const { data: ctx } = useMyContext();
  const { data: perms } = useMyPermissions();
  const canCreate = canUse(perms, 'invoices', 'create');
  const canEdit = canUse(perms, 'invoices', 'edit');
  const canDelete = canUse(perms, 'invoices', 'delete');
  const canRecordPayment = canUse(perms, 'invoices', 'record_payment');

  // Search
  const [searchQuery, setSearchQuery] = useState('');

  // Pagination
  const { page, pageSize, setPage, setPageSize } = usePagination(20);

  // Selection
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // Column visibility (persisted in localStorage)
  const { visibility: columnVisibility, toggle: toggleColumn, reset: resetColumns } =
    useInvoiceColumnVisibility();

  // Dialog states
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [excelModeDialogOpen, setExcelModeDialogOpen] = useState(false);
  const [bulkPayDialogOpen, setBulkPayDialogOpen] = useState(false);
  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [paymentsSummaryOpen, setPaymentsSummaryOpen] = useState(false);
  const [historyDialogOpen, setHistoryDialogOpen] = useState(false);
  const [selectedInvoice, setSelectedInvoice] = useState<InvoiceWithRelations | null>(null);
  const [forceDeleteTarget, setForceDeleteTarget] = useState<InvoiceWithRelations | null>(null);

  // Modal xem chi tiết — mở ngay tại trang để KHÔNG mất bộ lọc đang dò.
  const [detailModalOpen, setDetailModalOpen] = useState(false);
  const [detailInvoice, setDetailInvoice] = useState<InvoiceWithRelations | null>(null);

  // Merge search into filters
  const effectiveFilters = useMemo(
    () => ({ ...filters, search: searchQuery || undefined }),
    [filters, searchQuery],
  );

  // Data fetching
  const { data: invoicesData, isLoading } = useInvoices(effectiveFilters, { page, pageSize });
  const invoices = invoicesData?.data ?? [];
  const totalCount = invoicesData?.count ?? 0;

  // Mutations
  const deleteMutation = useDeleteInvoice();
  const bulkDeleteMutation = useBulkDeleteInvoices();
  const restoreMutation = useRestoreInvoice();
  const forceCancelMutation = useForceCancelInvoice();

  // Check and update overdue invoices on mount
  const checkOverdueMutation = useCheckOverdueInvoices();
  const overdueCheckedRef = useRef(false);
  useEffect(() => {
    if (!overdueCheckedRef.current) {
      overdueCheckedRef.current = true;
      checkOverdueMutation.mutate();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Pagination info
  const paginationInfo = useMemo(
    () => calculatePaginationInfo(page, pageSize, totalCount),
    [page, pageSize, totalCount],
  );

  // Statistics filters (derived from invoice filters) — phải truyền đủ
  // để stats cập nhật cùng với bảng khi user đổi bộ lọc.
  const statsFilters = useMemo(
    () => ({
      building_id: filters.building_id,
      building_ids: filters.building_ids,
      room_id:
        filters.room_ids?.length === 1
          ? filters.room_ids[0]
          : filters.room_ids?.length
            ? undefined
            : filters.room_id,      status: filters.status,
      start_date: filters.date_range?.start,
      end_date: filters.date_range?.end,
      billing_month: filters.billing_month,
      payment_status: filters.payment_status,
    }),
    [filters],
  );

  // Handlers
  const handleFiltersChange = useCallback(
    (newFilters: InvoiceFilters) => {
      setFilters(newFilters);
      setPage(1);
      setSelectedIds([]);
    },
    [setPage],
  );

  const handleSearch = useCallback(
    (query: string) => {
      setSearchQuery(query);
      setPage(1);
    },
    [setPage],
  );

  // Bấm thẻ phương thức (TM/TK/TT/Cấn trừ) → lọc bảng theo method; bấm lại = bỏ lọc.
  const handleMethodCardClick = useCallback(
    (method: StatMethodKey) => {
      setFilters((prev) => ({
        ...prev,
        payment_method: prev.payment_method === method ? undefined : method,
      }));
      setPage(1);
      setSelectedIds([]);
    },
    [setPage],
  );

  const handleToggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }, []);

  const handleToggleSelectAll = useCallback(() => {
    const selectableIds = invoices
      .filter((inv) => (inv.paid_amount ?? 0) === 0)
      .map((inv) => inv.id);
    setSelectedIds((prev) => (prev.length === selectableIds.length ? [] : selectableIds));
  }, [invoices]);

  const handleEdit = useCallback((invoice: InvoiceWithRelations) => {
    setSelectedInvoice(invoice);
    setEditDialogOpen(true);
  }, []);

  const handleDelete = useCallback(
    (invoice: InvoiceWithRelations) => {
      if (confirm('Bạn có chắc chắn muốn xoá hoá đơn này?')) {
        deleteMutation.mutate(invoice.id);
      }
    },
    [deleteMutation],
  );

  const handleRecordPayment = useCallback((invoice: InvoiceWithRelations) => {
    setSelectedInvoice(invoice);
    setPaymentDialogOpen(true);
  }, []);

  const handleViewDetail = useCallback((invoice: InvoiceWithRelations) => {
    setDetailInvoice(invoice);
    setDetailModalOpen(true);
  }, []);


  const handleViewHistory = useCallback(
    (invoice: InvoiceWithRelations) => {
      setSelectedInvoice(invoice);
      setHistoryDialogOpen(true);
    },
    [],
  );

  const handleViewPayments = useCallback(
    (invoice: InvoiceWithRelations) => {
      setSelectedInvoice(invoice);
      setPaymentsSummaryOpen(true);
    },
    [],
  );

  const handleRestore = useCallback(
    (invoice: InvoiceWithRelations) => {
      if (confirm(`Phục hồi hoá đơn ${invoice.invoice_number} về trạng thái Đã duyệt?`)) {
        restoreMutation.mutate(invoice.id);
      }
    },
    [restoreMutation],
  );

  const handleForceCancel = useCallback((invoice: InvoiceWithRelations) => {
    setForceDeleteTarget(invoice);
  }, []);

  const handleConfirmForceCancel = useCallback(() => {
    if (!forceDeleteTarget) return;
    forceCancelMutation.mutate(forceDeleteTarget.id, {
      onSuccess: () => setForceDeleteTarget(null),
    });
  }, [forceDeleteTarget, forceCancelMutation]);

  const handleBulkDelete = useCallback(() => {
    if (selectedIds.length === 0) return;
    if (confirm(`Bạn có chắc chắn muốn xoá ${selectedIds.length} hoá đơn đã chọn?`)) {
      bulkDeleteMutation.mutate(selectedIds, {
        onSuccess: () => setSelectedIds([]),
      });
    }
  }, [selectedIds, bulkDeleteMutation]);

  return (
    <MainLayout
      title="Quản lý Hoá đơn"
      subtitle="Quản lý hoá đơn và thanh toán"
      icon={Receipt}
    >
      <>
          {/* Statistics — bấm thẻ phương thức để lọc bảng theo TM/TK/TT/Cấn trừ */}
          <InvoiceStatsSummary
            filters={statsFilters}
            activeMethod={filters.payment_method ?? null}
            onMethodClick={handleMethodCardClick}
          />

          {/* Filters */}
          <InvoiceListFilters filters={filters} onFiltersChange={handleFiltersChange} />

          {/* Toolbar */}
          <InvoiceListToolbar
            selectedCount={selectedIds.length}
            searchQuery={searchQuery}
            onSearch={handleSearch}
            onAdd={() => setCreateDialogOpen(true)}
            onExcelMode={() => setExcelModeDialogOpen(true)}
            onBulkRecordPayment={() => setBulkPayDialogOpen(true)}
            onBulkDelete={handleBulkDelete}
            columnVisibility={columnVisibility}
            onToggleColumn={toggleColumn}
            onResetColumns={resetColumns}
            canCreate={canCreate}
            canRecordPayment={canRecordPayment}
            canDelete={canDelete}
          />

          {/* Table */}
          <div className="bg-white rounded-lg border">
            {isLoading ? (
              <div className="p-8 text-center text-muted-foreground">Đang tải dữ liệu...</div>
            ) : invoices.length === 0 ? (
              <EmptyState
                icon={Receipt}
                title="Chưa có hoá đơn nào"
                description="Hãy tạo hoá đơn đầu tiên để bắt đầu quản lý"
              />
            ) : (
              <>
                <InvoiceListTable
                  invoices={invoices}
                  selectedIds={selectedIds}
                  onToggleSelect={handleToggleSelect}
                  onToggleSelectAll={handleToggleSelectAll}
                  onEdit={handleEdit}
                  onDelete={handleDelete}
                  onRecordPayment={handleRecordPayment}
                  onViewDetail={handleViewDetail}
                  onViewPayments={handleViewPayments}
                  onViewHistory={handleViewHistory}
                  onRestore={ctx?.isSuper ? handleRestore : undefined}
                  onForceCancel={ctx?.isSuper ? handleForceCancel : undefined}
                  isSuper={!!ctx?.isSuper}
                  columnVisibility={columnVisibility}
                  canEdit={canEdit}
                  canDelete={canDelete}
                  canRecordPayment={canRecordPayment}
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
        </>

      {/* Dialogs */}
      <GenerateInvoiceDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
      />

      {selectedInvoice && (() => {
        const total = selectedInvoice.total_amount || 0;
        const paid = selectedInvoice.paid_amount || 0;
        const isRefund = total < 0 || paid > total;
        return isRefund ? (
          <RecordRefundDialog
            open={paymentDialogOpen}
            onOpenChange={setPaymentDialogOpen}
            invoice={selectedInvoice}
          />
        ) : (
          <RecordPaymentDialog
            open={paymentDialogOpen}
            onOpenChange={setPaymentDialogOpen}
            invoice={selectedInvoice}
          />
        );
      })()}

      {selectedInvoice && (
        <EditInvoiceDialog
          open={editDialogOpen}
          onOpenChange={setEditDialogOpen}
          invoice={selectedInvoice}
        />
      )}

      <ExcelInvoiceDialog
        open={excelModeDialogOpen}
        onOpenChange={setExcelModeDialogOpen}
      />

      <BulkRecordPaymentDialog
        open={bulkPayDialogOpen}
        onOpenChange={setBulkPayDialogOpen}
      />

      <PaymentsSummaryDialog
        open={paymentsSummaryOpen}
        onOpenChange={setPaymentsSummaryOpen}
        invoice={selectedInvoice}
      />

      <InvoiceHistoryDialog
        open={historyDialogOpen}
        onOpenChange={setHistoryDialogOpen}
        invoice={selectedInvoice}
      />

      <SuperAdminForceDeleteDialog
        open={!!forceDeleteTarget}
        onOpenChange={(open) => {
          if (!open) setForceDeleteTarget(null);
        }}
        invoice={forceDeleteTarget}
        onConfirm={handleConfirmForceCancel}
        isPending={forceCancelMutation.isPending}
      />

      {/* Xem chi tiết hoá đơn — modal full-screen (giữ nguyên bộ lọc danh sách) */}
      <InvoiceDetailModal
        invoiceId={detailInvoice?.id ?? null}
        title={detailInvoice ? getInvoiceTitle(detailInvoice) : ''}
        open={detailModalOpen}
        onOpenChange={setDetailModalOpen}
      />
    </MainLayout>
  );
};

// Mobile (≤767px): trang app full-screen riêng (warm-neutral).
export default function InvoicesPage() {
  const isPhone = usePhoneViewport();
  if (isPhone) {
    return (
      <Suspense fallback={null}>
        <InvoicesMobilePage />
      </Suspense>
    );
  }
  return <InvoicesDesktopPage />;
}
