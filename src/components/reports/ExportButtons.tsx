import { useState } from "react";
import { Download, FileSpreadsheet, FileText, FileDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";

// xlsx ~430 kB min — dynamic import để không vào bundle đầu; chỉ tải khi
// user bấm Xuất báo cáo.
type XLSXModule = typeof import("xlsx");
let xlsxPromise: Promise<XLSXModule> | null = null;
const getXLSX = (): Promise<XLSXModule> => (xlsxPromise ??= import("xlsx"));

interface ExportButtonsProps {
  data: any[];
  filename: string;
  onExport?: (format: "excel" | "pdf" | "csv") => Promise<void>;
}

export function ExportButtons({ data, filename, onExport }: ExportButtonsProps) {
  const [isExporting, setIsExporting] = useState(false);

  const handleExport = async (format: "excel" | "pdf" | "csv") => {
    setIsExporting(true);
    try {
      if (onExport) {
        await onExport(format);
      } else {
        // Default export logic
        if (format === "csv") {
          exportToCSV(data, filename);
        } else if (format === "excel") {
          await exportToExcel(data, filename);
        } else if (format === "pdf") {
          toast.info(`Export PDF sẽ được triển khai trong tương lai`);
          return; // Don't show success toast for unimplemented features
        }
      }
      toast.success(`Đã xuất file ${format.toUpperCase()} thành công`);
    } catch (error) {
      console.error("Export error:", error);
      toast.error(`Có lỗi xảy ra khi xuất file ${format.toUpperCase()}`);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" disabled={isExporting || !data || data.length === 0}>
          <Download className="mr-2 h-4 w-4" />
          {isExporting ? "Đang xuất..." : "Xuất báo cáo"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel>Chọn định dạng</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => handleExport("excel")}>
          <FileSpreadsheet className="mr-2 h-4 w-4" />
          <span>Excel (.xlsx)</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleExport("pdf")}>
          <FileText className="mr-2 h-4 w-4" />
          <span>PDF (.pdf)</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleExport("csv")}>
          <FileDown className="mr-2 h-4 w-4" />
          <span>CSV (.csv)</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Excel export helper using xlsx library
async function exportToExcel(data: any[], filename: string): Promise<void> {
  if (!data || data.length === 0) {
    toast.error("Không có dữ liệu để xuất");
    return;
  }

  const XLSX = await getXLSX();

  try {
    // Create worksheet from data
    const worksheet = XLSX.utils.json_to_sheet(data);

    // Create workbook and add worksheet
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Báo cáo");

    // Auto-size columns (optional)
    const maxWidth = 50;
    const colWidths = Object.keys(data[0]).map(key => {
      const maxLength = Math.max(
        key.length,
        ...data.map(row => String(row[key] || "").length)
      );
      return { wch: Math.min(maxLength + 2, maxWidth) };
    });
    worksheet["!cols"] = colWidths;

    // Write file
    XLSX.writeFile(workbook, `${filename}.xlsx`);
  } catch (error) {
    console.error("Excel export error:", error);
    toast.error("Có lỗi xảy ra khi xuất file Excel");
  }
}

/**
 * Một ô CSV an toàn cho Excel/Sheets.
 *
 * Hai vấn đề tách bạch, phải xử cả hai:
 *
 *  1. **Thoát chuỗi.** Bản cũ chỉ bọc nháy khi ô có dấu phẩy hoặc xuống dòng.
 *     Một ô CÓ dấu nháy mà không có phẩy thì đi ra trần trụi, và dấu nháy lẻ đó
 *     nuốt toàn bộ phần còn lại của file vào một ô — che sạch những dòng bên
 *     dưới. Nay bọc nháy MỌI chuỗi và nhân đôi nháy bên trong.
 *
 *  2. **Tiêm công thức.** Ô bắt đầu bằng `=` `+` `-` `@` (hoặc tab/CR) được
 *     Excel chạy như công thức — bọc nháy KHÔNG chặn được. Điều này đáng lo ở
 *     đây vì `log_public_room_events` mở cho `anon`: ai cầm link `/r/<token>`
 *     cũng ghi được thông điệp lỗi tuỳ ý, và nó chảy thẳng vào file mà chủ nhà
 *     mở bằng Excel. Nay chèn dấu nháy đơn dẫn đầu để Excel coi là văn bản.
 */
export function oCsvAnToan(value: unknown): string {
  if (value == null) return "";
  const s = String(value);
  const canDanNhay = /^[=+\-@\t\r]/.test(s);
  return `"${(canDanNhay ? "'" + s : s).replace(/"/g, '""')}"`;
}

// Simple CSV export helper
function exportToCSV(data: any[], filename: string) {
  if (!data || data.length === 0) {
    toast.error("Không có dữ liệu để xuất");
    return;
  }

  const headers = Object.keys(data[0]);
  const csvContent = [
    headers.map(oCsvAnToan).join(","),
    ...data.map(row => headers.map(header => oCsvAnToan(row[header])).join(","))
  ].join("\n");

  const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${filename}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
