import { useState } from 'react';
import { Loader2, Plus, Pencil, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { useZaloTemplatesAdmin, useSaveTemplate, useDeleteTemplate, type ZaloTemplateFull } from '@/hooks/chat-zalo/useZaloTemplatesAdmin';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

type Editing = { id?: string; title: string; body: string; color: string; isActive: boolean } | null;

/** Dialog quản lý thư viện mẫu tin của công ty (CRUD — cần quyền manage_templates). */
export default function TemplateManagerDialog({ open, onOpenChange }: Props) {
  const { data: templates = [], isLoading } = useZaloTemplatesAdmin(open);
  const save = useSaveTemplate();
  const del = useDeleteTemplate();
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<ZaloTemplateFull | null>(null);

  const startNew = () => setEditing({ title: '', body: '', color: '#0f9960', isActive: true });
  const startEdit = (t: ZaloTemplateFull) => setEditing({ id: t.id, title: t.title, body: t.body, color: t.color || '#0f9960', isActive: t.isActive });

  const submit = () => {
    if (!editing || !editing.title.trim() || !editing.body.trim()) return;
    save.mutate(
      {
        id: editing.id, title: editing.title.trim(), body: editing.body,
        color: editing.color, isActive: editing.isActive,
        sortOrder: editing.id ? undefined : templates.length,
      },
      { onSuccess: () => setEditing(null) },
    );
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Quản lý mẫu tin</DialogTitle>
            <DialogDescription>Mẫu tin dùng chung cho cả công ty — chèn nhanh bằng nút "Mẫu tin" hoặc gõ "/" trong ô soạn.</DialogDescription>
          </DialogHeader>

          {editing ? (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Tiêu đề (nhãn hiển thị)</Label>
                <Input value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} autoFocus />
              </div>
              <div className="space-y-1.5">
                <Label>Nội dung tin (thứ sẽ được chèn/gửi)</Label>
                <Textarea rows={5} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Label htmlFor="tpl-color">Màu</Label>
                  <input id="tpl-color" type="color" value={editing.color} onChange={(e) => setEditing({ ...editing, color: e.target.value })} style={{ width: 34, height: 26, border: 'none', background: 'transparent', cursor: 'pointer' }} />
                </div>
                <div className="flex items-center gap-2">
                  <Label htmlFor="tpl-active">Đang dùng</Label>
                  <Switch id="tpl-active" checked={editing.isActive} onCheckedChange={(v) => setEditing({ ...editing, isActive: v })} />
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setEditing(null)}>Huỷ</Button>
                <Button onClick={submit} disabled={save.isPending || !editing.title.trim() || !editing.body.trim()}>
                  {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Lưu mẫu tin
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <Button onClick={startNew} className="w-full" variant="outline">
                <Plus className="mr-2 h-4 w-4" />Thêm mẫu tin
              </Button>
              <div className="max-h-80 overflow-y-auto rounded-md border">
                {isLoading && <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Đang tải…</div>}
                {!isLoading && templates.length === 0 && <div className="p-3 text-sm text-muted-foreground">Chưa có mẫu tin nào.</div>}
                {templates.map((t) => (
                  <div key={t.id} className="flex items-start gap-2 border-b p-3 last:border-0">
                    <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: t.color || '#0f9960' }} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{t.title}</span>
                        {!t.isActive && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">TẮT</span>}
                      </div>
                      <p className="truncate text-xs text-muted-foreground">{t.body}</p>
                    </div>
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => startEdit(t)} title="Sửa">
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => setDeleting(t)} title="Xoá">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleting} onOpenChange={(v) => !v && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xoá mẫu tin?</AlertDialogTitle>
            <AlertDialogDescription>"{deleting?.title}" sẽ bị xoá khỏi thư viện của công ty. Không hoàn tác được.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Huỷ</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { if (deleting) del.mutate(deleting.id, { onSuccess: () => setDeleting(null) }); }}
            >
              Xoá
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
