import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Pencil,
  CalendarPlus,
  ArrowRightLeft,
  LogOut,
  UserPlus,
  FileX,
  Trash2,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import type { ContractWithRelations } from '@/types/contract';
import {
  getContractDisplayStatus,
  CONTRACT_STATUS_CONFIG,
} from '@/types/contract';

interface ContractListTableProps {
  contracts: ContractWithRelations[];
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
  onEdit: (contract: ContractWithRelations) => void;
  onRenew: (contract: ContractWithRelations) => void;
  onTransferRoom: (contract: ContractWithRelations) => void;
  onMoveOut: (contract: ContractWithRelations) => void;
  onTransferContract: (contract: ContractWithRelations) => void;
  onTerminate: (contract: ContractWithRelations) => void;
  onDelete: (contract: ContractWithRelations) => void;
  page: number;
  pageSize: number;
  totalCount: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}

const formatVND = (amount: number) => {
  return new Intl.NumberFormat('vi-VN').format(amount) + ' đ';
};

const formatDate = (dateStr: string) => {
  const date = new Date(dateStr);
  return date.toLocaleDateString('vi-VN');
};

function getRepresentativeCustomerName(contract: ContractWithRelations): string {
  const rep = contract.contract_customers?.find((cc) => cc.is_representative);
  if (rep?.customer?.full_name) return rep.customer.full_name;
  const first = contract.contract_customers?.[0];
  return first?.customer?.full_name || '-';
}

function getLocationText(contract: ContractWithRelations): string {
  const parts: string[] = [];
  if (contract.room?.building?.name) parts.push(contract.room.building.name);
  if (contract.room?.name) parts.push(contract.room.name);
  if (contract.bed?.name) parts.push(contract.bed.name);
  return parts.join(' - ') || '-';
}

export function getActionButtonStates(contract: ContractWithRelations) {
  const displayStatus = getContractDisplayStatus(contract);
  const dbStatus = contract.status;

  return {
    editDisabled: dbStatus === 'TERMINATED',
    renewDisabled: !(dbStatus === 'ACTIVE' || displayStatus === 'EXPIRED' || displayStatus === 'EXPIRING'),
    transferRoomDisabled: dbStatus !== 'ACTIVE',
    moveOutDisabled: dbStatus !== 'ACTIVE',
    transferContractDisabled: dbStatus !== 'ACTIVE',
    terminateDisabled: !(dbStatus === 'ACTIVE' || displayStatus === 'EXPIRED' || displayStatus === 'EXPIRING'),
    deleteDisabled: !(dbStatus === 'DRAFT'),
  };
}

const PAGE_SIZES = [10, 20, 50, 100];

