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
import * as XLSX from "xlsx";

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
          exportToExcel(data, filename);
        } else if (format === "pdf") {
          toast.info(`Export PDF sẽ được triển khai trong tương lai`);
          return; // Don't show success toast for unimplemented features
        }
      }
      toast.success(`Đã xuất file ${format.toUpperCase()} thành công!`);
    } catch (error) {
      console.error("Export error:", error);
      toast.error(`Lỗi khi xuất file ${format.toUpperCase()}`);
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
function exportToExcel(data: any[], filename: string) {
  if (!data || data.length === 0) {
    toast.error("Không có dữ liệu để xuất");
    return;
  }

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
    toast.error("Lỗi khi xuất file Excel");
  }
}

// Simple CSV export helper
function exportToCSV(data: any[], filename: string) {
  if (!data || data.length === 0) {
    toast.error("Không có dữ liệu để xuất");
    return;
  }

  const headers = Object.keys(data[0]);
  const csvContent = [
    headers.join(","),
    ...data.map(row =>
      headers.map(header => {
        const value = row[header];
        // Escape quotes and wrap in quotes if contains comma or newline
        if (typeof value === "string" && (value.includes(",") || value.includes("\n"))) {
          return `"${value.replace(/"/g, '""')}"`;
        }
        return value;
      }).join(",")
    )
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
