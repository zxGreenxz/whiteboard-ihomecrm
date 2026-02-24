import { useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users } from 'lucide-react';
import MainLayout from '@/components/layout/MainLayout';
import { usePagination, calculatePaginationInfo } from '@/hooks/usePagination';
import { DataTablePagination } from '@/components/ui/data-table-pagination';
import EmptyState from '@/components/ui/EmptyState';
import { useCustomers, useCustomerStats } from '@/hooks/useCustomers';
import type { Customer, CustomerStatus, StatFilterType, CustomerFilters } from '@/types/customer';
import type { ViewMode } from '@/components/customers/CustomerListToolbar';

import CustomerStatusTabs from '@/components/customers/CustomerStatusTabs';
import CustomerStatsCards from '@/components/customers/CustomerStatsCards';
import CustomerListFilters from '@/components/customers/CustomerListFilters';
import CustomerListToolbar from '@/components/customers/CustomerListToolbar';
import CustomerListTable from '@/components/customers/CustomerListTable';
import CustomerDetailModal from '@/components/customers/CustomerDetailModal';
import DeleteCustomerDialog from '@/components/customers/DeleteCustomerDialog';

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
    // TODO: implement export
    console.log('Export customers');
  }, []);

  const handleImport = useCallback(() => {
    // TODO: implement import dialog
    console.log('Import customers');
  }, []);

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
      </div>
    </MainLayout>
  );
}
