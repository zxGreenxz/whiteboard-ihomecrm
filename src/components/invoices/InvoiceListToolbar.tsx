import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useToast } from '@/hooks/use-toast';
import {
  Plus,
  Send,
  Sparkles,
  FileDown,
  ImageDown,
  Upload,
  Download,
  LayoutGrid,
  Filter,
  Search,
  CheckCircle,
  Trash2,
  Table as TableIcon,
} from 'lucide-react';

interface InvoiceListToolbarProps {
  selectedCount: number;
  searchQuery: string;
  onSearch: (query: string) => void;
  onAdd: () => void;
  onImport: () => void;
  onAutoGenerate: () => void;
  onExcelMode: () => void;
  onDownloadImage: () => void;
  onBulkApprove: () => void;
  onBulkDelete: () => void;
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
  onImport,
  onAutoGenerate,
  onExcelMode,
  onDownloadImage,
  onBulkApprove,
  onBulkDelete,
}: InvoiceListToolbarProps) => {
  const { toast } = useToast();

  const showTodo = (feature: string) => {
    console.log(`TODO: ${feature}`);
    toast({ title: 'Tính năng đang phát triển', description: feature });
  };

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
      icon: Send,
      label: 'Gửi hoá đơn',
      onClick: () => showTodo('Gửi hoá đơn'),
      bg: 'bg-blue-500',
      hoverBg: 'hover:bg-blue-600',
      textColor: 'text-white',
    },
    {
      icon: Sparkles,
      label: 'Sinh hoá đơn',
      onClick: onAutoGenerate,
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
      icon: FileDown,
      label: 'Tải hoá đơn PDF',
      onClick: () => showTodo('Tải hoá đơn PDF'),
      bg: 'bg-blue-500',
      hoverBg: 'hover:bg-blue-600',
      textColor: 'text-white',
    },
    {
      icon: ImageDown,
      label: 'Tải ảnh hoá đơn',
      onClick: onDownloadImage,
      bg: 'bg-purple-500',
      hoverBg: 'hover:bg-purple-600',
      textColor: 'text-white',
    },
    {
      icon: Upload,
      label: 'Nhập dữ liệu',
      onClick: onImport,
      bg: 'bg-orange-500',
      hoverBg: 'hover:bg-orange-600',
      textColor: 'text-white',
    },
    {
      icon: Download,
      label: 'Xuất dữ liệu',
      onClick: () => showTodo('Xuất dữ liệu'),
      bg: 'bg-teal-500',
      hoverBg: 'hover:bg-teal-600',
      textColor: 'text-white',
    },
    {
      icon: LayoutGrid,
      label: 'Hiển thị cột',
      onClick: () => showTodo('Hiển thị cột'),
      bg: 'bg-gray-500',
      hoverBg: 'hover:bg-gray-600',
      textColor: 'text-white',
    },
    {
      icon: Filter,
      label: 'Lọc dữ liệu',
      onClick: () => showTodo('Lọc dữ liệu'),
      bg: 'bg-gray-500',
      hoverBg: 'hover:bg-gray-600',
      textColor: 'text-white',
    },
  ];

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
        </div>
      </div>

      {/* Bulk actions */}
      {selectedCount > 0 && (
        <div className="flex items-center gap-2 mb-4">
          <span className="text-sm text-muted-foreground">
            Đã chọn {selectedCount} hoá đơn
          </span>
          <Button size="sm" onClick={onBulkApprove}>
            <CheckCircle className="h-4 w-4 mr-1" />
            Duyệt hàng loạt
          </Button>
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
