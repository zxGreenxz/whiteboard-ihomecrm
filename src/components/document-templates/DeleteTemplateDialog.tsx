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
} from "@/hooks/useDocumentTemplates";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template: DocumentTemplate | null;
}

export function DeleteTemplateDialog({ open, onOpenChange, template }: Props) {
  const deleteMutation = useDeleteDocumentTemplate();

  const handleDelete = async () => {
    if (!template) return;

    try {
      await deleteMutation.mutateAsync(template.id);
      onOpenChange(false);
    } catch (error) {
      // Error is handled by the mutation
      // Don't close dialog if there's an error
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
        <AlertDialogFooter>
          <AlertDialogCancel>Hủy</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            disabled={deleteMutation.isPending}
            className="bg-destructive hover:bg-destructive/90"
          >
            {deleteMutation.isPending ? "Đang xóa..." : "Xóa"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
