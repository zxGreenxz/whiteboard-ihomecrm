import { Fingerprint, KeyRound, PowerOff } from "lucide-react";

/**
 * Hai trạng thái trước khi có dữ liệu (chủ chốt 21/10 điểm 7–8): chưa kết nối SmartLife, và
 * quản trị đã tắt hẳn kết nối. Không gọi thêm gì xuống máy chủ ở hai trạng thái này.
 */

export function NotConnectedState({ otherOrganization }: { otherOrganization: boolean }) {
  return (
    <section aria-labelledby="door-not-connected" className="mx-auto max-w-2xl rounded-2xl border bg-card p-5 sm:p-7">
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <KeyRound className="h-6 w-6" aria-hidden="true" />
        </span>
        <div>
          <h2 id="door-not-connected" className="text-lg font-semibold">
            Chưa kết nối SmartLife
          </h2>
          <p className="text-sm text-muted-foreground">
            {otherOrganization
              ? "Tài khoản SmartLife trên máy chủ đang gắn với công ty khác. Mỗi công ty dùng một tài khoản SmartLife riêng."
              : "CRM chưa có khoá truy cập tài khoản SmartLife của công ty nên chưa đọc được máy cửa."}
          </p>
        </div>
      </div>
      <p className="mt-5 text-sm font-medium">Chủ công ty làm một lần:</p>
      <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm">
        <li>
          Đăng nhập <span className="font-medium">platform.tuya.com</span> bằng tài khoản công ty, tạo một Cloud project và chọn
          đúng <span className="font-medium">Data Center</span> trùng khu vực của tài khoản SmartLife.
        </li>
        <li>
          Trong project mở <span className="font-medium">Devices → Link Tuya App Account</span> để hiện mã QR. Trên điện thoại mở app
          SmartLife → <span className="font-medium">Tôi</span> → biểu tượng quét ở góc trên, quét mã đó để liên kết tài khoản.
        </li>
        <li>
          Gửi <span className="font-medium">Access ID</span> và <span className="font-medium">Access Secret</span> của project cho quản trị
          hệ thống qua kênh riêng (không gửi vào nhóm chat chung) để nạp vào máy chủ.
        </li>
      </ol>
      <p className="mt-4 flex items-start gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
        <Fingerprint className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        Sau khi nạp khoá, trang chạy chế độ chỉ đọc trước để kiểm trên máy thật rồi mới mở thao tác.
      </p>
    </section>
  );
}

export function ModeOffState() {
  return (
    <section aria-labelledby="door-mode-off" className="mx-auto max-w-2xl rounded-2xl border bg-card p-5 sm:p-7">
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <PowerOff className="h-6 w-6" aria-hidden="true" />
        </span>
        <div>
          <h2 id="door-mode-off" className="text-lg font-semibold">
            Cửa vân tay đang tắt
          </h2>
          <p className="text-sm text-muted-foreground">
            Quản trị hệ thống đã tạm tắt kết nối SmartLife. Máy cửa vẫn hoạt động bình thường; CRM chỉ tạm không đọc và không
            thao tác.
          </p>
        </div>
      </div>
    </section>
  );
}
