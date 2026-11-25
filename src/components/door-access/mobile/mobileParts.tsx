import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, Loader2, RefreshCw, ShieldAlert } from "lucide-react";

import { isDoorAccessError } from "@/lib/door-access/errors";

/** Phần nhỏ dùng chung của màn điện thoại — cùng nghĩa với parts.tsx (máy tính), khác vỏ. */

export type MobileTone = "info" | "warn" | "danger" | "ok";

const ICON: Record<MobileTone, typeof Info> = { info: Info, warn: AlertTriangle, danger: AlertTriangle, ok: CheckCircle2 };

export function MobileNotice({ tone, children }: { tone: MobileTone; children: ReactNode }) {
  const Icon = ICON[tone];
  return (
    <div className={`note note-${tone}`} role={tone === "danger" || tone === "warn" ? "alert" : "status"}>
      <Icon aria-hidden="true" />
      <div className="min-w-0 flex-1 break-words">{children}</div>
    </div>
  );
}

export function MobileLoading({ text }: { text: string }) {
  return (
    <div className="card empty flex items-center justify-center gap-2" role="status">
      <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      {text}
    </div>
  );
}

/** Lỗi tải tại chỗ: nói rõ QUYỀN, MẠNG hay DỮ LIỆU; chỉ cho thử lại khi đáng thử. */
export function MobileError({ error, title, onRetry }: { error: unknown; title: string; onRetry?: () => void }) {
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
  const canRetry = Boolean(onRetry) && kind !== "permission" && kind !== "not_deployed";
  return (
    <div className="note note-danger" role="alert">
      <Icon aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="m-0 font-bold">{heading}</p>
        <p className="m-0 mt-0.5 break-words">{doorError?.message ?? "Chưa tải được dữ liệu. Thử lại sau."}</p>
        {canRetry && (
          <button type="button" className="btn btn-ghost btn-sm mt-2" onClick={onRetry}>
            <RefreshCw aria-hidden="true" />
            Thử lại
          </button>
        )}
      </div>
    </div>
  );
}

/** Kết quả một thao tác ghi + dòng "nhật ký chưa chốt được" nếu có. */
export interface MobileResult {
  tone: MobileTone;
  text: string;
  logPending?: boolean;
}

export function MobileResultNotice({ result }: { result: MobileResult }) {
  return (
    <>
      <MobileNotice tone={result.tone}>{result.text}</MobileNotice>
      {result.logPending && <MobileNotice tone="info">Nhật ký thao tác chưa chốt được — kiểm lại ở Quản lý › Nhật ký.</MobileNotice>}
    </>
  );
}
