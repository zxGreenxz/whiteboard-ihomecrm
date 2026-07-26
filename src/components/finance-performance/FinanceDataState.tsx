import { AlertCircle, Inbox, RefreshCw } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface FinanceQueryErrorProps {
  title?: string;
  error?: unknown;
  onRetry: () => void;
}

interface FinanceEmptyStateProps {
  title: string;
  description: string;
}

interface FinanceLoadingGridProps {
  count?: number;
}

function getSafeErrorDescription(error: unknown) {
  const errorRecord =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : null;
  const code =
    typeof errorRecord?.code === "string" ? errorRecord.code.toLowerCase() : "";
  const status =
    typeof errorRecord?.status === "number" ? errorRecord.status : null;
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : typeof errorRecord?.message === "string"
          ? errorRecord.message
          : "";
  const normalizedMessage = rawMessage.toLowerCase();

  if (
    status === 401 ||
    status === 403 ||
    code === "42501" ||
    normalizedMessage.includes("permission denied") ||
    normalizedMessage.includes("not authorized") ||
    normalizedMessage.includes("forbidden")
  ) {
    return "Bạn không có quyền xem phạm vi dữ liệu này. Hãy kiểm tra quyền truy cập hoặc chọn phạm vi khác.";
  }

  if (
    normalizedMessage.includes("timeout") ||
    normalizedMessage.includes("timed out") ||
    normalizedMessage.includes("statement timeout")
  ) {
    return "Yêu cầu mất quá nhiều thời gian. Vui lòng thử lại hoặc thu hẹp phạm vi báo cáo.";
  }

  if (
    normalizedMessage.includes("failed to fetch") ||
    normalizedMessage.includes("network") ||
    normalizedMessage.includes("connection")
  ) {
    return "Không thể kết nối tới nguồn dữ liệu. Vui lòng kiểm tra kết nối và thử lại.";
  }

  return "Dữ liệu chưa thể tải vào lúc này. Không có số 0 thay thế được hiển thị; vui lòng thử lại.";
}

export function FinanceQueryError({
  title = "Không thể tải dữ liệu",
  error,
  onRetry,
}: FinanceQueryErrorProps) {
  return (
    <Alert variant="destructive">
      <AlertCircle aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="flex flex-col gap-3">
        <p>{getSafeErrorDescription(error)}</p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw data-icon="inline-start" aria-hidden="true" />
          Thử lại
        </Button>
      </AlertDescription>
    </Alert>
  );
}

export function FinanceEmptyState({
  title,
  description,
}: FinanceEmptyStateProps) {
  return (
    <Card role="status" className="border-dashed bg-muted/20 shadow-none">
      <CardHeader className="min-h-48 items-center justify-center gap-3 px-6 py-10 text-center">
        <span className="rounded-full bg-muted p-3 text-muted-foreground">
          <Inbox className="size-6" aria-hidden="true" />
        </span>
        <div className="flex max-w-md flex-col gap-1">
          <CardTitle className="text-base">{title}</CardTitle>
          <CardDescription className="leading-relaxed">
            {description}
          </CardDescription>
        </div>
      </CardHeader>
    </Card>
  );
}

export function FinanceLoadingGrid({ count = 4 }: FinanceLoadingGridProps) {
  const safeCount = Number.isFinite(count)
    ? Math.min(12, Math.max(1, Math.floor(count)))
    : 4;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="flex flex-col gap-3"
    >
      <span className="sr-only">Đang tải dữ liệu tài chính</span>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: safeCount }, (_, index) => (
          <Card key={`finance-loading-${index}`}>
            <CardHeader className="flex-row items-center justify-between gap-4 p-5 pb-0">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="size-8 rounded-full" />
            </CardHeader>
            <CardContent className="flex flex-col gap-4 p-5">
              <Skeleton className="h-8 w-36" />
              <Skeleton className="h-3 w-3/4" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
