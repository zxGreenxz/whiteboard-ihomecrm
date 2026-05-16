import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Plus,
  LayoutGrid,
  Search,
  Trash2,
  Table as TableIcon,
  Wallet,
} from 'lucide-react';
import {
  INVOICE_COLUMNS,
  type InvoiceColumnKey,
  type InvoiceColumnVisibility,
} from './invoiceListColumns';

interface InvoiceListToolbarProps {
  selectedCount: number;
  searchQuery: string;
  onSearch: (query: string) => void;
  onAdd: () => void;
  onExcelMode: () => void;
  onBulkRecordPayment: () => void;
  onBulkDelete: () => void;
  columnVisibility: InvoiceColumnVisibility;
  onToggleColumn: (key: InvoiceColumnKey) => void;
  onResetColumns: () => void;
}

interface ToolbarButton {
  icon: React.ElementType;
  label: string;
  onClick: () => void;
  bg: string;
  hoverBg: string;
  textColor: string;
}

const InvoiceListToolbar = ({
  selectedCount,
  searchQuery,
  onSearch,
  onAdd,
  onExcelMode,
  onBulkRecordPayment,
  onBulkDelete,
  columnVisibility,
  onToggleColumn,
  onResetColumns,
}: InvoiceListToolbarProps) => {
  const buttons: ToolbarButton[] = [
    {
      icon: Plus,
      label: 'Thêm',
      onClick: onAdd,
      bg: 'bg-green-500',
      hoverBg: 'hover:bg-green-600',
      textColor: 'text-white',
    },
    {
      icon: TableIcon,
      label: 'Mode Excel — Tạo nhanh',
      onClick: onExcelMode,
      bg: 'bg-indigo-500',
      hoverBg: 'hover:bg-indigo-600',
      textColor: 'text-white',
    },
    {
      icon: Wallet,
      label: 'Thanh toán hàng loạt — Mode Excel',
      onClick: onBulkRecordPayment,
      bg: 'bg-green-500',
      hoverBg: 'hover:bg-green-600',
      textColor: 'text-white',
    },
  ];

  const visibleCount = INVOICE_COLUMNS.filter((c) => columnVisibility[c.key]).length;

  return (
    <TooltipProvider>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {/* Search */}
        <div className="relative w-[240px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Tìm kiếm"
            value={searchQuery}
            onChange={(e) => onSearch(e.target.value)}
            className="h-9 pl-8 text-sm"
          />
        </div>

        <div className="flex-1" />

        {/* Icon buttons */}
        <div className="flex items-center gap-1.5">
          {buttons.map((btn) => (
            <Tooltip key={btn.label}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={`h-8 w-8 rounded-full ${btn.bg} ${btn.hoverBg} ${btn.textColor}`}
                  onClick={btn.onClick}
                >
                  <btn.icon className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{btn.label}</TooltipContent>
            </Tooltip>
          ))}

          {/* Hiển thị cột — Popover */}
          <Popover>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-full bg-gray-500 hover:bg-gray-600 text-white"
                    aria-label="Hiển thị cột"
                  >
                    <LayoutGrid className="h-4 w-4" />
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent>Hiển thị cột</TooltipContent>
            </Tooltip>
            <PopoverContent align="end" className="w-64 p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-medium">Hiển thị cột</div>
                <div className="text-xs text-muted-foreground">
                  {visibleCount}/{INVOICE_COLUMNS.length}
                </div>
              </div>
              <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
                {INVOICE_COLUMNS.map((col) => (
                  <Label
                    key={col.key}
                    htmlFor={`col-${col.key}`}
                    className="flex items-center gap-2 py-1 px-1 rounded hover:bg-accent cursor-pointer text-sm font-normal"
                  >
                    <Checkbox
                      id={`col-${col.key}`}
                      checked={columnVisibility[col.key]}
                      onCheckedChange={() => onToggleColumn(col.key)}
                    />
                    <span>{col.label}</span>
                  </Label>
                ))}
              </div>
              <div className="mt-3 pt-2 border-t flex justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={onResetColumns}
                >
                  Đặt lại mặc định
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {/* Bulk actions */}
      {selectedCount > 0 && (
        <div className="flex items-center gap-2 mb-4">
          <span className="text-sm text-muted-foreground">
            Đã chọn {selectedCount} hoá đơn
          </span>
          <Button variant="destructive" size="sm" onClick={onBulkDelete}>
            <Trash2 className="h-4 w-4 mr-1" />
            Xoá hàng loạt
          </Button>
        </div>
      )}
    </TooltipProvider>
  );
};

export default InvoiceListToolbar;
