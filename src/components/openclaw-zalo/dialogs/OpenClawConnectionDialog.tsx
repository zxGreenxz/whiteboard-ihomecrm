import type { QrGateState } from "@/lib/openclaw-zalo/connection";
import { QR_TTL_SECONDS } from "@/lib/openclaw-zalo/connection";

/**
 * The QR challenge as the browser holds it: IN MEMORY ONLY.
 *
 * Nothing here may be written to localStorage, sessionStorage, the React Query
 * cache beyond its live query, analytics, or any toast/screenshot text. The parent
 * owns the lifetime and drops it on each of `qrClearReasons()`.
 */
export interface OpenClawQrChallengeView {
  challengeId: string;
  qrPayload: string;
  secondsLeft: number;
  status: "PENDING" | "READY" | "EXPIRED" | "CONSUMED" | "REVOKED";
}

interface OpenClawConnectionDialogProps {
  open: boolean;
  gate: QrGateState;
  accountName: string;
  /** Null until the operator asks for a code, and again the moment it is cleared. */
  challenge: OpenClawQrChallengeView | null;
  pending: boolean;
  onRequestQr: () => void;
  onAcknowledgeDisclosure: () => void;
  onClose: () => void;
}

const BLOCK_COPY: Record<NonNullable<QrGateState["blockedBy"]>, string> = {
  PERMISSION: "Bạn không có quyền quản lý kết nối cho tổ chức này.",
  GLOBAL_STOP: "GLOBAL_STOP đang bật. Gỡ dừng khẩn cấp trước khi quét QR.",
  FEATURE_DISABLED: "OpenClaw Zalo đang tắt cho tổ chức này.",
  ALREADY_CONNECTED: "Tài khoản đang kết nối. Ngắt kết nối trước nếu muốn quét lại.",
  DISCLOSURE: "Cần xác nhận công bố phiên bản hiện hành trước khi quét QR.",
};

const DISCLOSURE_COPY = {
  NEVER_ACKNOWLEDGED: "Bạn chưa xác nhận công bố lần nào cho tài khoản này.",
  VERSION_MOVED: "Công bố đã cập nhật kể từ lần xác nhận gần nhất.",
  LIMITED_RECONNECT: "Phiên bị hạn chế và phải kết nối lại, nên cần xác nhận lại công bố.",
} as const;

export default function OpenClawConnectionDialog({
  open,
  gate,
  accountName,
  challenge,
  pending,
  onRequestQr,
  onAcknowledgeDisclosure,
  onClose,
}: OpenClawConnectionDialogProps) {
  if (!open) return null;
  const blocked = gate.blockedBy;
  const expired = challenge !== null && (challenge.secondsLeft <= 0 || challenge.status === "EXPIRED");

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Kết nối tài khoản Zalo"
      data-openclaw-dialog="connection"
      className="fixed inset-0 z-50 grid place-items-center bg-[#102a43]/40 p-4"
    >
      <section className="w-full max-w-lg border border-[#aebdc8] bg-[#fffdf8] p-5 sm:p-6">
        <header>
          <p className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-[#0f766e]">
            Kết nối OpenClaw Zalo
          </p>
          <h2 className="mt-1 text-xl font-black tracking-[-0.03em]">{accountName}</h2>
          <p className="mt-2 text-sm leading-6 text-[#526777]">
            Quét mã bằng <strong>chính chiếc điện thoại</strong> đang dùng Zalo cho tài khoản này.
            Quét bằng máy khác sẽ đá phiên hiện tại và buộc đăng nhập lại.
          </p>
        </header>

        {blocked !== null && (
          <p
            data-openclaw-blocked={blocked}
            className="mt-4 border border-[#d99a6c] bg-[#fdf0e4] p-3 text-sm font-bold text-[#8a4b12]"
          >
            {BLOCK_COPY[blocked]}
          </p>
        )}

        {blocked === "DISCLOSURE" && gate.disclosure.reason !== null && (
          <div className="mt-3 border border-[#cbd5df] bg-white p-3">
            <p className="text-sm leading-6 text-[#526777]">
              {DISCLOSURE_COPY[gate.disclosure.reason]}
            </p>
            <button
              type="button"
              onClick={onAcknowledgeDisclosure}
              disabled={pending}
              data-openclaw-action="acknowledge-disclosure"
              className="mt-3 min-h-11 w-full border border-[#0f766e] bg-[#0f766e] px-4 text-sm font-bold text-white disabled:opacity-60"
            >
              Xác nhận công bố phiên bản {gate.disclosure.versionToAcknowledge}
            </button>
          </div>
        )}

        {challenge !== null && !expired && (
          <div className="mt-4 border border-[#cbd5df] bg-white p-4 text-center">
            <p
              data-openclaw-qr="payload"
              className="mx-auto max-w-full break-all font-mono text-xs text-[#102a43]"
            >
              {challenge.qrPayload}
            </p>
            <p className="mt-3 text-sm font-bold" data-openclaw-qr="countdown">
              Còn {challenge.secondsLeft}s / {QR_TTL_SECONDS}s
            </p>
            <p className="mt-1 text-xs leading-5 text-[#607585]">
              Mã chỉ nằm trong bộ nhớ trang. Đóng hộp thoại, rời trang hoặc đổi tổ chức là mã bị xoá.
            </p>
          </div>
        )}

        {expired && (
          <p
            data-openclaw-qr="expired"
            className="mt-4 border border-[#aebdc8] bg-white p-3 text-sm font-bold text-[#8a4b12]"
          >
            Mã đã hết hạn. Yêu cầu mã mới để tiếp tục.
          </p>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onRequestQr}
            disabled={!gate.canRequestQr || pending}
            data-openclaw-action="request-qr"
            className="min-h-11 flex-1 border border-[#0f766e] bg-[#0f766e] px-4 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {challenge === null ? "Lấy mã QR" : "Lấy mã mới"}
          </button>
          <button
            type="button"
            onClick={onClose}
            data-openclaw-action="close-connection-dialog"
            className="min-h-11 flex-1 border border-[#9fb0bf] bg-white px-4 text-sm font-bold text-[#102a43]"
          >
            Đóng
          </button>
        </div>
      </section>
    </div>
  );
}
