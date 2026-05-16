import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useUpdateJob } from "@/hooks/useJobs";
import type { JobWithRelations } from "@/types/jobs";

interface TaskNotesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  job: JobWithRelations | null;
  onSuccess: () => void;
}

export default function TaskNotesDialog({
  open,
  onOpenChange,
  job,
  onSuccess,
}: TaskNotesDialogProps) {
  const updateJob = useUpdateJob();
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (open && job) {
      setNotes(job.completion_description ?? "");
    }
  }, [open, job]);

  if (!job) return null;

  const handleSave = async () => {
    try {
      await updateJob.mutateAsync({
        id: job.id,
        patch: { completion_description: notes.trim() || null },
      });
      onOpenChange(false);
      onSuccess();
    } catch {
      // toast handled by hook
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="text-green-600 uppercase font-semibold">
            GHI CHÚ ĐÁNH GIÁ - {job.code}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-2">
          <label className="text-sm font-medium">Nội dung ghi chú / đánh giá</label>
          <Textarea
            autoFocus
            rows={5}
            placeholder="Nhập ghi chú đánh giá sau khi hoàn thành..."
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Có thể cập nhật nhiều lần để bổ sung nhận xét.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Huỷ
          </Button>
          <Button
            className="bg-green-600 hover:bg-green-700 text-white"
            disabled={updateJob.isPending}
            onClick={handleSave}
          >
            {updateJob.isPending ? "Đang lưu..." : "Lưu"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
