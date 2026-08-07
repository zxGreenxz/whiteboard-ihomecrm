import type { QrGateState } from "@/lib/openclaw-zalo/connection";
import { QR_TTL_SECONDS, qrLifetimeIsAnomalous } from "@/lib/openclaw-zalo/connection";

/**
 * The QR as the browser holds it: IN MEMORY ONLY.
 *
 * `pngDataUrl` is the decrypted image, which exists only after a CONSUME through
 * the `openclaw-qr` Edge function. It is never written to localStorage,
 * sessionStorage, the React Query cache, analytics, or any toast text; the parent
 * owns its lifetime and drops it on every reason in `qrClearReasons()`.
 */
export interface OpenClawQrChallengeView {
  challengeId: string;
  /** Null while the challenge is still PENDING and there is nothing to scan yet. */
  pngDataUrl: string | null;
  secondsLeft: number;
  status: "PENDING" | "READY" | "EXPIRED" | "CONSUMED" | "REVOKED";
}

interface OpenClawConnectionDialogProps {
  open: boolean;
  gate: QrGateState;
  accountName: string;
  challenge: OpenClawQrChallengeView | null;
  pending: boolean;
  /** Whatever the Edge function or RPC last refused with, shown verbatim-ish. */
  errorMessage: string | null;
  onRequestQr: () => void;
  onAcknowledgeDisclosure: () => void;
  /**
   * Omitted when the viewer cannot manage connections, so the button is absent
   * rather than present-and-refused.
   */
  onDisconnect?: () => void;
  onClose: () => void;
}

const BLOCK_COPY: Record<NonNullable<QrGateState["blockedBy"]>, string> = {
  PERMISSION: "Bạn không có quyền quản lý kết nối cho tổ chức này.",
  ALREADY_CONNECTED: "Tài khoản đang kết nối. Ngắt kết nối trước nếu muốn quét lại.",
  UNRECOVERABLE_STATE:
    "Phiên đang ở trạng thái không thể tự khôi phục từ giao diện. Cần can thiệp vận hành "
    + "để đưa tài khoản về trạng thái ngắt kết nối trước khi quét mã mới.",
  NO_READY_CELL: "Chưa có cell runtime nào sẵn sàng cho tài khoản này.",
  DISCLOSURE: "Cần xác nhận công bố phiên bản hiện hành trước khi quét QR.",
};

const DISCLOSURE_COPY = {
  NEVER_ACKNOWLEDGED: "Bạn chưa xác nhận công bố lần nào cho tài khoản này.",
  VERSION_MOVED: "Công bố đã cập nhật kể từ lần xác nhận gần nhất.",
} as const;

export default function OpenClawConnectionDialog({
  open,
  gate,
  accountName,
  challenge,
  pending,
  errorMessage,
  onRequestQr,
  onAcknowledgeDisclosure,
  onDisconnect,
  onClose,
}: OpenClawConnectionDialogProps) {
  if (!open) return null;
  const blocked = gate.blockedBy;
  const expired = challenge !== null
    && (challenge.secondsLeft <= 0 || challenge.status === "EXPIRED" || challenge.status === "REVOKED");
  const scannable = challenge !== null && !expired && challenge.pngDataUrl !== null;

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

        {/*
          The way OUT of the state the copy above just told the owner to leave.
          Without it the dialog said "Ngắt kết nối trước nếu muốn quét lại" while
          offering no way to do that: no production file called the disconnect path
          at all, so a connected account could never be re-linked.
        */}
        {blocked === "ALREADY_CONNECTED" && onDisconnect !== undefined && (
          <button
            type="button"
            data-openclaw-action="disconnect"
            disabled={pending}
            onClick={onDisconnect}
            className="mt-3 w-full border border-[#b4443a] bg-white px-4 py-2 text-sm font-bold text-[#b4443a] disabled:opacity-60"
          >
            Ngắt kết nối tài khoản
          </button>
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

        {errorMessage !== null && (
          <p
            data-openclaw-qr="error"
            className="mt-4 border border-[#c0563a] bg-[#fdeceb] p-3 text-sm font-bold text-[#8a2f1c]"
          >
            {errorMessage}
          </p>
        )}

        {challenge !== null && !expired && (
          <div className="mt-4 border border-[#cbd5df] bg-white p-4 text-center">
            {scannable ? (
              <img
                src={challenge.pngDataUrl!}
                alt="Mã QR đăng nhập Zalo"
                data-openclaw-qr="image"
                className="mx-auto h-56 w-56 max-w-full"
              />
            ) : (
              <p data-openclaw-qr="waiting" className="py-16 text-sm text-[#607585]">
                Đang chờ máy chủ phát mã…
              </p>
            )}
            <p className="mt-3 text-sm font-bold" data-openclaw-qr="countdown">
              Còn {challenge.secondsLeft}s
            </p>
            {qrLifetimeIsAnomalous(challenge.secondsLeft) && (
              <p
                data-openclaw-qr="lifetime-anomaly"
                className="mt-1 text-xs font-bold leading-5 text-[#8a4b12]"
              >
                Mã này sống lâu hơn {QR_TTL_SECONDS}s thông thường. Đóng hộp thoại nếu bạn không
                chủ động yêu cầu, rồi báo vận hành.
              </p>
            )}
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
