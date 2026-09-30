import { useState } from "react";
import { actionErrorMessage } from "@/lib/actionFeedback";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  useDeleteDocumentTemplate,
  DocumentTemplate,
  templateWriteOutcomeUnknown,
} from "@/hooks/useDocumentTemplates";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template: DocumentTemplate | null;
}

export function DeleteTemplateDialog({ open, onOpenChange, template }: Props) {
  const deleteMutation = useDeleteDocumentTemplate();
  const [feedback, setFeedback] = useState<{id: string; message: string; blocked: boolean} | null>(null);
  const currentFeedback = feedback?.id === template?.id ? feedback : null;

  const handleDelete = async () => {
    if (!template || deleteMutation.isPending || currentFeedback?.blocked) return;
    setFeedback(null);
    try {
      await deleteMutation.mutateAsync(template.id);
      onOpenChange(false);
    } catch (error) {
      setFeedback({ id: template.id, message: actionErrorMessage(error, 'Chưa xác nhận được kết quả xóa mẫu tài liệu'), blocked: templateWriteOutcomeUnknown(error) });
    }
  };

  if (!template) return null;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Xác nhận xóa mẫu</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                Bạn có chắc chắn muốn xóa mẫu{" "}
                <span className="font-semibold">{template.name}</span>?
              </p>
              <p className="text-sm text-muted-foreground">
                Hành động này không thể hoàn tác.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {currentFeedback && <p role="alert" className="text-sm text-destructive">{currentFeedback.message}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel>Hủy</AlertDialogCancel>
          <AlertDialogAction
            onClick={event => { event.preventDefault(); void handleDelete(); }}
            disabled={deleteMutation.isPending || currentFeedback?.blocked}
            className="bg-destructive hover:bg-destructive/90"
          >
            {deleteMutation.isPending ? "Đang xóa..." : "Xóa"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
