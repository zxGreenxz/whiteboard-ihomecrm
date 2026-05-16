import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import MainLayout from '@/components/layout/MainLayout';
import { usePagination, calculatePaginationInfo } from '@/hooks/usePagination';
import { DataTablePagination } from '@/components/ui/data-table-pagination';
import { Receipt } from 'lucide-react';
import EmptyState from '@/components/ui/EmptyState';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  useInvoices,
  useDeleteInvoice,
  useBulkDeleteInvoices,
  useCheckOverdueInvoices,
} from '@/hooks/useInvoices';
import type { InvoiceWithRelations, InvoiceFilters } from '@/types/invoice';

import InvoiceStatsSummary from '@/components/invoices/InvoiceStatsSummary';
import InvoiceListFilters from '@/components/invoices/InvoiceListFilters';
import InvoiceListToolbar from '@/components/invoices/InvoiceListToolbar';
import InvoiceListTable from '@/components/invoices/InvoiceListTable';
import InvoiceListMobile from '@/components/invoices/InvoiceListMobile';
import { useInvoiceColumnVisibility } from '@/components/invoices/invoiceListColumns';
import GenerateInvoiceDialog from '@/components/invoices/GenerateInvoiceDialog';
import RecordPaymentDialog from '@/components/invoices/RecordPaymentDialog';
import RecordRefundDialog from '@/components/invoices/RecordRefundDialog';
import EditInvoiceDialog from '@/components/invoices/EditInvoiceDialog';
import ExcelInvoiceDialog from '@/components/invoices/ExcelInvoiceDialog';
import BulkRecordPaymentDialog from '@/components/invoices/BulkRecordPaymentDialog';
import PaymentsSummaryDialog from '@/components/invoices/PaymentsSummaryDialog';
import InvoiceHistoryDialog from '@/components/invoices/InvoiceHistoryDialog';

const InvoicesPage = () => {
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  // Filters
  const [filters, setFilters] = useState<InvoiceFilters>({});

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
      area_id: filters.area_id,
      building_id: filters.building_id,
      room_id: filters.room_id,
      bed_id: filters.bed_id,
      status: filters.status,
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

  const handleViewDetail = useCallback(
    (invoice: InvoiceWithRelations) => {
      navigate(`/invoices/${invoice.id}`);
    },
    [navigate],
  );


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
      {isMobile ? (
        <div className="-mx-4 -my-4 sm:-mx-6 sm:-my-6 bg-zinc-50 min-h-[calc(100vh-120px)]">
          {/* Statistics */}
          <InvoiceStatsSummary filters={statsFilters} />

          {/* Filters — compact: chỉ Toà nhà · Phòng · Tháng */}
          <InvoiceListFilters filters={filters} onFiltersChange={handleFiltersChange} compact />

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
            compact
          />

          {/* Mobile list */}
          <InvoiceListMobile
            invoices={invoices}
            isLoading={isLoading}
            onViewDetail={handleViewDetail}
          />

          {!isLoading && invoices.length > 0 && (
            <div className="px-3 pb-6">
              <DataTablePagination
                paginationInfo={paginationInfo}
                onPageChange={setPage}
                onPageSizeChange={setPageSize}
                showPageSizeSelector
                showItemCount
              />
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Statistics */}
          <InvoiceStatsSummary filters={statsFilters} />

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
                  columnVisibility={columnVisibility}
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
      )}

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
    </MainLayout>
  );
};

export default InvoicesPage;
