import {importCustomerBatch} from '@/lib/customerImportOutcome';
import { useState, useMemo, useCallback, useEffect, useRef, lazy, Suspense } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users } from 'lucide-react';
import { usePhoneViewport } from '@/hooks/use-mobile';
import MainLayout from '@/components/layout/MainLayout';

const CustomersMobilePage = lazy(() => import('./CustomersMobilePage'));
import { usePagination, calculatePaginationInfo } from '@/hooks/usePagination';
import { usePersistedState } from '@/hooks/usePersistedState';
import { useCopilotPageContext } from '@/hooks/useCopilotPageContext';
import { DataTablePagination } from '@/components/ui/data-table-pagination';
import EmptyState from '@/components/ui/EmptyState';
import { useCustomers, useCustomerStats, useCreateCustomer } from '@/hooks/useCustomers';
import { QueryRegion } from '@/components/errors/QueryRegion';
import { RefreshBar } from '@/components/loading/LoadingState';
import { friendlyError } from '@/lib/friendlyError';
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

function CustomersDesktopPage() {
  const navigate = useNavigate();

  // State
  const [activeTab, setActiveTab] = usePersistedState<CustomerStatus>('flt:customers:tab', 'RENTING');
  const [activeStatFilter, setActiveStatFilter] = usePersistedState<StatFilterType>('flt:customers:stat', 'ALL');
  const [filters, setFilters] = usePersistedState<CustomerFilters>('flt:customers:filters', {});
  // Lọc toà nhà ([] = tất cả) — đẩy xuống server qua filters.building_id
  // (match HĐ đang hiệu lực qua contract_customers trong useCustomers).
  const [buildingIds, setBuildingIds] = usePersistedState<string[]>('flt:customers:buildingIds', []);
  const [searchQuery, setSearchQuery] = usePersistedState('flt:customers:search', '');
  // Search đẩy xuống server (list + RPC stats) → debounce 350ms như mobile để
  // mỗi phím không bắn 2 request; input vẫn hiển thị searchQuery nên gõ phản
  // hồi tức thì. Khởi tạo từ giá trị khôi phục để F5 không fetch 2 lần.
  const [debouncedSearch, setDebouncedSearch] = useState(() => searchQuery.trim());
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [detailModalOpen, setDetailModalOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [customerToDelete, setCustomerToDelete] = useState<Customer | null>(null);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importResultOpen, setImportResultOpen] = useState(false);
  const [importResult, setImportResult] = useState<{
    successRows: { name: string; id: string }[];
    partialRows: { name: string; id: string; reason: string }[];
    unknownRows: { name: string; reason: string }[];
    failRows: { name: string; reason: string }[];
  } | null>(null);

  // Pagination
  const { page, pageSize, setPage, setPageSize } = usePagination(20);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery.trim()), 350);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // Về trang 1 khi GIÁ TRỊ DEBOUNCED đổi, KHÔNG phải mỗi phím: chỉ debouncedSearch
  // vào queryKey, nên setPage(1) ngay trong handler gõ bắn thêm 1 request key
  // trung gian (trang 1 + từ khoá CŨ) hoàn toàn phí. Bỏ qua lần chạy đầu để
  // không xoá trang đang xem khi khôi phục search từ sessionStorage.
  const searchPageResetRef = useRef(false);
  useEffect(() => {
    if (!searchPageResetRef.current) {
      searchPageResetRef.current = true;
      return;
    }
    setPage(1);
  }, [debouncedSearch, setPage]);

  // Build effective filters — lọc toà đi theo server-side (building_id) để
  // count/phân trang/stats khớp nhau; lọc client trên trang đã phân trang
  // từng làm list còn 1 dòng nhưng vẫn báo "477 mục / 48 trang".
  const effectiveFilters = useMemo<CustomerFilters>(
    () => ({
      ...filters,
      building_id: buildingIds.length === 1 ? buildingIds[0] : undefined,
      status: activeTab,
      statFilter: activeStatFilter,
      search: debouncedSearch || undefined,
    }),
    [filters, buildingIds, activeTab, activeStatFilter, debouncedSearch]
  );

  // Stats filters (same as effective but without statFilter to get all counts)
  useCopilotPageContext('customers.list', effectiveFilters, detailModalOpen ? selectedCustomer : null);

  const statsFilters = useMemo<CustomerFilters>(
    () => ({
      ...filters,
      building_id: buildingIds.length === 1 ? buildingIds[0] : undefined,
      status: activeTab,
      search: debouncedSearch || undefined,
    }),
    [filters, buildingIds, activeTab, debouncedSearch]
  );

  // Data fetching
  const customersQuery = useCustomers(effectiveFilters, { page, pageSize });
  const statsQuery = useCustomerStats(statsFilters);
  const { data: customersData } = customersQuery;
  const { data: stats } = statsQuery;
  const createCustomer = useCreateCustomer({ silent: true });

  const customers = customersData?.data ?? [];
  const totalCount = customersData?.count ?? 0;

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

  const handleBuildingIdsChange = useCallback(
    (ids: string[]) => {
      setBuildingIds(ids);
      setPage(1);
    },
    [setPage]
  );

  // Chỉ cập nhật ô nhập; reset trang do effect trên debouncedSearch lo.
  const handleSearch = useCallback(
    (query: string) => {
      setSearchQuery(query);
    },
    [setSearchQuery]
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
    await importCustomerBatch(rows,{
      create:async(row)=>{
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
        return created?.customer?.id ?? '';
      },
      uploadImages:uploadIdImagesFromUrls,
    },result=>{setImportResult(result);setImportResultOpen(true);});
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
      {/* Chủ chốt 02/10/2026: tab, bộ lọc, thanh công cụ hiện ngay; thẻ thống kê và bảng
          là hai vùng chờ riêng (hai nguồn độc lập) — mỗi vùng tự báo lỗi của nó. */}
      <div className="space-y-4">
        {/* Status Tabs */}
        <CustomerStatusTabs activeTab={activeTab} onTabChange={handleTabChange} />

        {/* Stats Cards — chưa có số thì ô số là vạch xám, không in 0. */}
        <QueryRegion
          label="thống kê khách hàng"
          queries={[statsQuery]}
          loading={
            <CustomerStatsCards
              stats={null}
              activeFilter={activeStatFilter}
              onFilterChange={handleStatFilterChange}
            />
          }
        >
          <CustomerStatsCards
            stats={stats ?? null}
            activeFilter={activeStatFilter}
            onFilterChange={handleStatFilterChange}
          />
        </QueryRegion>

        {/* Location Filters */}
        <CustomerListFilters
          filters={filters}
          onFiltersChange={handleFiltersChange}
          buildingIds={buildingIds}
          onBuildingIdsChange={handleBuildingIdsChange}
        />

        {/* Toolbar */}
        <CustomerListToolbar
          searchQuery={searchQuery}
          onSearchChange={handleSearch}
          onAdd={handleAdd}
          onExport={handleExport}
          exportDisabled={customersData === undefined || customersQuery.isError}
          onImport={handleImport}
          onPrint={handlePrint}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
        />

        {/* Table — đổi trang/bộ lọc giữ bảng cũ (keepPreviousData), chỉ vạch mảnh mép trên. */}
        <div className="relative bg-white rounded-lg border">
          <QueryRegion label="danh sách khách hàng" queries={[customersQuery]} skeleton="table" rows={8}>
          <RefreshBar active={customersQuery.isFetching && customersData !== undefined} label="Đang cập nhật danh sách khách hàng" />
          {customers.length === 0 ? (
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
          </QueryRegion>
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
                  {importResult.partialRows.length > 0 && (
                    <div className="flex items-center gap-2 text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 flex-1">
                      <AlertTriangle className="h-5 w-5 shrink-0" />
                      <span className="text-sm font-medium">{importResult.partialRows.length} đã tạo, cần kiểm tra ảnh</span>
                    </div>
                  )}
                  {importResult.unknownRows.length > 0 && (
                    <div className="flex items-center gap-2 text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 flex-1">
                      <AlertTriangle className="h-5 w-5 shrink-0" />
                      <span className="text-sm font-medium">{importResult.unknownRows.length} chưa xác nhận</span>
                    </div>
                  )}
                </div>

                {importResult.unknownRows.length > 0 && <div role="alert" className="rounded-md border border-amber-200 p-3 text-sm">
                  <p className="font-medium">Chưa xác nhận được các dòng sau; tải lại danh sách khách để đối chiếu trước khi nhập lại.</p>
                  {importResult.unknownRows.map((row, index) => <p key={`${row.name}-${index}`}>{row.name}: {row.reason}</p>)}
                </div>}

                {importResult.partialRows.length > 0 && <div role="alert" className="rounded-md border border-amber-200 divide-y divide-amber-100">
                  {importResult.partialRows.map(row => <div key={row.id} className="px-3 py-2 text-sm">
                    <p className="font-medium">{row.name} · ID {row.id}</p>
                    <p className="text-amber-800">{row.reason} Không nhập lại dòng này.</p>
                  </div>)}
                </div>}

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
                          <p className="text-sm">{r.name} · ID {r.id}</p>
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

// Mobile (≤767px): màn hình app full-screen riêng (khởi tạo đồng bộ → không nháy
// bảng desktop / không mount query nặng của desktop trên điện thoại).
export default function CustomersPage() {
  const isPhone = usePhoneViewport();
  if (isPhone) {
    return (
      <Suspense fallback={null}>
        <CustomersMobilePage />
      </Suspense>
    );
  }
  return <CustomersDesktopPage />;
}
