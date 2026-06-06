import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plus, Copy, ExternalLink, Pencil, Trash2, Ban, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { roomShareUrl } from "@/lib/publicLinks";
import {
  usePublicRoomTokens, useCreatePublicRoomToken, useUpdateTokenLabel,
  useSetTokenRevoked, useDeletePublicRoomToken, type PublicRoomToken,
} from "@/hooks/usePublicRoomTokens";

const fmtDate = (s: string) => {
  try { return new Date(s).toLocaleDateString("vi-VN"); } catch { return s; }
};

export default function ShareTokensTab() {
  const { data: tokens, isLoading } = usePublicRoomTokens();
  const createMut = useCreatePublicRoomToken();
  const labelMut = useUpdateTokenLabel();
  const revokeMut = useSetTokenRevoked();
  const deleteMut = useDeletePublicRoomToken();

  const [createOpen, setCreateOpen] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [editing, setEditing] = useState<PublicRoomToken | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [revoking, setRevoking] = useState<PublicRoomToken | null>(null);
  const [deleting, setDeleting] = useState<PublicRoomToken | null>(null);

  const copyLink = async (token: string) => {
    try {
      await navigator.clipboard.writeText(roomShareUrl(token));
      toast.success("Đã copy link — dán gửi khách ngay");
    } catch {
      toast.error("Trình duyệt chặn copy — hãy copy thủ công");
    }
  };

  const doCreate = () => {
    createMut.mutate(newLabel, {
      onSuccess: (row) => { setCreateOpen(false); setNewLabel(""); if (row?.token) copyLink(row.token); },
    });
  };
  const doEdit = () => {
    if (!editing) return;
    labelMut.mutate({ token: editing.token, label: editLabel }, { onSuccess: () => setEditing(null) });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Mỗi link hiển thị tất cả toà của bạn đang có phòng trống. Gửi link cho khách/sale —
          không cần đăng nhập. Thu hồi link bất cứ lúc nào.
        </p>
        <Button size="sm" onClick={() => { setNewLabel(""); setCreateOpen(true); }}>
          <Plus className="h-4 w-4 mr-1" />Tạo link mới
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground">Đang tải...</div>
          ) : !tokens || tokens.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              Chưa có link chia sẻ nào. Bấm "Tạo link mới" để bắt đầu.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nhãn</TableHead>
                  <TableHead>Link</TableHead>
                  <TableHead>Trạng thái</TableHead>
                  <TableHead>Ngày tạo</TableHead>
                  <TableHead className="w-[160px]">Thao tác</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tokens.map((t) => (
                  <TableRow key={t.token} className={t.revoked ? "opacity-60" : ""}>
                    <TableCell className="font-medium">
                      {t.label || <span className="text-muted-foreground">(chưa đặt tên)</span>}
                    </TableCell>
                    <TableCell>
                      <code className="text-xs bg-muted px-1.5 py-0.5 rounded">/r/{t.token}</code>
                    </TableCell>
                    <TableCell>
                      {t.revoked
                        ? <Badge variant="destructive">Đã thu hồi</Badge>
                        : <Badge variant="default">Đang hoạt động</Badge>}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{fmtDate(t.created_at)}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-0.5">
                        <Button variant="ghost" size="icon" title="Copy link" onClick={() => copyLink(t.token)}>
                          <Copy className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" title="Mở link" onClick={() => window.open(roomShareUrl(t.token), "_blank", "noopener")}>
                          <ExternalLink className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" title="Đổi nhãn" onClick={() => { setEditing(t); setEditLabel(t.label ?? ""); }}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        {t.revoked ? (
                          <Button variant="ghost" size="icon" title="Khôi phục" onClick={() => revokeMut.mutate({ token: t.token, revoked: false })}>
                            <RotateCcw className="h-4 w-4" />
                          </Button>
                        ) : (
                          <Button variant="ghost" size="icon" title="Thu hồi" onClick={() => setRevoking(t)}>
                            <Ban className="h-4 w-4 text-amber-600" />
                          </Button>
                        )}
                        <Button variant="ghost" size="icon" title="Xoá" onClick={() => setDeleting(t)}>
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Tạo link */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Tạo link chia sẻ mới</DialogTitle></DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="new-label">Nhãn (tuỳ chọn)</Label>
            <Input id="new-label" placeholder="VD: Gửi sale khu Gò Vấp" value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)} onKeyDown={(e) => e.key === "Enter" && doCreate()} />
            <p className="text-xs text-muted-foreground">Link sẽ được tạo ngẫu nhiên và copy sẵn vào clipboard.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Hủy</Button>
            <Button onClick={doCreate} disabled={createMut.isPending}>Tạo link</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Đổi nhãn */}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Đổi nhãn link</DialogTitle></DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="edit-label">Nhãn</Label>
            <Input id="edit-label" value={editLabel} onChange={(e) => setEditLabel(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doEdit()} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Hủy</Button>
            <Button onClick={doEdit} disabled={labelMut.isPending}>Lưu</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Thu hồi */}
      <AlertDialog open={!!revoking} onOpenChange={(o) => !o && setRevoking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Thu hồi link này?</AlertDialogTitle>
            <AlertDialogDescription>
              Khách mở link đã thu hồi sẽ thấy "Liên kết không hợp lệ". Bạn có thể khôi phục lại sau.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (revoking) revokeMut.mutate({ token: revoking.token, revoked: true }); setRevoking(null); }}>
              Thu hồi
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Xoá */}
      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xoá link vĩnh viễn?</AlertDialogTitle>
            <AlertDialogDescription>
              Link sẽ bị xoá khỏi hệ thống, không thể khôi phục. Nếu chỉ muốn tạm tắt, hãy dùng "Thu hồi".
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (deleting) deleteMut.mutate(deleting.token); setDeleting(null); }}>
              Xoá
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
