import { useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users } from 'lucide-react';
import MainLayout from '@/components/layout/MainLayout';
import { usePagination, calculatePaginationInfo } from '@/hooks/usePagination';
import { DataTablePagination } from '@/components/ui/data-table-pagination';
import EmptyState from '@/components/ui/EmptyState';
import { useCustomers, useCustomerStats, useCreateCustomer } from '@/hooks/useCustomers';
import type { Customer, CustomerStatus, StatFilterType, CustomerFilters } from '@/types/customer';
import type { ViewMode } from '@/components/customers/CustomerListToolbar';
import { exportCustomers, uploadIdImagesFromUrls, type CustomerImportRow } from '@/lib/customerExcelHelpers';
import { supabase } from '@/integrations/supabase/client';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';

import CustomerStatusTabs from '@/components/customers/CustomerStatusTabs';
import CustomerStatsCards from '@/components/customers/CustomerStatsCards';
import CustomerListFilters from '@/components/customers/CustomerListFilters';
import CustomerListToolbar from '@/components/customers/CustomerListToolbar';
import CustomerListTable from '@/components/customers/CustomerListTable';
import CustomerDetailModal from '@/components/customers/CustomerDetailModal';
import DeleteCustomerDialog from '@/components/customers/DeleteCustomerDialog';
import { CustomerImportExportDialog } from '@/components/customers/CustomerImportExportDialog';

