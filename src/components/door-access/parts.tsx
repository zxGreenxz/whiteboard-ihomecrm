import type { ReactNode } from "react";
// Chỉ dùng icon đã nằm trong chunk dùng chung/entry: icon mới dùng chung với đúng MỘT trang khác sẽ tách
// thành chunk riêng và làm dài danh sách preload trong chunk entry (đang sát ngưỡng).
import { AlertTriangle, CheckCircle2, Info, RefreshCw, ShieldAlert } from "lucide-react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { isDoorAccessError } from "@/lib/door-access/errors";
import { LOG_PENDING_TEXT } from "@/lib/door-access/view";
import { cn } from "@/lib/utils";

/** Khung lỗi tại chỗ: nói rõ đây là lỗi QUYỀN, MẠNG hay DỮ LIỆU, kèm nút thử lại khi đáng thử. */
export function ErrorPanel({ error, title, onRetry, className }: { error: unknown; title: string; onRetry?: () => void; className?: string }) {
  const doorError = isDoorAccessError(error) ? error : null;
  const kind = doorError?.kind ?? "internal";
  const heading =
    kind === "permission"
      ? "Bạn chưa có quyền xem mục này"
      : kind === "unavailable"
        ? "Mất kết nối"
        : kind === "not_deployed"
          ? "Chưa có chức năng trên máy chủ"
          : kind === "session"
            ? "Phiên đăng nhập đã đổi"
            : title;
  const Icon = kind === "permission" ? ShieldAlert : AlertTriangle;
  const message = doorError?.message ?? "Chưa tải được dữ liệu. Thử lại sau.";
  const canRetry = Boolean(onRetry) && kind !== "permission" && kind !== "not_deployed";
  return (
    <div role="alert" className={cn("rounded-xl border border-destructive/25 bg-destructive/5 p-4", className)}>
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{heading}</p>
          <p className="mt-1 break-words text-sm text-muted-foreground">{message}</p>
          {canRetry && (
            <Button type="button" variant="outline" size="sm" className="mt-3" onClick={onRetry}>
              <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden="true" />
              Thử lại
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export type NoticeTone = "success" | "warning" | "error" | "info";

const TONE: Record<NoticeTone, { box: string; Icon: typeof Info }> = {
  success: { box: "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100", Icon: CheckCircle2 },
  warning: { box: "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100", Icon: AlertTriangle },
  error: { box: "border-destructive/30 bg-destructive/5 text-foreground", Icon: AlertTriangle },
  info: { box: "border-border bg-muted/40 text-foreground", Icon: Info },
};

/** Dòng báo kết quả ngay tại chỗ thao tác. */
export function Notice({ tone, children, className }: { tone: NoticeTone; children: ReactNode; className?: string }) {
  const { box, Icon } = TONE[tone];
  return (
    <div role={tone === "error" || tone === "warning" ? "alert" : "status"} className={cn("flex items-start gap-2 rounded-lg border px-3 py-2 text-sm", box, className)}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1 break-words">{children}</div>
    </div>
  );
}

/** Kết quả một thao tác ghi, kèm cờ hàm Edge chưa chốt được nhật ký (`logPending`). */
export interface ActionResult {
  tone: NoticeTone;
  text: string;
  logPending?: boolean;
}

/** Dòng kết quả + (nếu có) dòng trung tính "nhật ký chưa chốt được" ngay dưới. */
export function ActionNotice({ result, className }: { result: ActionResult; className?: string }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Notice tone={result.tone}>{result.text}</Notice>
      {result.logPending && <Notice tone="info">{LOG_PENDING_TEXT}</Notice>}
    </div>
  );
}

/**
 * Nút thao tác có lý do bị khoá (chỉ đọc, chưa gắn người dùng trên máy…). Lý do hiện bằng tooltip
 * và cả `title` (điện thoại không có hover) — nút khoá thì không nhận sự kiện nên bọc trong span.
 */
export function GuardedButton({ disabledReason, children, ...props }: ButtonProps & { disabledReason?: string | null }) {
  if (!disabledReason) return <Button {...props}>{children}</Button>;
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} title={disabledReason} className="inline-flex">
            <Button {...props} disabled aria-disabled="true">
              {children}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{disabledReason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-base font-semibold">{children}</h2>
      {action}
    </div>
  );
}

/** Nhãn nhỏ dạng viên thuốc, màu theo nghĩa. */
export function Pill({ tone = "muted", children }: { tone?: "muted" | "green" | "red" | "amber" | "blue"; children: ReactNode }) {
  const color = {
    muted: "bg-muted text-muted-foreground",
    green: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200",
    red: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200",
    amber: "bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-100",
    blue: "bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-100",
  }[tone];
  return <span className={cn("inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium", color)}>{children}</span>;
}
