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
import { useDeleteBuilding } from "@/hooks/useBuildings";
import type { Database } from "@/integrations/supabase/types";

type Building = Database["public"]["Tables"]["buildings"]["Row"] & { rooms_count?: number };

interface DeleteBuildingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  building: Building;
}

export function DeleteBuildingDialog({
  open,
  onOpenChange,
  building,
}: DeleteBuildingDialogProps) {
  const deleteBuilding = useDeleteBuilding();

  const handleDelete = async () => {
    try {
      await deleteBuilding.mutateAsync(building.id);
      onOpenChange(false);
    } catch (error) {
      // Error is handled by the mutation
      // Don't close dialog if there's an error
    }
  };

  const hasRooms = building.rooms_count && building.rooms_count > 0;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Xác nhận xóa tòa nhà</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                Bạn có chắc chắn muốn xóa tòa nhà{" "}
                <span className="font-semibold">{building.name}</span>?
              </p>
              {hasRooms && (
                <div className="bg-destructive/10 border border-destructive/20 rounded-md p-3 text-sm text-destructive">
                  <p className="font-semibold">⚠️ Cảnh báo:</p>
                  <p>
                    Tòa nhà này đang có {building.rooms_count} căn hộ. Bạn cần
                    xóa hoặc chuyển các căn hộ này trước khi xóa tòa nhà.
                  </p>
                </div>
              )}
              {!hasRooms && (
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
            disabled={deleteBuilding.isPending}
            className="bg-destructive hover:bg-destructive/90"
          >
            {deleteBuilding.isPending ? "Đang xóa..." : "Xóa"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
