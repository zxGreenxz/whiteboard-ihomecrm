import { useState, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import MainLayout from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Badge } from '@/components/ui/badge';
import {
  FileText,
  Plus,
  Search,
  MoreVertical,
  RefreshCw,
  ArrowRightLeft,
  XCircle,
  Eye,
  Upload,
  LogOut,
} from 'lucide-react';
import EmptyState from '@/components/ui/EmptyState';
import { useContracts, type ContractWithRelations } from '@/hooks/useContracts';
import { usePagination, calculatePaginationInfo } from '@/hooks/usePagination';
import { DataTablePagination } from '@/components/ui/data-table-pagination';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import CreateContractDialog from '@/components/contracts/CreateContractDialog';
import ExtendContractDialog from '@/components/contracts/ExtendContractDialog';
import TransferContractDialog from '@/components/contracts/TransferContractDialog';
import TerminateContractDialog from '@/components/contracts/TerminateContractDialog';
import RegisterMoveOutDialog from '@/components/contracts/RegisterMoveOutDialog';
import ImportContractsDialog from '@/components/contracts/ImportContractsDialog';
import TerminationApprovalsTab from '@/components/contracts/TerminationApprovalsTab';
import ESigningTab from '@/components/contracts/ESigningTab';
import { useGeneralSettings } from '@/hooks/useSettings';

