import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/useAuth";
import { useCompleteJob } from "@/hooks/useJobs";
import { useIsMobile } from "@/hooks/use-mobile";
import AttachmentUpload from "@/components/income-expenses/AttachmentUpload";
import type { JobWithRelations } from "@/types/jobs";

interface TaskCompleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  job: JobWithRelations | null;
  onSuccess: () => void;
}

function nowLocalDatetimeValue(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
    d.getDate(),
  )}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function TaskCompleteDialog({
  open,
  onOpenChange,
  job,
  onSuccess,
}: TaskCompleteDialogProps) {
  const { data: authUser } = useAuth();
  const completeJob = useCompleteJob();
  const isMobile = useIsMobile();
  const [completionTime, setCompletionTime] = useState("");
  const [newAttachments, setNewAttachments] = useState<string[]>([]);

  useEffect(() => {
    if (open) {
      setCompletionTime(nowLocalDatetimeValue());
      setNewAttachments([]);
    }
  }, [open]);

  if (!job) return null;

  const existingAttachments = job.attachments ?? [];
  const canSubmit = !!completionTime && !completeJob.isPending;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    const merged = [...existingAttachments, ...newAttachments];
    try {
      await completeJob.mutateAsync({
        id: job.id,
        completion_time: new Date(completionTime).toISOString(),
        completion_attachments: merged.length ? merged : null,
      });
      onOpenChange(false);
      onSuccess();
    } catch {
      // toast handled by hook
    }
  };

  const formBody = (
    <>
      <div className="text-[12px] text-muted-foreground">
        {job.code} — {job.title}
      </div>
      <div className="space-y-1">
        <label htmlFor="completion-time" className="text-[13px] font-medium block">
          Thời gian hoàn thành <span className="text-red-500">*</span>
        </label>
        <Input
          id="completion-time"
          type="datetime-local"
          value={completionTime}
          onChange={(e) => setCompletionTime(e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <label className="text-[13px] font-medium block">
          Ảnh đã làm
          {existingAttachments.length > 0 && (
            <span className="ml-1 text-[11px] font-normal text-muted-foreground">
              (bổ sung vào {existingAttachments.length} ảnh đã có)
            </span>
          )}
        </label>
        <AttachmentUpload
          attachments={newAttachments}
          onChange={setNewAttachments}
          userId={authUser?.id ?? ""}
          bucket="job-attachments"
        />
      </div>
    </>
  );

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
                Hoàn thành công việc
              </DialogTitle>
            </DialogHeader>
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
              {formBody}
            </div>
            <DialogFooter className="shrink-0 px-4 py-3 border-t flex flex-col gap-2 bg-background">
              <Button
                type="button"
                className="bg-green-600 hover:bg-green-700 text-white w-full h-11"
                disabled={!canSubmit}
                onClick={handleSubmit}
              >
                {completeJob.isPending ? "Đang lưu..." : "Hoàn thành"}
              </Button>
              <Button
                type="button"
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
                Hoàn thành công việc
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4">{formBody}</div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Huỷ
              </Button>
              <Button
                type="button"
                className="bg-green-600 hover:bg-green-700 text-white"
                disabled={!canSubmit}
                onClick={handleSubmit}
              >
                {completeJob.isPending ? "Đang lưu..." : "Hoàn thành"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