export default function CustomersPage() {
  const navigate = useNavigate();

  // State
  const [activeTab, setActiveTab] = useState<CustomerStatus>('RENTING');
  const [activeStatFilter, setActiveStatFilter] = useState<StatFilterType>('ALL');
  const [filters, setFilters] = useState<CustomerFilters>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [detailModalOpen, setDetailModalOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [customerToDelete, setCustomerToDelete] = useState<Customer | null>(null);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importResultOpen, setImportResultOpen] = useState(false);
  const [importResult, setImportResult] = useState<{
    successRows: { name: string }[];
    failRows: { name: string; reason: string }[];
  } | null>(null);

  // Pagination
  const { page, pageSize, setPage, setPageSize } = usePagination(20);

  // Build effective filters
  const effectiveFilters = useMemo<CustomerFilters>(
    () => ({
      ...filters,
      status: activeTab,
      statFilter: activeStatFilter,
      search: searchQuery || undefined,
    }),
    [filters, activeTab, activeStatFilter, searchQuery]
  );

  // Stats filters (same as effective but without statFilter to get all counts)
  const statsFilters = useMemo<CustomerFilters>(
    () => ({
      ...filters,
      status: activeTab,
      search: searchQuery || undefined,
    }),
    [filters, activeTab, searchQuery]
  );

  // Data fetching
  const { data: customersData, isLoading } = useCustomers(effectiveFilters, { page, pageSize });
  const { data: stats } = useCustomerStats(statsFilters);
  const createCustomer = useCreateCustomer();

  const customers = customersData?.data ?? [];
  const totalCount = customersData?.count ?? 0;
  const customerStats = stats ?? { total: 0, individual: 0, organization: 0, foreign: 0 };

  // Pagination info
  const paginationInfo = useMemo(
    () => calculatePaginationInfo(page, pageSize, totalCount),
    [page, pageSize, totalCount]
  );

  // Handlers
  const handleTabChange = useCallback(
    (tab: CustomerStatus) => {
      setActiveTab(tab);
      setActiveStatFilter('ALL');
      setPage(1);
    },
    [setPage]
  );

  const handleStatFilterChange = useCallback(
    (filter: StatFilterType) => {
      setActiveStatFilter(filter);
      setPage(1);
    },
    [setPage]
  );

  const handleFiltersChange = useCallback(
    (newFilters: CustomerFilters) => {
      setFilters(newFilters);
      setPage(1);
    },
    [setPage]
  );

  const handleSearch = useCallback(
    (query: string) => {
      setSearchQuery(query);
      setPage(1);
    },
    [setPage]
  );

  const handleAdd = useCallback(() => {
    navigate('/customers/new');
  }, [navigate]);

  const handleExport = useCallback(() => {
    exportCustomers(customers, effectiveFilters);
  }, [customers, effectiveFilters]);

  const handleImport = useCallback(() => {
    setImportDialogOpen(true);
  }, []);

  const handleImportConfirm = useCallback(async (rows: CustomerImportRow[]) => {
    const successRows: { name: string }[] = [];
    const failRows: { name: string; reason: string }[] = [];

    for (const row of rows) {
      try {
        const created = await createCustomer.mutateAsync({
          customer_type: 'INDIVIDUAL',
          full_name: row.full_name,
          phone: row.phone,
          email: row.email,
          date_of_birth: row.date_of_birth || undefined,
          gender: row.gender,
          id_number: row.id_number,
          id_issue_date: row.id_issue_date || undefined,
          id_issue_place: row.id_issue_place,
          permanent_address: row.permanent_address,
          occupation: row.occupation,
          contact_person: row.contact_person,
          contact_person_phone: row.contact_person_phone,
          is_foreign: !!(row.nationality && row.nationality.toLowerCase() !== 'việt nam' && row.nationality.toLowerCase() !== 'viet nam'),
        });

        // Download & upload ID card images from column L URLs
        if (row.id_image_urls && row.id_image_urls.length > 0 && created?.id) {
          try {
            const idImages = await uploadIdImagesFromUrls(created.id, row.id_image_urls);
            const sb = supabase as any;
            await sb.from('customers').update({ id_images: idImages }).eq('id', created.id);
          } catch {
            // Non-fatal: customer was created, images just didn't upload
          }
        }

        successRows.push({ name: row.full_name });
      } catch (err: any) {
        let reason = 'Lỗi không xác định';
        if (err?.code === '23505') reason = 'Trùng SĐT hoặc CCCD';
        else if (err?.code === '23514') reason = 'SĐT không đúng định dạng (DB constraint)';
        else if (err?.code === '22008') reason = 'Ngày tháng không hợp lệ';
        else if (err?.message) reason = err.message;
        failRows.push({ name: row.full_name, reason });
      }
    }

    setImportResult({ successRows, failRows });
    setImportResultOpen(true);
  }, [createCustomer]);

  const handlePrint = useCallback(() => {
    window.print();
  }, []);

  const handleView = useCallback((customer: Customer) => {
    setSelectedCustomer(customer);
    setDetailModalOpen(true);
  }, []);

  const handleEdit = useCallback(
    (customer: Customer) => {
      navigate(`/customers/${customer.id}/edit`);
    },
    [navigate]
  );

  const handleDelete = useCallback(
    (customer: Customer) => {
      setCustomerToDelete(customer);
      setDeleteDialogOpen(true);
    },
    []
  );

  return (
    <MainLayout title="Quản lý Khách hàng" subtitle="Quản lý thông tin khách hàng" icon={Users}>
      <div className="space-y-4">
        {/* Status Tabs */}
        <CustomerStatusTabs activeTab={activeTab} onTabChange={handleTabChange} />

        {/* Stats Cards */}
        <CustomerStatsCards
          stats={customerStats}
          activeFilter={activeStatFilter}
          onFilterChange={handleStatFilterChange}
        />

        {/* Location Filters */}
        <CustomerListFilters filters={filters} onFiltersChange={handleFiltersChange} />

        {/* Toolbar */}
        <CustomerListToolbar
          searchQuery={searchQuery}
          onSearchChange={handleSearch}
          onAdd={handleAdd}
          onExport={handleExport}
          onImport={handleImport}
          onPrint={handlePrint}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
        />

        {/* Table */}
        <div className="bg-white rounded-lg border">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground">Đang tải dữ liệu...</div>
          ) : customers.length === 0 ? (
            <EmptyState
              icon={Users}
              title="Chưa có khách hàng nào"
              description="Hãy thêm khách hàng đầu tiên để bắt đầu quản lý"
            />
          ) : (
            <>
              <CustomerListTable
                customers={customers}
                onView={handleView}
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

        {/* Customer Detail Modal */}
        {selectedCustomer && (
          <CustomerDetailModal
            open={detailModalOpen}
            onOpenChange={setDetailModalOpen}
            customerId={selectedCustomer.id}
          />
        )}

        {/* Delete Confirmation Dialog */}
        {customerToDelete && (
          <DeleteCustomerDialog
            open={deleteDialogOpen}
            onOpenChange={setDeleteDialogOpen}
            customerId={customerToDelete.id}
            customerName={customerToDelete.full_name}
          />
        )}

        {/* Import/Export Dialog */}
        <CustomerImportExportDialog
          open={importDialogOpen}
          onOpenChange={setImportDialogOpen}
          onImport={handleImportConfirm}
        />

        {/* Import Result Modal */}
        {importResult && (
          <Dialog open={importResultOpen} onOpenChange={setImportResultOpen}>
            <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Kết quả nhập dữ liệu</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                {/* Summary */}
                <div className="flex gap-4">
                  <div className="flex items-center gap-2 text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2 flex-1">
                    <CheckCircle2 className="h-5 w-5 shrink-0" />
                    <span className="text-sm font-medium">{importResult.successRows.length} thành công</span>
                  </div>
                  {importResult.failRows.length > 0 && (
                    <div className="flex items-center gap-2 text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 flex-1">
                      <XCircle className="h-5 w-5 shrink-0" />
                      <span className="text-sm font-medium">{importResult.failRows.length} thất bại</span>
                    </div>
                  )}
                </div>

                {/* Failed rows detail */}
                {importResult.failRows.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-red-700 flex items-center gap-1">
                      <AlertTriangle className="h-4 w-4" />
                      Danh sách lỗi:
                    </p>
                    <div className="rounded-md border border-red-200 divide-y divide-red-100 max-h-60 overflow-y-auto">
                      {importResult.failRows.map((r, i) => (
                        <div key={i} className="px-3 py-2">
                          <p className="text-sm font-medium">{r.name}</p>
                          <p className="text-xs text-red-600">{r.reason}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Success list (collapsed if many) */}
                {importResult.successRows.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-green-700 flex items-center gap-1">
                      <CheckCircle2 className="h-4 w-4" />
                      Đã nhập thành công:
                    </p>
                    <div className="rounded-md border border-green-200 divide-y divide-green-100 max-h-40 overflow-y-auto">
                      {importResult.successRows.map((r, i) => (
                        <div key={i} className="px-3 py-1.5">
                          <p className="text-sm">{r.name}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <Button className="w-full" onClick={() => setImportResultOpen(false)}>
                  Đóng
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        )}
      </div>
    </MainLayout>
  );
}
