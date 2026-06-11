import { useState } from 'react';
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
  Printer,
  ChevronLeft,
  ChevronRight,
  Eye,
  QrCode,
  Phone,
  Copy,
  Loader2,
} from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import type { ContractWithRelations } from '@/types/contract';
import {
  getContractDisplayStatus,
  CONTRACT_STATUS_CONFIG,
  isContractInEffect,
} from '@/types/contract';
import { useMyBuildingScope } from '@/hooks/useMyBuildingScope';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import { copyContractQrToClipboard } from '@/lib/contractQrImage';
import { toast } from '@/hooks/use-toast';

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
  onPrint: (contract: ContractWithRelations) => void;
  onShowQR: (contract: ContractWithRelations) => void;
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
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
};

// Ngưỡng làm tròn: chênh cọc < 10.000đ coi như đủ (khớp PREVIOUS_DEBT_ROUND_THRESHOLD).
const DEPOSIT_SHORTFALL_THRESHOLD = 10000;

/** Badge cọc cho HĐ đang hiệu lực — để admin thấy ngay HĐ nào chưa thu đủ cọc.
 *  - Đủ cọc (xanh) khi remaining < ngưỡng.
 *  - Còn thiếu + mode 'FIRST_INVOICE' → "Cọc ở HĐ đầu" (xanh dương): khách sẽ
 *    trả đủ ngay trong hoá đơn cọc+tháng đầu, không phải nợ cần nhắc.
 *  - Còn thiếu + mode 'DEBT'/legacy → "Thiếu cọc" (cam): nợ cọc cần thu/nhắc.
 *  HĐ chưa hiệu lực (nháp/đã thanh lý) không hiển thị. */
