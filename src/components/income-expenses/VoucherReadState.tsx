import { Loader2, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Màn chi tiết phiếu/đợt khi CHƯA có bản đọc đầy đủ vừa tải. Ràng buộc đợt
 * 28/09/2026 giữ nguyên: lúc này không hiện dữ liệu phiếu nào, kể cả từ cache.
 *
 * Chủ chụp 30/09/2026: màn cũ là khung trắng toàn màn hình, chữ trơn và hai nút
 * không kiểu dính nhau "Thử lạiĐóng" — đang tải bình thường mà trông như trang
 * lỗi. Nay đang tải thì giữ đúng khung tấm phiếu (tiêu đề, nút đóng, khung
 * xương) và KHÔNG mời "Thử lại"; chỉ khi đọc hỏng mới có nút Thử lại/Đóng.
 */
interface ReadStateProps {
  title: string;
  loading: boolean;
  message: string;
  onRetry: () => void;
  onClose: () => void;
}

/** Độ dài giả của từng dòng khung xương — lệch nhau cho giống bảng thật. */
const SKELETON_WIDTHS = ["62%", "48%", "70%", "40%", "56%"];

/** Bản điện thoại: bottom-sheet trong khung .cm-app (financeMobile.css). */
export function VoucherSheetReadState({
  title,
  loading,
  message,
  onRetry,
  onClose,
  still = false,
}: ReadStateProps & { still?: boolean }) {
  return (
    <div
      className={still ? "sheet-ov sheet-still" : "sheet-ov"}
      onClick={(e) => {
        // Lồng trong sheet khác (phiếu con của đợt): chạm nền không đóng lớp cha.
        e.stopPropagation();
        // Đang tải thì chạm nền KHÔNG đóng: tấm vừa bật lên ngay dưới ngón tay, một
        // cú chạm đúp vào dòng phiếu sẽ đóng nó ngay. Muốn đóng thì bấm X.
        if (!loading && e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet" aria-busy={loading} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grab" />
        <div className="vd-hd">
          <span className="vd-hd-t">{title}</span>
          <button type="button" className="sheet-x" onClick={onClose} aria-label="Đóng">
            <X size={18} />
          </button>
        </div>
        <p role="status" className="vd-state">
          {loading && <Loader2 size={15} className="vd-state-spin" aria-hidden="true" />}
          {message}
        </p>
        {loading ? (
          <div className="vd-table" aria-hidden="true">
            {SKELETON_WIDTHS.map((width, i) => (
              <div className="vd-row" key={i}>
                <div className="vd-row-l">
                  <span className="vd-skel" style={{ width: "72%" }} />
                </div>
                <div className="vd-row-v">
                  <span className="vd-skel" style={{ width }} />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="vd-state-acts">
            <button type="button" className="invbtn primary" onClick={onRetry}>
              Thử lại
            </button>
            <button type="button" className="invbtn" onClick={onClose}>
              Đóng
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Bản máy tính: hộp thoại cùng tiêu đề với hộp chi tiết thật. */
export function VoucherDialogReadState({ title, loading, message, onRetry, onClose }: ReadStateProps) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent aria-describedby={undefined} aria-busy={loading}>
        <DialogTitle>{title}</DialogTitle>
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {message}
        </p>
        {loading ? (
          <div className="space-y-3" aria-hidden="true">
            {SKELETON_WIDTHS.map((width, i) => (
              <Skeleton key={i} className="h-4" style={{ width }} />
            ))}
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Đóng
            </Button>
            <Button type="button" onClick={onRetry}>
              Thử lại
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
