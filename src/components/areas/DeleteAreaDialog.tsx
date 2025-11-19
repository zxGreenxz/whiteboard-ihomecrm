import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useDeleteArea, Area } from '@/hooks/useAreas';

interface DeleteAreaDialogProps {
  area: Area | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const DeleteAreaDialog = ({ area, open, onOpenChange }: DeleteAreaDialogProps) => {
  const deleteAreaMutation = useDeleteArea();

  const handleDelete = async () => {
    if (!area) return;

    try {
      await deleteAreaMutation.mutateAsync(area.id);
      onOpenChange(false);
    } catch (error) {
      // Error is handled by the mutation
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Xác nhận xóa khu vực</AlertDialogTitle>
          <AlertDialogDescription className="space-y-2">
            <p>
              Bạn có chắc chắn muốn xóa khu vực{' '}
              <span className="font-semibold text-foreground">
                {area?.name} ({area?.code})
              </span>
              ?
            </p>
            {area?.buildings_count && area.buildings_count > 0 ? (
              <p className="text-destructive font-medium">
                ⚠️ Khu vực này đang có {area.buildings_count} tòa nhà. Bạn cần xóa hoặc
                chuyển các tòa nhà này trước khi xóa khu vực.
              </p>
            ) : (
              <p className="text-muted-foreground">
                Hành động này không thể hoàn tác.
              </p>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Hủy</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            disabled={
              deleteAreaMutation.isPending ||
              (area?.buildings_count && area.buildings_count > 0)
            }
            className="bg-destructive hover:bg-destructive/90"
          >
            {deleteAreaMutation.isPending ? 'Đang xóa...' : 'Xóa'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export default DeleteAreaDialog;
