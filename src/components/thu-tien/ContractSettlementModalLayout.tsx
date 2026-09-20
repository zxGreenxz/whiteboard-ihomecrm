import { useRef, type ReactNode, type RefObject } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { LoaderCircle, X } from "lucide-react";
import { Dialog, DialogDescription, DialogOverlay, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import "./contract-settlement.css";

export interface ContractSettlementModalLayoutProps {
  open: boolean;
  onClose: () => void;
  /** Includes write, refresh, and any unresolved result; controlled by the common action host. */
  dismissalBlocked?: boolean;
  /** A stable focusable list heading/tab when processing removes the originating row. */
  fallbackFocusRef?: RefObject<HTMLElement>;
  kindLabel: string;
  roomLabel: string;
  codeLine: string;
  subjectLabel: string;
  metadata: ReactNode;
  amountSummary?: ReactNode;
  timeline: ReactNode;
  children: ReactNode;
  aside: ReactNode;
}

/** Shared visual shell for voucher/source/event detail. No action or identity resolution happens here. */
export function ContractSettlementModalLayout({ open, onClose, dismissalBlocked = false, fallbackFocusRef, kindLabel, roomLabel, codeLine, subjectLabel, metadata, amountSummary, timeline, children, aside }: ContractSettlementModalLayoutProps) {
  const openerRef = useRef<HTMLElement | null>(null);
  return <Dialog open={open} onOpenChange={next => { if (!next && !dismissalBlocked) onClose(); }}>
    <DialogPortal>
      <DialogOverlay className="bg-[#1b1813]/55" />
      <DialogPrimitive.Content className="contract-settlement cs-modal"
        onOpenAutoFocus={() => { openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
        onCloseAutoFocus={event => {
          event.preventDefault();
          const target = openerRef.current?.isConnected ? openerRef.current : fallbackFocusRef?.current;
          target?.focus({ preventScroll: true });
        }}
        onPointerDownOutside={event => event.preventDefault()}
        onInteractOutside={event => event.preventDefault()}
        onEscapeKeyDown={event => { if (dismissalBlocked) event.preventDefault(); }}>
        <div className="cs-modal-header">
          <div className="cs-modal-heading">
            <div className="cs-code">{codeLine}</div>
            <DialogTitle className="cs-modal-title">{kindLabel} <span>/</span> <b className="cs-mono">{roomLabel}</b></DialogTitle>
            <div className="cs-modal-metadata">{metadata}</div>
          </div>
          <div className="cs-modal-header-right">
            {amountSummary && <div className="cs-modal-amount">{amountSummary}</div>}
            <button type="button" className="cs-modal-close" aria-label="Đóng hồ sơ" disabled={dismissalBlocked} onClick={onClose}><X size={16} aria-hidden="true" /></button>
          </div>
        </div>
        <DialogDescription className="cs-modal-subject">{subjectLabel}</DialogDescription>
        <div className="cs-modal-scroll">
          <section className="cs-modal-timeline" aria-label="Vòng đời hợp đồng của phòng">{timeline}</section>
          <div className="cs-modal-body cs-modal-content">
            <div className="cs-modal-main">{children}</div>
            <aside className="cs-modal-aside" aria-label="Thông tin phiếu và xử lý">{aside}</aside>
          </div>
        </div>
        <div className="cs-modal-footer" role={dismissalBlocked ? "status" : undefined}>
          {dismissalBlocked ? <><LoaderCircle size={14} className="animate-spin" aria-hidden="true" />Đang xử lý hoặc xác minh kết quả. Vui lòng chờ trước khi đóng hồ sơ.</> : "Hợp đồng khác trong dòng thời gian dùng để đối chiếu. Thao tác áp dụng cho hồ sơ đang mở."}
        </div>
      </DialogPrimitive.Content>
    </DialogPortal>
  </Dialog>;
}
