import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface ChartCardProps {
  title: string;
  /** Slot góc phải header (vd ExportButtons). */
  action?: ReactNode;
  loading?: boolean;
  empty?: boolean;
  /** Chiều cao vùng nội dung khi loading/empty (px). */
  height?: number;
  /** Dòng chú thích nhỏ dưới nội dung (vd cảnh báo chất lượng dữ liệu). */
  footnote?: ReactNode;
  children: ReactNode;
}

/** Card bọc chuẩn cho mọi chart/bảng của trang phân tích. */
export function ChartCard({
  title,
  action,
  loading,
  empty,
  height = 320,
  footnote,
  children,
}: ChartCardProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
        {action}
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="w-full" style={{ height }} />
        ) : empty ? (
          <div
            className="grid place-items-center text-sm text-muted-foreground"
            style={{ height }}
          >
            Chưa có dữ liệu
          </div>
        ) : (
          children
        )}
        {footnote && !loading && <div className="mt-2">{footnote}</div>}
      </CardContent>
    </Card>
  );
}