function DepositBadge({ contract }: { contract: ContractWithRelations }) {
  if (!isContractInEffect(contract.status)) return null;
  const total = contract.total_deposit || 0;
  if (total <= 0) return null;
  const remaining = total - (contract.deposit_paid || 0);
  const isShort = remaining >= DEPOSIT_SHORTFALL_THRESHOLD;
  if (!isShort) {
    return (
      <div className="mt-0.5 flex justify-end">
        <span
          className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium bg-green-100 text-green-700"
          title="Đã thu đủ cọc"
        >
          Đủ cọc
        </span>
      </div>
    );
  }
  const firstInvoice = (contract as any).deposit_debt_mode === 'FIRST_INVOICE';
  return (
    <div className="mt-0.5 flex justify-end">
      <span
        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
          firstInvoice ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-700'
        }`}
        title={
          firstInvoice
            ? `Khách trả ${formatVND(remaining)} cọc trong hoá đơn đầu`
            : `Còn thiếu ${formatVND(remaining)} tiền cọc`
        }
      >
        {firstInvoice
          ? `Cọc ở HĐ đầu ${formatVND(remaining)}`
          : `Thiếu cọc ${formatVND(remaining)}`}
      </span>
    </div>
  );
}

function getRepresentativeCustomerName(contract: ContractWithRelations): string {
  const rep = contract.contract_customers?.find((cc) => cc.is_representative);
  if (rep?.customer?.full_name) return rep.customer.full_name;
  const first = contract.contract_customers?.[0];
  return first?.customer?.full_name || '-';
}

function getRepresentativeCustomerPhone(contract: ContractWithRelations): string {
  const rep = contract.contract_customers?.find((cc) => cc.is_representative);
  if (rep?.customer?.phone) return rep.customer.phone;
  const first = contract.contract_customers?.[0];
  return first?.customer?.phone || '';
}

function getLocationText(contract: ContractWithRelations): { buildingCode: string; roomName: string } {
  return {
    buildingCode: contract.room?.building?.name || '-',
    roomName: contract.room?.name || '',
  };
}

export function getActionButtonStates(contract: ContractWithRelations) {
  const displayStatus = getContractDisplayStatus(contract);
  const dbStatus = contract.status;
  // Hợp đồng đã gia hạn (EXTENDED) vẫn đang hiệu lực → cho thao tác như ACTIVE.
  const inEffect = isContractInEffect(dbStatus);

  return {
    editDisabled: dbStatus === 'TERMINATED',
    renewDisabled: !(inEffect || displayStatus === 'EXPIRED' || displayStatus === 'EXPIRING'),
    transferRoomDisabled: !inEffect,
    moveOutDisabled: !inEffect,
    transferContractDisabled: !inEffect,
    terminateDisabled: !(inEffect || displayStatus === 'EXPIRED' || displayStatus === 'EXPIRING'),
    deleteDisabled: !(dbStatus === 'DRAFT'),
    qrDisabled: dbStatus === 'TERMINATED' || dbStatus === 'DRAFT',
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
  onPrint,
  onShowQR,
  page,
  pageSize,
  totalCount,
  onPageChange,
  onPageSizeChange,
}: ContractListTableProps) {
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const { canManageBuilding } = useMyBuildingScope();
  const [copyingId, setCopyingId] = useState<string | null>(null);

  // Click ô "Vị trí" → copy ảnh QR (QR + phòng/toà) vào clipboard.
  const handleCopyLocationQr = async (contract: ContractWithRelations) => {
    if (copyingId) return;
    if (getActionButtonStates(contract).qrDisabled || !contract.public_code) {
      toast({
        title: 'QR không khả dụng',
        description: 'Hợp đồng đã thanh lý hoặc còn nháp.',
        variant: 'destructive',
      });
      return;
    }
    setCopyingId(contract.id);
    try {
      await copyContractQrToClipboard({
        publicCode: contract.public_code,
        roomName: contract.room?.name,
        buildingName: contract.room?.building?.name,
      });
      const loc = getLocationText(contract);
      toast({
        title: 'Đã copy ảnh QR',
        description: [loc.buildingCode, loc.roomName].filter(Boolean).join(' · '),
      });
    } catch (e: any) {
      toast({
        title: 'Không copy được ảnh QR',
        description: e?.message || 'Lỗi không xác định',
        variant: 'destructive',
      });
    } finally {
      setCopyingId(null);
    }
  };

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
              <TableHead className="hidden md:table-cell">Trạng thái</TableHead>
              <TableHead>Vị trí</TableHead>
              <TableHead>Khách hàng</TableHead>
              <TableHead className="text-right">Giá thuê</TableHead>
              <TableHead className="text-right">Tiền cọc</TableHead>
              <TableHead>Ngày BĐ</TableHead>
              <TableHead>Ngày KT</TableHead>
              <TableHead>Người tạo</TableHead>
              <TableHead className="hidden md:table-cell w-[140px]">Thao tác</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {contracts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={10} className="text-center py-8 text-muted-foreground">
                  Không có hợp đồng nào
                </TableCell>
              </TableRow>
            ) : (
              contracts.map((contract) => {
                const displayStatus = getContractDisplayStatus(contract);
                const statusConfig = CONTRACT_STATUS_CONFIG[displayStatus];
                const actions = getActionButtonStates(contract);
                const customerName = getRepresentativeCustomerName(contract);
                const customerPhone = getRepresentativeCustomerPhone(contract);

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
                    <TableCell className="hidden md:table-cell">
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${statusConfig.color}`}
                      >
                        {statusConfig.label}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm">
                      <button
                        type="button"
                        onClick={() => handleCopyLocationQr(contract)}
                        disabled={copyingId === contract.id}
                        title="Bấm để copy ảnh QR phòng này"
                        className="group -mx-1 block w-full rounded px-1 py-0.5 text-left hover:bg-muted/60 disabled:opacity-60"
                      >
                        <div className="flex items-center gap-1 font-medium">
                          <span>{getLocationText(contract).buildingCode}</span>
                          {copyingId === contract.id ? (
                            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                          ) : (
                            <Copy className="h-3 w-3 text-muted-foreground/50 transition-colors group-hover:text-purple-500" />
                          )}
                        </div>
                        <div className="text-muted-foreground text-xs">
                          {getLocationText(contract).roomName}
                        </div>
                      </button>
                    </TableCell>
                    <TableCell className="text-sm">
                      <Link
                        to={`/contracts/${contract.id}`}
                        className="font-medium text-blue-600 hover:text-blue-800 hover:underline"
                      >
                        {customerName}
                      </Link>
                      {customerPhone && (
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs text-muted-foreground">{customerPhone}</span>
                          <a
                            href={`tel:${customerPhone.replace(/[^\d+]/g, '')}`}
                            onClick={(e) => e.stopPropagation()}
                            className="md:hidden inline-flex h-6 w-6 items-center justify-center rounded-full bg-green-50 text-green-600 active:bg-green-100"
                            aria-label={`Gọi ${customerName}`}
                          >
                            <Phone className="h-3.5 w-3.5" />
                          </a>
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {formatVND(contract.rent_price)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatVND(contract.total_deposit)}
                      <DepositBadge contract={contract} />
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
                    <TableCell className="hidden md:table-cell">
                      <ActionButtons
                        contract={contract}
                        actions={actions}
                        canManage={canManageBuilding(
                          contract.room?.building_id ?? contract.room?.building?.id
                        )}
                        onEdit={onEdit}
                        onRenew={onRenew}
                        onTransferRoom={onTransferRoom}
                        onMoveOut={onMoveOut}
                        onTransferContract={onTransferContract}
                        onTerminate={onTerminate}
                        onDelete={onDelete}
                        onPrint={onPrint}
                        onShowQR={onShowQR}
                      />
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
  /** false → ẩn các nút sửa/xoá/gia hạn/chuyển/thanh lý. Vẫn giữ xem/in/QR. */
  canManage: boolean;
  onEdit: (contract: ContractWithRelations) => void;
  onRenew: (contract: ContractWithRelations) => void;
  onTransferRoom: (contract: ContractWithRelations) => void;
  onMoveOut: (contract: ContractWithRelations) => void;
  onTransferContract: (contract: ContractWithRelations) => void;
  onTerminate: (contract: ContractWithRelations) => void;
  onDelete: (contract: ContractWithRelations) => void;
  onPrint: (contract: ContractWithRelations) => void;
  onShowQR: (contract: ContractWithRelations) => void;
}

function ActionButtons({
  contract,
  actions,
  canManage,
  onEdit,
  onRenew,
  onTransferRoom,
  onMoveOut,
  onTransferContract,
  onTerminate,
  onDelete,
  onPrint,
  onShowQR,
}: ActionButtonsProps) {
  const navigate = useNavigate();
  // Gate theo quyền chi tiết từng chức năng (catalog permissionPages) — kết
  // hợp với scope toà (canManage). JSONB cũ chưa có key chi tiết sẽ fallback
  // về contracts.edit.
  const { data: perms } = useMyPermissions();
  const buttons = [
    {
      label: 'Xem chi tiết',
      icon: Eye,
      onClick: () => navigate(`/contracts/${contract.id}`),
      disabled: false,
      hidden: false,
      bg: 'bg-slate-500 hover:bg-slate-600',
    },
    {
      label: 'Cập nhật',
      icon: Pencil,
      onClick: () => onEdit(contract),
      disabled: actions.editDisabled,
      hidden: !canManage || !canUse(perms, 'contracts', 'edit'),
      bg: 'bg-green-500 hover:bg-green-600',
    },
    {
      label: 'In hợp đồng',
      icon: Printer,
      onClick: () => onPrint(contract),
      disabled: false,
      hidden: !canUse(perms, 'contracts', 'print'),
      bg: 'bg-sky-500 hover:bg-sky-600',
    },
    {
      label: 'Gia hạn',
      icon: CalendarPlus,
      onClick: () => onRenew(contract),
      disabled: actions.renewDisabled,
      hidden: !canManage || !canUse(perms, 'contracts', 'renew'),
      bg: 'bg-green-500 hover:bg-green-600',
    },
    {
      label: 'Chuyển phòng',
      icon: ArrowRightLeft,
      onClick: () => onTransferRoom(contract),
      disabled: actions.transferRoomDisabled,
      hidden: !canManage || !canUse(perms, 'contracts', 'transfer'),
      bg: 'bg-orange-500 hover:bg-orange-600',
    },
    {
      label: 'ĐK chuyển đi',
      icon: LogOut,
      onClick: () => onMoveOut(contract),
      disabled: actions.moveOutDisabled,
      hidden: !canManage || !canUse(perms, 'contracts', 'terminate'),
      bg: 'bg-blue-500 hover:bg-blue-600',
    },
    {
      label: 'Nhượng HĐ',
      icon: UserPlus,
      onClick: () => onTransferContract(contract),
      disabled: actions.transferContractDisabled,
      hidden: !canManage || !canUse(perms, 'contracts', 'transfer'),
      bg: 'bg-yellow-500 hover:bg-yellow-600',
    },
    {
      label: 'Thanh lý',
      icon: FileX,
      onClick: () => onTerminate(contract),
      disabled: actions.terminateDisabled,
      hidden: !canManage || !canUse(perms, 'contracts', 'terminate'),
      bg: 'bg-red-500 hover:bg-red-600',
    },
    {
      label: 'Xóa',
      icon: Trash2,
      onClick: () => onDelete(contract),
      disabled: actions.deleteDisabled,
      hidden: !canManage || !canUse(perms, 'contracts', 'delete'),
      bg: 'bg-red-700 hover:bg-red-800',
    },
    {
      label: 'QR hợp đồng',
      icon: QrCode,
      onClick: () => onShowQR(contract),
      disabled: actions.qrDisabled,
      hidden: false,
      bg: 'bg-purple-500 hover:bg-purple-600',
    },
  ].filter((b) => !b.hidden);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="grid grid-cols-4 gap-1 w-fit">
        {buttons.map((btn) => (
          <Tooltip key={btn.label}>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={`h-7 w-7 rounded flex items-center justify-center text-white ${btn.disabled ? 'opacity-30 cursor-not-allowed bg-gray-400' : btn.bg} transition-colors`}
                disabled={btn.disabled}
                onClick={btn.onClick}
              >
                <btn.icon className="h-3.5 w-3.5" />
              </button>
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
