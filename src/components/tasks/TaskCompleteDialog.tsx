import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Camera, Loader2, MapPin } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { useCompleteJob } from "@/hooks/useJobs";
import { useIsMobile } from "@/hooks/use-mobile";
import { useAcceptanceGeofenceConfig } from "@/hooks/useAcceptanceGeofence";
import { uploadFile } from "@/lib/storage";
import { StorageImage } from "@/components/ui/storage-image";
import JobCaptureCamera, {
  type JobCaptureResult,
} from "@/components/tasks/JobCaptureCamera";
import { awardAndNotifyJobBonus } from "@/lib/salaryBonusNotify";
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
  const queryClient = useQueryClient();
  const completeJob = useCompleteJob();
  const isMobile = useIsMobile();
  const { data: geofence } = useAcceptanceGeofenceConfig();
  const [completionTime, setCompletionTime] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [processing, setProcessing] = useState(false);

  useEffect(() => {
    if (open) {
      setCompletionTime(nowLocalDatetimeValue());
      setCameraOpen(false);
      setProcessing(false);
    }
  }, [open]);

  if (!job) return null;

  const existingAttachments = job.attachments ?? [];

  // Chụp ảnh xong (xác nhận "Dùng ảnh này") → upload + HOÀN THÀNH luôn.
  // Đây là con đường DUY NHẤT để hoàn thành: chưa chụp ảnh thì không xong được.
  const handleCaptured = async (result: JobCaptureResult) => {
    setProcessing(true);
    let url: string;
    try {
      const userId = authUser?.id ?? "anon";
      url = await uploadFile(
        "job-attachments",
        `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`,
        result.file,
      );
    } catch {
      toast.error("Không tải được ảnh lên, vui lòng thử lại");
      setProcessing(false);
      return;
    }

    try {
      const merged = [...existingAttachments, url];
      await completeJob.mutateAsync({
        id: job.id,
        completion_time: new Date(completionTime).toISOString(),
        completion_attachments: merged,
        completion_lat: result.lat,
        completion_lng: result.lng,
        completion_distance_m: result.distanceM,
        completion_geofence_status: result.status,
        completion_address: result.address,
      });
      onOpenChange(false);
      onSuccess();
      // Bắn thông báo thưởng (popup nổi + Web Push) nếu loại việc có thưởng.
      // Fire-and-forget: không chặn việc đóng dialog; lỗi được nuốt êm trong util.
      void awardAndNotifyJobBonus(job.id).then((rows) => {
        if (rows.length) {
          queryClient.invalidateQueries({ queryKey: ["notifications"] });
        }
      });
    } catch {
      // toast lỗi đã xử lý trong hook; giữ dialog mở để thử lại
    } finally {
      setProcessing(false);
    }
  };

  // Chặn đóng dialog khi đang lưu để tránh race.
  const handleDialogOpenChange = (o: boolean) => {
    if (!o && processing) return;
    onOpenChange(o);
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

      {existingAttachments.length > 0 && (
        <div className="space-y-1.5">
          <label className="text-[13px] font-medium block">Ảnh đã có</label>
          <div className="grid grid-cols-3 gap-2">
            {existingAttachments.map((url) => (
              <div
                key={`old-${url}`}
                className="relative aspect-square rounded-lg overflow-hidden border bg-muted"
              >
                <StorageImage value={url} className="w-full h-full object-cover" />
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground flex items-start gap-1">
        <MapPin className="h-3 w-3 mt-0.5 shrink-0" />
        <span>
          Phải <b>chụp ảnh trực tiếp</b> mới hoàn thành được — ảnh gắn ngày giờ + địa chỉ GPS thực tế
          {geofence?.enabled ? `; cảnh báo nếu cách tòa quá ${geofence.radiusM}m.` : "."}
        </span>
      </p>
    </>
  );

  // Nút chính: mở camera; chụp xong tự hoàn thành.
  const primaryButton = (className: string) => (
    <Button
      type="button"
      className={`bg-green-600 hover:bg-green-700 text-white ${className}`}
      disabled={processing}
      onClick={() => setCameraOpen(true)}
    >
      {processing ? (
        <>
          <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Đang lưu…
        </>
      ) : (
        <>
          <Camera className="h-4 w-4 mr-2" /> Chụp ảnh & hoàn thành
        </>
      )}
    </Button>
  );

  return (
    <>
      <Dialog open={open} onOpenChange={handleDialogOpenChange}>
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
                {primaryButton("w-full h-11")}
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  disabled={processing}
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
                  disabled={processing}
                >
                  Huỷ
                </Button>
                {primaryButton("")}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <JobCaptureCamera
        open={cameraOpen}
        onOpenChange={setCameraOpen}
        building={job.buildings}
        geofenceEnabled={geofence?.enabled ?? true}
        radiusM={geofence?.radiusM ?? 70}
        onCaptured={handleCaptured}
      />
    </>
  );
}
