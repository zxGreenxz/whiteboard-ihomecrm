import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Info, Share2, Copy, ExternalLink, Pencil, Trash2, Ban, RotateCcw,
} from "lucide-react";
import { roomShareUrl } from "@/lib/publicLinks";
import {
  usePublicRoomTokens, useCreatePublicRoomToken, useUpdateTokenLabel,
  useSetTokenRevoked, useDeletePublicRoomToken, type PublicRoomToken,
} from "@/hooks/usePublicRoomTokens";
import SaleSheet from "./SaleSheet";
import type { HeaderAction } from "./types";

const fmtDate = (s: string) => {
  try { return new Date(s).toLocaleDateString("vi-VN"); } catch { return s; }
};

export default function MobileShareTokens({ onHeaderAction }: { onHeaderAction: (a: HeaderAction | null) => void }) {
  const { data: tokens, isLoading } = usePublicRoomTokens();
  const createMut = useCreatePublicRoomToken();
  const labelMut = useUpdateTokenLabel();
  const revokeMut = useSetTokenRevoked();
  const deleteMut = useDeletePublicRoomToken();

  const [editing, setEditing] = useState<PublicRoomToken | null>(null); // null = create, token = edit
  const [sheetOpen, setSheetOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [confirm, setConfirm] = useState<{ kind: "revoke" | "delete"; token: PublicRoomToken } | null>(null);

  const openCreate = () => { setEditing(null); setLabel(""); setSheetOpen(true); };

  useEffect(() => {
    onHeaderAction({ label: "Tạo link", onClick: openCreate });
    return () => onHeaderAction(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copyLink = async (token: string) => {
    try {
      await navigator.clipboard.writeText(roomShareUrl(token));
      toast.success("Đã copy link — dán gửi khách ngay");
    } catch {
      toast.error("Trình duyệt chặn copy — hãy copy thủ công");
    }
  };

  const save = () => {
    if (editing) {
      labelMut.mutate({ token: editing.token, label }, { onSuccess: () => setSheetOpen(false) });
    } else {
      createMut.mutate(label, {
        onSuccess: (row) => { setSheetOpen(false); if (row?.token) copyLink(row.token); },
      });
    }
  };

  return (
    <div style={{ padding: "14px 16px 28px" }}>
      <div className="sp-note blue">
        <Info size={17} stroke="var(--acc-blue)" />
        <p>Mỗi link hiển thị tất cả toà đang có phòng trống. Gửi cho khách/sale — không cần đăng nhập, thu hồi bất cứ lúc nào.</p>
      </div>

      {isLoading ? (
        <div className="stub"><p>Đang tải…</p></div>
      ) : !tokens || tokens.length === 0 ? (
        <div className="sp-empty">
          <span className="ic"><Share2 size={24} /></span>
          <p>Chưa có link chia sẻ nào. Bấm <b>Tạo link</b> để bắt đầu gửi khách.</p>
        </div>
      ) : (
        <div className="sp-list">
          {tokens.map((t) => (
            <div key={t.token} className={"sp-tcard" + (t.revoked ? " off" : "")}>
              <div className="sp-tcard-h">
                <div className="lbl">{t.label || "(chưa đặt tên)"}</div>
                <span className={"sp-badge " + (t.revoked ? "off" : "on")}>
                  <span className="dot" />{t.revoked ? "Đã thu hồi" : "Đang hoạt động"}
                </span>
              </div>
              <button className="sp-copy" onClick={() => copyLink(t.token)}>
                <span className="u">/r/{t.token}</span>
                <Copy size={15} />
              </button>
              <div className="sp-tcard-f">
                <span className="when">{fmtDate(t.created_at)}</span>
                <span className="sp-acts">
                  <button className="sp-iconbtn" title="Mở link" onClick={() => window.open(roomShareUrl(t.token), "_blank", "noopener")}>
                    <ExternalLink size={16} />
                  </button>
                  <button className="sp-iconbtn" title="Đổi nhãn" onClick={() => { setEditing(t); setLabel(t.label ?? ""); setSheetOpen(true); }}>
                    <Pencil size={16} />
                  </button>
                  {t.revoked ? (
                    <button className="sp-iconbtn" title="Khôi phục" onClick={() => revokeMut.mutate({ token: t.token, revoked: false })}>
                      <RotateCcw size={16} />
                    </button>
                  ) : (
                    <button className="sp-iconbtn warn" title="Thu hồi" onClick={() => setConfirm({ kind: "revoke", token: t })}>
                      <Ban size={16} />
                    </button>
                  )}
                  <button className="sp-iconbtn danger" title="Xoá" onClick={() => setConfirm({ kind: "delete", token: t })}>
                    <Trash2 size={16} />
                  </button>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* create / edit link */}
      <SaleSheet open={sheetOpen} onClose={() => setSheetOpen(false)}>
        <h3>{editing ? "Đổi nhãn link" : "Tạo link chia sẻ"}</h3>
        <p className="desc">
          {editing ? "Đặt tên dễ nhớ để phân biệt link gửi cho từng nhóm khách/sale." : "Link tạo ngẫu nhiên & copy sẵn vào clipboard để gửi khách."}
        </p>
        <label className="sl">Nhãn link</label>
        <input className="sp-input" value={label} placeholder="VD: Gửi sale khu Gò Vấp"
          onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} />
        <div className="sp-sheet-btns">
          <button className="cancel" onClick={() => setSheetOpen(false)}>Hủy</button>
          <button className="ok" onClick={save} disabled={createMut.isPending || labelMut.isPending}>
            {editing ? "Lưu" : "Tạo link"}
          </button>
        </div>
      </SaleSheet>

      {/* confirm revoke / delete */}
      <SaleSheet open={!!confirm} onClose={() => setConfirm(null)}>
        {confirm && (
          <>
            <span className={"sp-confirm-ic " + (confirm.kind === "delete" ? "danger" : "warn")}>
              {confirm.kind === "delete" ? <Trash2 size={24} /> : <Ban size={24} />}
            </span>
            <h3 className="center">{confirm.kind === "delete" ? "Xoá link vĩnh viễn?" : "Thu hồi link này?"}</h3>
            <p className="desc center">
              {confirm.kind === "delete"
                ? "Link sẽ bị xoá khỏi hệ thống, không thể khôi phục. Nếu chỉ muốn tạm tắt, hãy dùng Thu hồi."
                : "Khách mở link đã thu hồi sẽ thấy \"Liên kết không hợp lệ\". Bạn có thể khôi phục lại sau."}
            </p>
            <div className="sp-sheet-btns">
              <button className="cancel" onClick={() => setConfirm(null)}>Hủy</button>
              <button className={"ok" + (confirm.kind === "delete" ? " danger" : "")} onClick={() => {
                if (confirm.kind === "delete") deleteMut.mutate(confirm.token.token);
                else revokeMut.mutate({ token: confirm.token.token, revoked: true });
                setConfirm(null);
              }}>{confirm.kind === "delete" ? "Xoá" : "Thu hồi"}</button>
            </div>
          </>
        )}
      </SaleSheet>
    </div>
  );
}
