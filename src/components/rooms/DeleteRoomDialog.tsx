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
import { useDeleteRoom } from '@/hooks/useRooms';
import { toast } from 'sonner';
import type { RoomWithRelations } from '@/types/room';

interface DeleteRoomDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  room: RoomWithRelations;
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
      toast.success('Dữ liệu đã được XOÁ thành công');
      onOpenChange(false);
    } catch {
      // Error handled by mutation hook
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Xác nhận xoá căn hộ</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <p>
                Bạn có chắc chắn muốn xoá căn hộ{' '}
                <span className="font-semibold">{room.name}</span>?
              </p>
              <p className="text-sm text-muted-foreground">
                Hành động này không thể hoàn tác.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Huỷ</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            disabled={deleteRoom.isPending}
            className="bg-destructive hover:bg-destructive/90"
          >
            {deleteRoom.isPending ? 'Đang xoá...' : 'Xoá'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
