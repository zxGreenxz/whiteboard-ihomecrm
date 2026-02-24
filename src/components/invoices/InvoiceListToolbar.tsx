import { Button } from '@/components/ui/button';
import {
  Plus,
  Upload,
  Sparkles,
  ImageDown,
  FileDown,
  CheckCircle,
  Trash2,
} from 'lucide-react';

interface InvoiceListToolbarProps {
  selectedCount: number;
  onAdd: () => void;
  onImport: () => void;
  onAutoGenerate: () => void;
  onBulkDownloadImages: () => void;
  onBulkDownloadPDF: () => void;
  onBulkApprove: () => void;
  onBulkDelete: () => void;
}

const InvoiceListToolbar = ({
  selectedCount,
  onAdd,
  onImport,
  onAutoGenerate,
  onBulkDownloadImages,
  onBulkDownloadPDF,
  onBulkApprove,
  onBulkDelete,
}: InvoiceListToolbarProps) => {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-4">
      <Button onClick={onAdd} size="sm">
        <Plus className="h-4 w-4 mr-1" />
        Thêm
      </Button>

      <Button variant="outline" size="sm" onClick={onImport}>
        <Upload className="h-4 w-4 mr-1" />
        Nhập dữ liệu
      </Button>

      <Button variant="outline" size="sm" onClick={onAutoGenerate}>
        <Sparkles className="h-4 w-4 mr-1" />
        Sinh hoá đơn
      </Button>

      <div className="hidden sm:block h-6 w-px bg-border mx-1" />

      <Button variant="outline" size="sm" onClick={onBulkDownloadImages}>
        <ImageDown className="h-4 w-4 mr-1" />
        Tải hàng loạt ảnh
      </Button>

      <Button variant="outline" size="sm" onClick={onBulkDownloadPDF}>
        <FileDown className="h-4 w-4 mr-1" />
        Tải hàng loạt PDF
      </Button>

      {selectedCount > 0 && (
        <>
          <div className="hidden sm:block h-6 w-px bg-border mx-1" />

          <Button variant="default" size="sm" onClick={onBulkApprove}>
            <CheckCircle className="h-4 w-4 mr-1" />
            Duyệt hàng loạt ({selectedCount})
          </Button>

          <Button variant="destructive" size="sm" onClick={onBulkDelete}>
            <Trash2 className="h-4 w-4 mr-1" />
            Xoá hàng loạt ({selectedCount})
          </Button>
        </>
      )}
    </div>
  );
};

export default InvoiceListToolbar;
