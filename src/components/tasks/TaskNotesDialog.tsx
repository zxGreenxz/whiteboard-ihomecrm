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
            ? "max-w-full w-full h-[100dvh] !top-auto !bottom-0 !left-0 !translate-x-0 !translate-y-0 rounded-t-2xl rounded-b-none flex flex-col p-0 gap-0 data-[state=open]:!slide-in-from-bottom data-[state=closed]:!slide-out-to-bottom"
            : "sm:max-w-[520px]"
        }
      >
        {isMobile ? (
          <>
            <div className="shrink-0 pt-2 pb-1 flex justify-center">
              <div className="w-10 h-1 bg-zinc-300 rounded-full" />
            </div>
            <DialogHeader className="shrink-0 px-4 pb-2.5 border-b">
              <DialogTitle className="text-green-600 uppercase font-semibold text-base">
                Ghi chú đánh giá
              </DialogTitle>
              <p className="text-xs text-muted-foreground">{job.code}</p>
            </DialogHeader>
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
              <label className="text-[13px] font-medium block">
                Nội dung ghi chú / đánh giá
              </label>
              <Textarea
                autoFocus
                rows={6}
                placeholder="Nhập ghi chú đánh giá sau khi hoàn thành..."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
              <p className="text-[12px] text-muted-foreground">
                Có thể cập nhật nhiều lần để bổ sung nhận xét.
              </p>
            </div>
            <DialogFooter className="shrink-0 px-4 py-3 border-t flex flex-col gap-2 bg-background">
              <Button
                className="bg-green-600 hover:bg-green-700 text-white w-full h-11"
                disabled={updateJob.isPending}
                onClick={handleSave}
              >
                {updateJob.isPending ? "Đang lưu..." : "Lưu"}
              </Button>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                className="w-full h-11"
              >
                Huỷ
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="text-green-600 uppercase font-semibold">
                GHI CHÚ ĐÁNH GIÁ - {job.code}
              </DialogTitle>
            </DialogHeader>

            <div className="space-y-2">
              <label className="text-sm font-medium">
                Nội dung ghi chú / đánh giá
              </label>
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
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
