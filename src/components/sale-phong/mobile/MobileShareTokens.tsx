import {QueryRegion} from '@/components/errors/QueryRegion';
import {LoadingState} from '@/components/loading/LoadingState';
import {actionErrorMessage} from '@/lib/actionFeedback';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
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
  const tokenQuery=usePublicRoomTokens();
  const {data:tokens,isLoading}=tokenQuery;
  const createMut = useCreatePublicRoomToken({inlineError:true});
  const labelMut = useUpdateTokenLabel({inlineError:true});
  const revokeMut = useSetTokenRevoked({inlineError:true});
  const deleteMut = useDeletePublicRoomToken({inlineError:true});

  const [editing, setEditing] = useState<PublicRoomToken | null>(null); // null = create, token = edit
  const [sheetOpen, setSheetOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [confirm, setConfirm] = useState<{ kind: "revoke" | "delete"; token: PublicRoomToken } | null>(null);

  const [writeError,setWriteError]=useState('');
  const [blocked,setBlocked]=useState(false);
  const canWrite=!blocked&&!tokenQuery.isError&&tokenQuery.data!==undefined;
  const busy=createMut.isPending||labelMut.isPending||revokeMut.isPending||deleteMut.isPending;
  const openCreate = () => { setWriteError('');setEditing(null); setLabel(""); setSheetOpen(true); };

  useEffect(() => {
    onHeaderAction(canWrite&&!busy?{label:"Tạo link",onClick:openCreate}:null);
    return () => onHeaderAction(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onHeaderAction,canWrite,busy]);

  const copyLink = async (token: string) => {
    try {
      await navigator.clipboard.writeText(roomShareUrl(token));
      toast.success("Đã copy link — dán gửi khách ngay");
    } catch {
      toast.error("Trình duyệt chặn copy — hãy copy thủ công");
    }
  };

  const perform=async(task:()=>Promise<unknown>,done:()=>void)=>{
    if(!canWrite||busy)return;setWriteError('');
    try{await task();done();}catch(error){setWriteError(actionErrorMessage(error,'Chưa xác nhận được thao tác link chia sẻ.'));if(error instanceof FinancialWorkflowError&&error.outcome!=='failure')setBlocked(true);}
  };
  const save=()=>void perform(async()=>{if(editing)return labelMut.mutateAsync({token:editing.token,label});const row=await createMut.mutateAsync(label);await copyLink(row.token);return row;},()=>setSheetOpen(false));
  const errorNotice=writeError?<p role="alert" className="text-destructive">{writeError}</p>:null;

  return (
    <div style={{ padding: "14px 16px 28px" }}><QueryRegion label="link chia sẻ" queries={[tokenQuery]} skeleton="list" rows={4}>
      <div className="sp-note blue">
        <Info size={17} stroke="var(--acc-blue)" />
        <p>Mỗi link hiển thị tất cả toà đang có phòng trống. Gửi cho khách/sale — không cần đăng nhập, thu hồi bất cứ lúc nào.</p>
      </div>

      {!sheetOpen&&!confirm&&errorNotice}
      {isLoading ? (
        <LoadingState label="link chia sẻ" variant="list" rows={4} />
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
                  <button className="sp-iconbtn" title="Đổi nhãn" disabled={!canWrite||busy} onClick={()=>{setWriteError('');setEditing(t);setLabel(t.label??"");setSheetOpen(true);}}>
                    <Pencil size={16} />
                  </button>
                  {t.revoked ? (
                    <button className="sp-iconbtn" title="Khôi phục" disabled={!canWrite||busy} onClick={()=>void perform(()=>revokeMut.mutateAsync({token:t.token,revoked:false}),()=>{})}>
                      <RotateCcw size={16} />
                    </button>
                  ) : (
                    <button className="sp-iconbtn warn" title="Thu hồi" disabled={!canWrite||busy} onClick={()=>{setWriteError('');setConfirm({kind:"revoke",token:t});}}>
                      <Ban size={16} />
                    </button>
                  )}
                  <button className="sp-iconbtn danger" title="Xoá" disabled={!canWrite||busy} onClick={()=>{setWriteError('');setConfirm({kind:"delete",token:t});}}>
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
        {errorNotice}
        <div className="sp-sheet-btns">
          <button className="cancel" onClick={() => setSheetOpen(false)}>Hủy</button>
          <button className="ok" onClick={save} disabled={busy||!canWrite}>
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
            {errorNotice}
            <div className="sp-sheet-btns">
              <button className="cancel" onClick={() => setConfirm(null)}>Hủy</button>
              <button className={"ok" + (confirm.kind === "delete" ? " danger" : "")} disabled={busy||!canWrite} onClick={()=>void perform(()=>confirm.kind==='delete'?deleteMut.mutateAsync(confirm.token.token):revokeMut.mutateAsync({token:confirm.token.token,revoked:true}),()=>setConfirm(null))}>{confirm.kind === "delete" ? "Xoá" : "Thu hồi"}</button>
            </div>
          </>
        )}
      </SaleSheet>
    </QueryRegion></div>
  );
}
