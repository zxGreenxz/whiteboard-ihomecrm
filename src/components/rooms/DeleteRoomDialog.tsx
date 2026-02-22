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
import { useDeleteRoom } from "@/hooks/useRooms";
import type { Database } from "@/integrations/supabase/types";

type Room = Database["public"]["Tables"]["rooms"]["Row"];

interface DeleteRoomDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  room: Room;
}

export function DeleteRoomDialog({
  open,
  onOpenChange,
  room,
}: DeleteRoomDialogProps) {
  const deleteRoom = useDeleteRoom();

  const handleDelete = async () => {
    try {
      await deleteRoom.mutateAsync(room.id);
      onOpenChange(false);
    } catch (error) {
      // Error is handled by the mutation
      // Don't close dialog if there's an error
    }
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("vi-VN", {
      style: "currency",
      currency: "VND",
    }).format(amount);
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Xác nhận xóa căn hộ</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                Bạn có chắc chắn muốn xóa căn hộ{" "}
                <span className="font-semibold">{room.name}</span>?
              </p>
              <div className="bg-muted rounded-md p-3 text-sm space-y-1">
                <p>
                  <span className="font-medium">Giá thuê:</span>{" "}
                  {formatCurrency(room.rent_price)}/tháng
                </p>
                <p>
                  <span className="font-medium">Tiền cọc:</span>{" "}
                  {formatCurrency(room.deposit_amount)}
                </p>
                <p>
                  <span className="font-medium">Tầng:</span> {room.floor}
                </p>
              </div>
              <p className="text-sm text-muted-foreground mt-2">
                Hành động này không thể hoàn tác.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Hủy</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            disabled={deleteRoom.isPending}
            className="bg-destructive hover:bg-destructive/90"
          >
            {deleteRoom.isPending ? "Đang xóa..." : "Xóa"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
