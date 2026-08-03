import type { LucideIcon } from "lucide-react";
import {
  CircleAlert,
  ClockAlert,
  CloudOff,
  Inbox,
  LoaderCircle,
  ShieldAlert,
  Unplug,
  UserRoundX,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type OpenClawBoundaryKind =
  | "loading"
  | "no-account"
  | "no-permission"
  | "disconnected"
  | "stale-cell"
  | "partial-outage"
  | "empty-inbox"
  | "fatal-error";

interface BoundaryDefinition {
  title: string;
  message: string;
  icon: LucideIcon;
  tone: "neutral" | "warning" | "danger";
}

const BOUNDARIES: Record<OpenClawBoundaryKind, BoundaryDefinition> = {
  loading: {
    title: "Đang xác minh quyền truy cập",
    message: "Hệ thống đang tải tổ chức và trạng thái OpenClaw Zalo.",
    icon: LoaderCircle,
    tone: "neutral",
  },
  "no-account": {
    title: "Chưa có tài khoản Zalo Personal",
    message: "Tổ chức này chưa kết nối tài khoản. Người có quyền quản lý kết nối có thể bắt đầu quy trình QR.",
    icon: UserRoundX,
    tone: "warning",
  },
  "no-permission": {
    title: "Bạn không có quyền truy cập",
    message: "Quyền xem OpenClaw Zalo chưa được cấp cho tổ chức đã chọn.",
    icon: ShieldAlert,
    tone: "danger",
  },
  disconnected: {
    title: "Tài khoản đang ngắt kết nối",
    message: "Tin nhắn gửi đi đang dừng. Kiểm tra phiên trước khi tiếp tục vận hành.",
    icon: Unplug,
    tone: "warning",
  },
  "stale-cell": {
    title: "Cell không còn cập nhật",
    message: "Heartbeat đã quá hạn; outbound phải giữ trạng thái dừng cho tới khi cell phục hồi.",
    icon: ClockAlert,
    tone: "danger",
  },
  "partial-outage": {
    title: "Dịch vụ đang suy giảm một phần",
    message: "Supabase hoặc R2 chưa sẵn sàng. Dữ liệu lỗi được giữ nguyên và không bị thay bằng danh sách trống.",
    icon: CloudOff,
    tone: "warning",
  },
  "empty-inbox": {
    title: "Hộp thư đang trống",
    message: "Chưa có hội thoại trong phạm vi tài khoản đang chọn.",
    icon: Inbox,
    tone: "neutral",
  },
  "fatal-error": {
    title: "Không thể tải OpenClaw Zalo",
    message: "Đã xảy ra lỗi không thể tiếp tục. Hãy thử tải lại dữ liệu thay vì thao tác trên trạng thái chưa đầy đủ.",
    icon: CircleAlert,
    tone: "danger",
  },
};

interface OpenClawBoundaryStateProps {
  state: OpenClawBoundaryKind;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
  compact?: boolean;
}

export default function OpenClawBoundaryState({
  state,
  message,
  actionLabel,
  onAction,
  compact = false,
}: OpenClawBoundaryStateProps) {
  const definition = BOUNDARIES[state];
  const Icon = definition.icon;

  return (
    <section
      data-boundary-state={state}
      role={definition.tone === "danger" ? "alert" : "status"}
      className={cn(
        "mx-auto flex w-full max-w-2xl flex-col items-center border border-[#cbd5df] bg-[#fffdf8] text-center text-[#102a43]",
        compact ? "gap-3 p-5" : "gap-4 px-6 py-10",
      )}
    >
      <span
        className={cn(
          "grid h-12 w-12 place-items-center rounded-full border",
          definition.tone === "neutral" && "border-[#9fb0bf] bg-[#edf4f2] text-[#176b5b]",
          definition.tone === "warning" && "border-[#d8a33b] bg-[#fff5d8] text-[#8a5b00]",
          definition.tone === "danger" && "border-[#d05c52] bg-[#fff0ed] text-[#a52b24]",
        )}
      >
        <Icon className={cn("h-6 w-6", state === "loading" && "animate-spin")} aria-hidden="true" />
      </span>
      <div className="space-y-1.5">
        <h2 className="text-lg font-bold tracking-[-0.01em]">{definition.title}</h2>
        <p className="text-sm leading-6 text-[#526777]">{message ?? definition.message}</p>
      </div>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="min-h-11 border border-[#17324d] bg-[#17324d] px-5 py-2 text-sm font-semibold text-white hover:bg-[#244a69] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f766e] focus-visible:ring-offset-2"
        >
          {actionLabel}
        </button>
      )}
    </section>
  );
}
