import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
} from 'lucide-react';
import { useContracts, type ContractWithRelations } from '@/hooks/useContracts';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import CreateContractDialog from '@/components/contracts/CreateContractDialog';
import ExtendContractDialog from '@/components/contracts/ExtendContractDialog';
import TransferContractDialog from '@/components/contracts/TransferContractDialog';
import TerminateContractDialog from '@/components/contracts/TerminateContractDialog';

const ContractsPage = () => {
  const navigate = useNavigate();
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [selectedContract, setSelectedContract] = useState<ContractWithRelations | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [extendDialogOpen, setExtendDialogOpen] = useState(false);
  const [transferDialogOpen, setTransferDialogOpen] = useState(false);
  const [terminateDialogOpen, setTerminateDialogOpen] = useState(false);

  const { data: contracts, isLoading } = useContracts({
    status: statusFilter || undefined,
  });

  // Filter contracts based on search term
  const filteredContracts = contracts?.filter((contract) => {
    const searchLower = searchTerm.toLowerCase();
    return (
      contract.contract_number?.toLowerCase().includes(searchLower) ||
      contract.tenant?.full_name.toLowerCase().includes(searchLower) ||
      contract.tenant?.phone.includes(searchTerm) ||
      contract.room?.name.toLowerCase().includes(searchLower) ||
      contract.bed?.name.toLowerCase().includes(searchLower)
    );
  });

  const getStatusBadge = (status: string) => {
    const variants: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; label: string }> = {
      DRAFT: { variant: 'outline', label: 'Nháp' },
      ACTIVE: { variant: 'default', label: 'Đang hoạt động' },
      EXTENDED: { variant: 'secondary', label: 'Đã gia hạn' },
      TRANSFERRED: { variant: 'secondary', label: 'Đã chuyển nhượng' },
      TERMINATED: { variant: 'destructive', label: 'Đã thanh lý' },
      EXPIRED: { variant: 'destructive', label: 'Hết hạn' },
    };

    const config = variants[status] || { variant: 'outline' as const, label: status };
    return <Badge variant={config.variant}>{config.label}</Badge>;
  };

  const getLocationDisplay = (contract: typeof contracts[0]) => {
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

  return (
    <MainLayout
      title="Quản lý Hợp đồng"
      subtitle="Quản lý hợp đồng thuê phòng"
      icon={FileText}
    >
      {/* Header Actions */}
      <div className="flex flex-col sm:flex-row gap-4 mb-6">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
          <Input
            placeholder="Tìm theo mã HĐ, tên khách, SĐT, phòng..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10"
          />
        </div>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
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
          <div className="p-8 text-center text-gray-500">
            {searchTerm || statusFilter
              ? 'Không tìm thấy hợp đồng nào phù hợp'
              : 'Chưa có hợp đồng nào. Nhấn "Tạo hợp đồng" để bắt đầu.'}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Mã HĐ</TableHead>
                <TableHead>Khách thuê</TableHead>
                <TableHead>Phòng/Giường</TableHead>
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
                    <div>
                      <div className="font-medium">{contract.tenant?.full_name}</div>
                      <div className="text-sm text-gray-500">{contract.tenant?.phone}</div>
                    </div>
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
                  <TableCell>{getStatusBadge(contract.status)}</TableCell>
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
                        <DropdownMenuItem onClick={() => navigate(`/contracts/${contract.id}`)}>
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
                              Gia hạn
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => {
                                setSelectedContract(contract);
                                setTransferDialogOpen(true);
                              }}
                            >
                              <ArrowRightLeft className="h-4 w-4 mr-2" />
                              Chuyển phòng/Nhượng HĐ
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
        )}
      </div>

      {/* Summary Stats */}
      {contracts && contracts.length > 0 && (
        <div className="mt-6 grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-white p-4 rounded-lg border">
            <div className="text-sm text-gray-500">Tổng hợp đồng</div>
            <div className="text-2xl font-bold mt-1">{contracts.length}</div>
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
      />

      <TerminateContractDialog
        open={terminateDialogOpen}
        onOpenChange={setTerminateDialogOpen}
        contract={selectedContract}
      />
    </MainLayout>
  );
};

export default ContractsPage;
