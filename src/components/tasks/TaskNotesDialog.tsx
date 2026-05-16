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
import { useIsMobile } from "@/hooks/use-mobile";
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
  const isMobile = useIsMobile();
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
      <DialogContent
        className={
          isMobile
            ? "max-w-full w-full h-auto max-h-[90vh] !top-auto !bottom-0 !left-0 !translate-x-0 !translate-y-0 rounded-t-2xl rounded-b-none p-4 overflow-y-auto data-[state=open]:!slide-in-from-bottom data-[state=closed]:!slide-out-to-bottom"
            : "sm:max-w-[520px]"
        }
      >
        {isMobile && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 w-10 h-1 bg-zinc-300 rounded-full" />
        )}
        <DialogHeader className={isMobile ? "pt-3" : ""}>
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

        <DialogFooter className={isMobile ? "flex flex-col gap-2 mt-2" : ""}>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className={isMobile ? "w-full h-11" : ""}
          >
            Huỷ
          </Button>
          <Button
            className={`bg-green-600 hover:bg-green-700 text-white ${
              isMobile ? "w-full h-11" : ""
            }`}
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