export default function ContractListTable({
  contracts,
  selectedIds,
  onSelectionChange,
  onEdit,
  onRenew,
  onTransferRoom,
  onMoveOut,
  onTransferContract,
  onTerminate,
  onDelete,
  page,
  pageSize,
  totalCount,
  onPageChange,
  onPageSizeChange,
}: ContractListTableProps) {
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  const allSelected =
    contracts.length > 0 && contracts.every((c) => selectedIds.includes(c.id));
  const someSelected =
    contracts.some((c) => selectedIds.includes(c.id)) && !allSelected;

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      const allIds = new Set([...selectedIds, ...contracts.map((c) => c.id)]);
      onSelectionChange(Array.from(allIds));
    } else {
      const contractIds = new Set(contracts.map((c) => c.id));
      onSelectionChange(selectedIds.filter((id) => !contractIds.has(id)));
    }
  };

  const handleSelectRow = (contractId: string, checked: boolean) => {
    if (checked) {
      onSelectionChange([...selectedIds, contractId]);
    } else {
      onSelectionChange(selectedIds.filter((id) => id !== contractId));
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[40px]">
                <Checkbox
                  checked={allSelected}
                  ref={(el) => {
                    if (el) {
                      (el as unknown as HTMLButtonElement).dataset.state =
                        someSelected ? 'indeterminate' : allSelected ? 'checked' : 'unchecked';
                    }
                  }}
                  onCheckedChange={(checked) => handleSelectAll(!!checked)}
                  aria-label="Chọn tất cả"
                />
              </TableHead>
              <TableHead>Mã HĐ</TableHead>
              <TableHead>Trạng thái</TableHead>
              <TableHead className="w-[260px]">Thao tác</TableHead>
              <TableHead>Vị trí</TableHead>
              <TableHead>Khách hàng</TableHead>
              <TableHead className="text-right">Giá thuê</TableHead>
              <TableHead className="text-right">Tiền cọc</TableHead>
              <TableHead>Ngày BĐ</TableHead>
              <TableHead>Ngày KT</TableHead>
              <TableHead>Người tạo</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {contracts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={11} className="text-center py-8 text-muted-foreground">
                  Không có hợp đồng nào
                </TableCell>
              </TableRow>
            ) : (
              contracts.map((contract) => {
                const displayStatus = getContractDisplayStatus(contract);
                const statusConfig = CONTRACT_STATUS_CONFIG[displayStatus];
                const actions = getActionButtonStates(contract);

                return (
                  <TableRow key={contract.id}>
                    <TableCell>
                      <Checkbox
                        checked={selectedIds.includes(contract.id)}
                        onCheckedChange={(checked) =>
                          handleSelectRow(contract.id, !!checked)
                        }
                        aria-label={`Chọn hợp đồng ${contract.contract_number || contract.id}`}
                      />
                    </TableCell>
                    <TableCell className="font-medium">
                      {contract.contract_number || '-'}
                    </TableCell>
                    <TableCell>
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${statusConfig.color}`}
                      >
                        {statusConfig.label}
                      </span>
                    </TableCell>
                    <TableCell>
                      <ActionButtons
                        contract={contract}
                        actions={actions}
                        onEdit={onEdit}
                        onRenew={onRenew}
                        onTransferRoom={onTransferRoom}
                        onMoveOut={onMoveOut}
                        onTransferContract={onTransferContract}
                        onTerminate={onTerminate}
                        onDelete={onDelete}
                      />
                    </TableCell>
                    <TableCell className="text-sm">
                      {getLocationText(contract)}
                    </TableCell>
                    <TableCell className="text-sm">
                      {getRepresentativeCustomerName(contract)}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {formatVND(contract.rent_price)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatVND(contract.total_deposit)}
                    </TableCell>
                    <TableCell className="text-sm">
                      {formatDate(contract.start_date)}
                    </TableCell>
                    <TableCell className="text-sm">
                      {formatDate(contract.end_date)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      -
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>Hiển thị</span>
          <Select
            value={String(pageSize)}
            onValueChange={(val) => onPageSizeChange(Number(val))}
          >
            <SelectTrigger className="h-8 w-[70px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZES.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span>/ {totalCount} hợp đồng</span>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">
            Trang {page} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
            aria-label="Trang trước"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            disabled={page >= totalPages}
            onClick={() => onPageChange(page + 1)}
            aria-label="Trang sau"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

interface ActionButtonsProps {
  contract: ContractWithRelations;
  actions: ReturnType<typeof getActionButtonStates>;
  onEdit: (contract: ContractWithRelations) => void;
  onRenew: (contract: ContractWithRelations) => void;
  onTransferRoom: (contract: ContractWithRelations) => void;
  onMoveOut: (contract: ContractWithRelations) => void;
  onTransferContract: (contract: ContractWithRelations) => void;
  onTerminate: (contract: ContractWithRelations) => void;
  onDelete: (contract: ContractWithRelations) => void;
}

function ActionButtons({
  contract,
  actions,
  onEdit,
  onRenew,
  onTransferRoom,
  onMoveOut,
  onTransferContract,
  onTerminate,
  onDelete,
}: ActionButtonsProps) {
  const buttons = [
    {
      label: 'Cập nhật',
      icon: Pencil,
      onClick: () => onEdit(contract),
      disabled: actions.editDisabled,
      className: 'text-green-600 hover:text-green-700 hover:bg-green-50',
    },
    {
      label: 'Gia hạn',
      icon: CalendarPlus,
      onClick: () => onRenew(contract),
      disabled: actions.renewDisabled,
      className: 'text-green-600 hover:text-green-700 hover:bg-green-50',
    },
    {
      label: 'Chuyển phòng',
      icon: ArrowRightLeft,
      onClick: () => onTransferRoom(contract),
      disabled: actions.transferRoomDisabled,
      className: 'text-orange-600 hover:text-orange-700 hover:bg-orange-50',
    },
    {
      label: 'ĐK chuyển đi',
      icon: LogOut,
      onClick: () => onMoveOut(contract),
      disabled: actions.moveOutDisabled,
      className: 'text-blue-600 hover:text-blue-700 hover:bg-blue-50',
    },
    {
      label: 'Nhượng HĐ',
      icon: UserPlus,
      onClick: () => onTransferContract(contract),
      disabled: actions.transferContractDisabled,
      className: 'text-purple-600 hover:text-purple-700 hover:bg-purple-50',
    },
    {
      label: 'Thanh lý',
      icon: FileX,
      onClick: () => onTerminate(contract),
      disabled: actions.terminateDisabled,
      className: 'text-red-600 hover:text-red-700 hover:bg-red-50',
    },
    {
      label: 'Xóa',
      icon: Trash2,
      onClick: () => onDelete(contract),
      disabled: actions.deleteDisabled,
      className: 'text-red-600 hover:text-red-700 hover:bg-red-50',
    },
  ];

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex items-center gap-0.5">
        {buttons.map((btn) => (
          <Tooltip key={btn.label}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={`h-7 w-7 ${btn.disabled ? 'opacity-40 cursor-not-allowed' : btn.className}`}
                disabled={btn.disabled}
                onClick={btn.onClick}
              >
                <btn.icon className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>{btn.label}</p>
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  );
}
