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
        // Default export logic for CSV (simple fallback)
        if (format === "csv") {
          exportToCSV(data, filename);
        } else {
          toast.info(`Export ${format.toUpperCase()} sẽ được triển khai trong tương lai`);
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
