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
import { useRef, useState } from 'react';
import { recordWriteBlocked, recordWriteMessage } from '@/lib/recordWriteOutcome';
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
  const [failure, setFailure] = useState<unknown>();
  const [blocked, setBlocked] = useState(false);
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);

  const handleDelete = async () => {
    if (submitting.current || blocked) return;
    submitting.current = true; setSaving(true); setFailure(undefined);
    try {
      await deleteRoom.mutateAsync(room.id);
      onOpenChange(false);
    } catch (error) {
      setFailure(error); setBlocked(recordWriteBlocked(error));
    } finally { submitting.current = false; setSaving(false); }
  };

  return (
    <AlertDialog open={open} onOpenChange={value => {if (!submitting.current) onOpenChange(value);}}>
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
        {Boolean(failure) && <p role="alert" className="text-sm text-destructive">{recordWriteMessage(failure,'xóa căn hộ')}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={saving}>Huỷ</AlertDialogCancel>
          <AlertDialogAction
            onClick={event => {event.preventDefault(); void handleDelete();}}
            disabled={saving || blocked || deleteRoom.isPending}
            className="bg-destructive hover:bg-destructive/90"
          >
            {deleteRoom.isPending ? 'Đang xoá...' : 'Xoá'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
