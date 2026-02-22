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
import { useDeleteArea } from "@/hooks/useAreas";
import type { Database } from "@/integrations/supabase/types";

type Area = Database["public"]["Tables"]["areas"]["Row"] & { buildings_count?: number };

interface DeleteAreaDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  area: Area;
}

export function DeleteAreaDialog({
  open,
  onOpenChange,
  area,
}: DeleteAreaDialogProps) {
  const deleteArea = useDeleteArea();

  const handleDelete = async () => {
    try {
      await deleteArea.mutateAsync(area.id);
      onOpenChange(false);
    } catch (error) {
      // Error is handled by the mutation
    }
  };

  const hasBuildings = area.buildings_count && area.buildings_count > 0;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Xác nhận xóa khu vực</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                Bạn có chắc chắn muốn xóa khu vực{" "}
                <span className="font-semibold">{area.name}</span>?
              </p>
              {hasBuildings && (
                <div className="bg-destructive/10 border border-destructive/20 rounded-md p-3 text-sm text-destructive">
                  <p className="font-semibold">⚠️ Cảnh báo:</p>
                  <p>
                    Khu vực này đang có {area.buildings_count} tòa nhà. Bạn cần
                    xóa hoặc chuyển các tòa nhà này trước khi xóa khu vực.
                  </p>
                </div>
              )}
              {!hasBuildings && (
                <p className="text-sm text-muted-foreground">
                  Hành động này không thể hoàn tác.
                </p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Hủy</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            disabled={deleteArea.isPending}
            className="bg-destructive hover:bg-destructive/90"
          >
            {deleteArea.isPending ? "Đang xóa..." : "Xóa"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
