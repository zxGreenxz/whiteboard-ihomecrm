import { useState } from 'react';
import { Plus, DollarSign, TrendingUp, CheckCircle, XCircle, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useDeposits, useDepositStats, type DepositWithRelations } from '@/hooks/useDeposits';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import { MoreHorizontal } from 'lucide-react';
import CreateDepositDialog from '@/components/deposits/CreateDepositDialog';
import DepositDetailDialog from '@/components/deposits/DepositDetailDialog';
import ConvertDepositToContractDialog from '@/components/deposits/ConvertDepositToContractDialog';

// =============================================
// Status Configuration
// =============================================

const STATUS_CONFIG: Record<string, { label: string; color: string; bgColor: string }> = {
  PENDING: { label: 'Chờ xác nhận', color: 'text-yellow-700', bgColor: 'bg-yellow-100' },
  CONFIRMED: { label: 'Đã xác nhận', color: 'text-green-700', bgColor: 'bg-green-100' },
  REFUNDED: { label: 'Đã hoàn', color: 'text-blue-700', bgColor: 'bg-blue-100' },
  FORFEITED: { label: 'Bị phạt', color: 'text-red-700', bgColor: 'bg-red-100' },
};

// =============================================
// Main Page
// =============================================

export default function DepositsPage() {
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [selectedDeposit, setSelectedDeposit] = useState<DepositWithRelations | null>(null);
  const [convertDialogOpen, setConvertDialogOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Hooks
  const { data: allDeposits = [], isLoading } = useDeposits();
  const { data: stats } = useDepositStats();

  // =============================================
  // Filtering
  // =============================================

  const deposits = allDeposits.filter((deposit) => {
    // Status filter
    if (statusFilter !== 'all' && deposit.status !== statusFilter) {
      return false;
    }

    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      return (
        deposit.tenant?.full_name.toLowerCase().includes(query) ||
        deposit.tenant?.phone.includes(query) ||
        deposit.room?.name.toLowerCase().includes(query)
      );
    }

    return true;
  });

  // =============================================
  // Stats calculation
  // =============================================

  const totalDeposits = allDeposits.length;
  const pendingDeposits = allDeposits.filter((d) => d.status === 'PENDING').length;
  const confirmedDeposits = allDeposits.filter((d) => d.status === 'CONFIRMED').length;
  const totalAmount = allDeposits.reduce((sum, d) => sum + (d.amount || 0), 0);

  // =============================================
  // Handlers
  // =============================================

  const handleConvertToContract = (deposit: DepositWithRelations) => {
    setSelectedDeposit(deposit);
    setConvertDialogOpen(true);
  };

  // =============================================
  // Render
  // =============================================

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="flex items-center justify-center h-64">
          <div className="text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto"></div>
            <p className="mt-4 text-muted-foreground">Đang tải dữ liệu...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* =============================================
          Header
          ============================================= */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Quản lý Đặt cọc</h1>
          <p className="text-muted-foreground mt-1">
            Theo dõi và quản lý các khoản đặt cọc giữ phòng
          </p>
        </div>
        <Button onClick={() => setCreateDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Tạo đặt cọc
        </Button>
      </div>

      {/* =============================================
          Statistics Cards
          ============================================= */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-blue-100 rounded-lg">
              <DollarSign className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Tổng đặt cọc</p>
              <p className="text-2xl font-bold">{totalDeposits}</p>
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-yellow-100 rounded-lg">
              <TrendingUp className="h-5 w-5 text-yellow-600" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Chờ xác nhận</p>
              <p className="text-2xl font-bold">{pendingDeposits}</p>
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-green-100 rounded-lg">
              <CheckCircle className="h-5 w-5 text-green-600" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Đã xác nhận</p>
              <p className="text-2xl font-bold">{confirmedDeposits}</p>
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-purple-100 rounded-lg">
              <DollarSign className="h-5 w-5 text-purple-600" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Tổng tiền</p>
              <p className="text-2xl font-bold">
                {new Intl.NumberFormat('vi-VN').format(totalAmount)}₫
              </p>
            </div>
          </div>
        </Card>
      </div>

      {/* =============================================
          Filters
          ============================================= */}
      <Card className="p-4">
        <div className="flex items-center gap-4">
          <div className="flex-1">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Tìm theo tên khách hàng, SĐT, phòng..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
              />
            </div>
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="Trạng thái" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tất cả trạng thái</SelectItem>
              <SelectItem value="PENDING">Chờ xác nhận</SelectItem>
              <SelectItem value="CONFIRMED">Đã xác nhận</SelectItem>
              <SelectItem value="REFUNDED">Đã hoàn</SelectItem>
              <SelectItem value="FORFEITED">Bị phạt</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </Card>

      {/* =============================================
          Deposits Table
          ============================================= */}
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Ngày đặt cọc</TableHead>
              <TableHead>Khách hàng</TableHead>
              <TableHead>Phòng/Giường</TableHead>
              <TableHead>Số tiền</TableHead>
              <TableHead>Giữ đến</TableHead>
              <TableHead>Trạng thái</TableHead>
              <TableHead className="text-right">Thao tác</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {deposits.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-8">
                  <div className="text-muted-foreground">
                    <DollarSign className="h-12 w-12 mx-auto mb-2 opacity-50" />
                    <p>Chưa có đặt cọc nào</p>
                    {searchQuery && (
                      <p className="text-sm mt-1">
                        Thử thay đổi bộ lọc hoặc tìm kiếm khác
                      </p>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              deposits.map((deposit) => {
                const statusConfig = STATUS_CONFIG[deposit.status || 'PENDING'];
                return (
                  <TableRow key={deposit.id}>
                    <TableCell>
                      {format(new Date(deposit.deposit_date), 'dd/MM/yyyy', { locale: vi })}
                    </TableCell>
                    <TableCell>
                      <div>
                        <p className="font-semibold">{deposit.tenant?.full_name}</p>
                        <p className="text-sm text-muted-foreground">
                          {deposit.tenant?.phone}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell>
                      {deposit.room && (
                        <div>
                          <p>{deposit.room.name}</p>
                          <p className="text-sm text-muted-foreground">
                            {deposit.room.building.name}
                          </p>
                        </div>
                      )}
                      {deposit.bed && (
                        <div>
                          <p>{deposit.bed.name}</p>
                          <p className="text-sm text-muted-foreground">
                            {deposit.bed.room.name} - {deposit.bed.room.building.name}
                          </p>
                        </div>
                      )}
                      {!deposit.room && !deposit.bed && (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="font-semibold">
                        {new Intl.NumberFormat('vi-VN').format(deposit.amount)}₫
                      </span>
                    </TableCell>
                    <TableCell>
                      {deposit.hold_until
                        ? format(new Date(deposit.hold_until), 'dd/MM/yyyy', { locale: vi })
                        : '-'}
                    </TableCell>
                    <TableCell>
                      <Badge className={`${statusConfig.bgColor} ${statusConfig.color}`}>
                        {statusConfig.label}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setSelectedDeposit(deposit)}>
                            Xem chi tiết
                          </DropdownMenuItem>
                          {deposit.status === 'CONFIRMED' && !deposit.contract_id && (
                            <DropdownMenuItem onClick={() => handleConvertToContract(deposit)}>
                              Chuyển thành hợp đồng
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Card>

      {/* =============================================
          Dialogs
          ============================================= */}
      <CreateDepositDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} />

      {selectedDeposit && !convertDialogOpen && (
        <DepositDetailDialog
          deposit={selectedDeposit}
          open={!!selectedDeposit}
          onOpenChange={(open) => !open && setSelectedDeposit(null)}
        />
      )}

      {selectedDeposit && convertDialogOpen && (
        <ConvertDepositToContractDialog
          deposit={selectedDeposit}
          open={convertDialogOpen}
          onOpenChange={(open) => {
            setConvertDialogOpen(open);
            if (!open) {
              setSelectedDeposit(null);
            }
          }}
        />
      )}
    </div>
  );
}