const ContractsPage = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get('tab') || 'contracts';
  const { data: generalSettings } = useGeneralSettings();
  const eSigningEnabled = generalSettings?.contract_e_signing_enabled === true;
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [selectedContract, setSelectedContract] = useState<ContractWithRelations | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [extendDialogOpen, setExtendDialogOpen] = useState(false);
  const [transferDialogOpen, setTransferDialogOpen] = useState(false);
  const [terminateDialogOpen, setTerminateDialogOpen] = useState(false);
  const [registerMoveOutDialogOpen, setRegisterMoveOutDialogOpen] = useState(false);
  const [transferDefaultType, setTransferDefaultType] = useState<'TENANT_CHANGE' | 'ROOM_CHANGE'>('ROOM_CHANGE');
  const [importDialogOpen, setImportDialogOpen] = useState(false);

  // Pagination state
  const { page, pageSize, setPage, setPageSize } = usePagination(20);

  // Fetch contracts with pagination
  const { data: contractsData, isLoading } = useContracts(
    { status: statusFilter || undefined },
    { page, pageSize }
  );

  // Extract data and count from response - DEFENSIVE CHECK
  const contracts = Array.isArray(contractsData?.data) ? contractsData.data : [];
  const totalCount = contractsData?.count || 0;

  // Filter contracts based on search term (client-side for small datasets)
  const filteredContracts = useMemo(() => {
    // Defensive check - ensure contracts is array
    if (!Array.isArray(contracts)) return [];
    if (!searchTerm) return contracts;

    const searchLower = searchTerm.toLowerCase();
    return contracts.filter((contract) => (
      contract.contract_number?.toLowerCase().includes(searchLower) ||
      contract.tenant?.full_name?.toLowerCase().includes(searchLower) ||
      contract.tenant?.phone?.includes(searchTerm) ||
      contract.room?.name?.toLowerCase().includes(searchLower) ||
      contract.bed?.name?.toLowerCase().includes(searchLower) ||
      contract.contract_tenants?.some(ct =>
        ct.tenant?.full_name?.toLowerCase().includes(searchLower) ||
        ct.tenant?.phone?.includes(searchTerm)
      )
    ));
  }, [contracts, searchTerm]);

  // Calculate pagination info
  const paginationInfo = useMemo(() => {
    // When searching client-side, use filtered count
    const count = searchTerm ? filteredContracts.length : totalCount;
    return calculatePaginationInfo(page, pageSize, count);
  }, [page, pageSize, totalCount, searchTerm, filteredContracts.length]);

  const getStatusBadge = (contract: ContractWithRelations) => {
    // Check for expected move out date
    if (contract.status === 'ACTIVE' && (contract as any).expected_move_out_date) {
      return <Badge className="bg-orange-500 hover:bg-orange-600">Sắp chuyển đi</Badge>;
    }

    const variants: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; label: string }> = {
      DRAFT: { variant: 'outline', label: 'Nháp' },
      ACTIVE: { variant: 'default', label: 'Đang hoạt động' },
      EXTENDED: { variant: 'secondary', label: 'Đã gia hạn' },
      TRANSFERRED: { variant: 'secondary', label: 'Đã chuyển nhượng' },
      TERMINATED: { variant: 'destructive', label: 'Đã thanh lý' },
      EXPIRED: { variant: 'destructive', label: 'Hết hạn' },
    };

    const config = variants[contract.status] || { variant: 'outline' as const, label: contract.status };
    return <Badge variant={config.variant}>{config.label}</Badge>;
  };

  const getLocationDisplay = (contract: ContractWithRelations) => {
    if (contract.room) {
      return `${contract.room.building?.name} - ${contract.room.name}`;
    }
    if (contract.bed) {
      return `${contract.bed.room?.building?.name} - ${contract.bed.room?.name} - ${contract.bed.name}`;
    }
    return 'N/A';
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('vi-VN', {
      style: 'currency',
      currency: 'VND',
    }).format(amount);
  };

  // Reset to page 1 when filters change
  const handleStatusChange = (value: string) => {
    setStatusFilter(value);
    setPage(1);
  };

  const handleSearchChange = (value: string) => {
    setSearchTerm(value);
    // Don't reset page for client-side search
  };

  return (
    <MainLayout
      title="Quản lý Hợp đồng"
      subtitle="Quản lý hợp đồng thuê căn hộ"
      icon={FileText}
    >
      {/* Tab Navigation */}
      <div className="flex gap-1 mb-6 border-b">
        <button
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'contracts'
              ? 'border-primary text-primary'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
          onClick={() => setSearchParams({})}
        >
          Danh sách hợp đồng
        </button>
        <button
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'termination-approvals'
              ? 'border-primary text-primary'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
          onClick={() => setSearchParams({ tab: 'termination-approvals' })}
        >
          Duyệt thanh lý
        </button>
        {eSigningEnabled && (
          <button
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'e-signing'
                ? 'border-primary text-primary'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
            onClick={() => setSearchParams({ tab: 'e-signing' })}
          >
            Ký điện tử
          </button>
        )}
      </div>

      {activeTab === 'termination-approvals' ? (
        <TerminationApprovalsTab />
      ) : activeTab === 'e-signing' && eSigningEnabled ? (
        <ESigningTab />
      ) : (
      <>
      {/* Header Actions */}
      <div className="flex flex-col sm:flex-row gap-4 mb-6">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
          <Input
            placeholder="Tìm theo mã HĐ, tên khách, SĐT, căn hộ..."
            value={searchTerm}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="pl-10"
          />
        </div>

        <select
          value={statusFilter}
          onChange={(e) => handleStatusChange(e.target.value)}
          className="px-4 py-2 border rounded-md bg-white"
        >
          <option value="">Tất cả trạng thái</option>
          <option value="DRAFT">Nháp</option>
          <option value="ACTIVE">Đang hoạt động</option>
          <option value="EXTENDED">Đã gia hạn</option>
          <option value="TRANSFERRED">Đã chuyển nhượng</option>
          <option value="TERMINATED">Đã thanh lý</option>
          <option value="EXPIRED">Hết hạn</option>
        </select>

        <Button variant="outline" onClick={() => setImportDialogOpen(true)}>
          <Upload className="h-4 w-4 mr-2" />
          Nhập từ file
        </Button>

        <Button onClick={() => setCreateDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Tạo hợp đồng
        </Button>
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border">
        {isLoading ? (
          <div className="p-8 text-center text-gray-500">
            Đang tải dữ liệu...
          </div>
        ) : !filteredContracts || filteredContracts.length === 0 ? (
          searchTerm || statusFilter ? (
            <div className="p-8 text-center text-gray-500">
              Không tìm thấy hợp đồng nào phù hợp
            </div>
          ) : (
            <EmptyState
              icon={FileText}
              title="Chưa có hợp đồng nào"
              description="Hãy tạo hợp đồng đầu tiên để bắt đầu quản lý"
              actionLabel="Tạo hợp đồng"
              onAction={() => setCreateDialogOpen(true)}
            />
          )
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Mã HĐ</TableHead>
                  <TableHead>Khách hàng</TableHead>
                  <TableHead>Căn hộ/Giường</TableHead>
                  <TableHead>Thời gian</TableHead>
                  <TableHead>Giá thuê</TableHead>
                  <TableHead>Trạng thái</TableHead>
                  <TableHead className="text-right">Thao tác</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredContracts.map((contract) => (
                  <TableRow key={contract.id}>
                    <TableCell className="font-medium">
                      {contract.contract_number || contract.id.slice(0, 8)}
                    </TableCell>
                    <TableCell>
                      {contract.contract_tenants && contract.contract_tenants.length > 0 ? (
                        <div>
                          <div className="font-medium">
                            {contract.contract_tenants.find(ct => ct.is_representative)?.tenant?.full_name
                              || contract.contract_tenants[0]?.tenant?.full_name
                              || contract.tenant?.full_name}
                          </div>
                          <div className="text-sm text-gray-500">
                            {contract.contract_tenants.find(ct => ct.is_representative)?.tenant?.phone
                              || contract.contract_tenants[0]?.tenant?.phone
                              || contract.tenant?.phone}
                          </div>
                          {contract.contract_tenants.length > 1 && (
                            <div className="text-xs text-blue-600">
                              +{contract.contract_tenants.length - 1} người khác
                            </div>
                          )}
                        </div>
                      ) : (
                        <div>
                          <div className="font-medium">{contract.tenant?.full_name}</div>
                          <div className="text-sm text-gray-500">{contract.tenant?.phone}</div>
                        </div>
                      )}
                    </TableCell>
                    <TableCell>{getLocationDisplay(contract)}</TableCell>
                    <TableCell>
                      <div className="text-sm">
                        <div>
                          {format(new Date(contract.start_date), 'dd/MM/yyyy', { locale: vi })}
                          {' → '}
                          {format(new Date(contract.end_date), 'dd/MM/yyyy', { locale: vi })}
                        </div>
                        <div className="text-gray-500">
                          {contract.actual_end_date
                            ? `Kết thúc: ${format(new Date(contract.actual_end_date), 'dd/MM/yyyy', { locale: vi })}`
                            : (contract as any).expected_move_out_date
                              ? `Dự kiến ra: ${format(new Date((contract as any).expected_move_out_date), 'dd/MM/yyyy', { locale: vi })}`
                              : `Còn ${Math.ceil((new Date(contract.end_date).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24))} ngày`}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      {formatCurrency(contract.rent_price)}
                      <div className="text-xs text-gray-500 capitalize">
                        {contract.payment_cycle?.toLowerCase()}
                      </div>
                    </TableCell>
                    <TableCell>{getStatusBadge(contract)}</TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm">
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuLabel>Thao tác</DropdownMenuLabel>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => {
                              navigate(`/contracts/${contract.id}`);
                            }}
                          >
                            <Eye className="h-4 w-4 mr-2" />
                            Xem chi tiết
                          </DropdownMenuItem>
                          {contract.status === 'ACTIVE' && (
                            <>
                              <DropdownMenuItem
                                onClick={() => {
                                  setSelectedContract(contract);
                                  setExtendDialogOpen(true);
                                }}
                              >
                                <RefreshCw className="h-4 w-4 mr-2" />
                                Gia hạn hợp đồng
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => {
                                  setSelectedContract(contract);
                                  setTransferDefaultType('ROOM_CHANGE');
                                  setTransferDialogOpen(true);
                                }}
                              >
                                <ArrowRightLeft className="h-4 w-4 mr-2" />
                                Chuyển Căn hộ/Giường
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => {
                                  setSelectedContract(contract);
                                  setTransferDefaultType('TENANT_CHANGE');
                                  setTransferDialogOpen(true);
                                }}
                              >
                                <ArrowRightLeft className="h-4 w-4 mr-2" />
                                Nhượng hợp đồng
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => {
                                  setSelectedContract(contract);
                                  setRegisterMoveOutDialogOpen(true);
                                }}
                              >
                                <LogOut className="h-4 w-4 mr-2" />
                                Đăng ký ngày chuyển đi
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                className="text-red-600"
                                onClick={() => {
                                  setSelectedContract(contract);
                                  setTerminateDialogOpen(true);
                                }}
                              >
                                <XCircle className="h-4 w-4 mr-2" />
                                Thanh lý hợp đồng
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {/* Pagination */}
            <DataTablePagination
              paginationInfo={paginationInfo}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
              showPageSizeSelector={true}
              showItemCount={true}
            />
          </>
        )}
      </div>

      {/* Summary Stats */}
      {totalCount > 0 && Array.isArray(contracts) && (
        <div className="mt-6 grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-white p-4 rounded-lg border">
            <div className="text-sm text-gray-500">Tổng hợp đồng</div>
            <div className="text-2xl font-bold mt-1">{totalCount}</div>
          </div>
          <div className="bg-white p-4 rounded-lg border">
            <div className="text-sm text-gray-500">Đang hoạt động</div>
            <div className="text-2xl font-bold mt-1 text-green-600">
              {contracts.filter((c) => c.status === 'ACTIVE').length}
            </div>
          </div>
          <div className="bg-white p-4 rounded-lg border">
            <div className="text-sm text-gray-500">Sắp hết hạn (30 ngày)</div>
            <div className="text-2xl font-bold mt-1 text-orange-600">
              {
                contracts.filter(
                  (c) =>
                    c.status === 'ACTIVE' &&
                    new Date(c.end_date).getTime() - new Date().getTime() <
                    30 * 24 * 60 * 60 * 1000
                ).length
              }
            </div>
          </div>
          <div className="bg-white p-4 rounded-lg border">
            <div className="text-sm text-gray-500">Đã thanh lý</div>
            <div className="text-2xl font-bold mt-1 text-gray-600">
              {contracts.filter((c) => c.status === 'TERMINATED').length}
            </div>
          </div>
        </div>
      )}

      {/* Dialogs */}
      <CreateContractDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
      />

      <ExtendContractDialog
        open={extendDialogOpen}
        onOpenChange={setExtendDialogOpen}
        contract={selectedContract}
      />

      <TransferContractDialog
        open={transferDialogOpen}
        onOpenChange={setTransferDialogOpen}
        contract={selectedContract}
        defaultTransferType={transferDefaultType}
      />

      <TerminateContractDialog
        open={terminateDialogOpen}
        onOpenChange={setTerminateDialogOpen}
        contract={selectedContract}
      />

      <RegisterMoveOutDialog
        open={registerMoveOutDialogOpen}
        onOpenChange={setRegisterMoveOutDialogOpen}
        contract={selectedContract}
      />

      <ImportContractsDialog
        open={importDialogOpen}
        onOpenChange={setImportDialogOpen}
      />
      </>
      )}
    </MainLayout>
  );
};

export default ContractsPage;
