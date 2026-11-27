import type { ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

/**
 * Tấm trượt từ dưới lên cho màn điện thoại (Radix Dialog: khoá tiêu điểm, Esc, đọc màn hình). Qua portal
 * nên tự mang lớp `.dam` để có token màu/chữ. `busy` = đang gửi lệnh: không cho đóng giữa chừng.
 */
export function MobileSheet({
  open,
  onClose,
  title,
  description,
  busy = false,
  role = "dialog",
  hideHeader = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  busy?: boolean;
  role?: "dialog" | "alertdialog";
  /** Nội dung tự vẽ đầu tấm (vd bước "đã xoá"): tiêu đề vẫn còn cho trình đọc màn hình. */
  hideHeader?: boolean;
  children: ReactNode;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="dam dam-scrim" />
        <DialogPrimitive.Content
          className="dam dam-sheet"
          role={role}
          onEscapeKeyDown={(event) => busy && event.preventDefault()}
          onPointerDownOutside={(event) => busy && event.preventDefault()}
          {...(description ? {} : { "aria-describedby": undefined })}
        >
          <div className="grab" aria-hidden="true" />
          <div className={hideHeader ? "sr-only" : "sheet-hd"}>
            <div className="min-w-0">
              <DialogPrimitive.Title>{title}</DialogPrimitive.Title>
              {description && <DialogPrimitive.Description>{description}</DialogPrimitive.Description>}
            </div>
            {!hideHeader && (
              <DialogPrimitive.Close className="xbtn" aria-label="Đóng" disabled={busy}>
                <X className="h-5 w-5" aria-hidden="true" />
              </DialogPrimitive.Close>
            )}
          </div>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** Màn phủ toàn bộ (mã vừa tạo): vẫn là dialog để khoá tiêu điểm và Esc đóng. */
export function MobileFullScreen({
  open,
  onClose,
  label,
  children,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content className="dam dam-full" aria-describedby={undefined}>
          <DialogPrimitive.Title className="sr-only">{label}</DialogPrimitive.Title>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
