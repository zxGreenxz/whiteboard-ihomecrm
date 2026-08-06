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
import { Camera, Clock, Loader2, MapPin } from "lucide-react";
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
import { jsonProp } from "@/lib/jsonValue";
import { supabase } from "@/integrations/supabase/client";
import type { JobWithRelations } from "@/types/jobs";

interface TaskCompleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  job: JobWithRelations | null;
  onSuccess: () => void;
}

/**
 * Đồng hồ hiển thị theo GIỜ VIỆT NAM — chỉ để nhân viên thấy mốc sắp được ghi.
 * KHÔNG còn ô nhập tay: `completion_time` do SERVER đóng dấu `now()` qua trigger
 * `jobs_stamp_completion_time` (migration 20260720181000). Trước đây ô
 * <input type="datetime-local"> cho phép nhân viên tự chọn kỳ lương và hệ số
 * nhân (ngoài giờ / CN / Lễ) — xem audit 2026-07-20.
 */
function vnClockLabel(d: Date): string {
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
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
  const [nowTick, setNowTick] = useState(() => new Date());
  const [cameraOpen, setCameraOpen] = useState(false);
  const [processing, setProcessing] = useState(false);

  useEffect(() => {
    if (open) {
      setNowTick(new Date());
      setCameraOpen(false);
      setProcessing(false);
    }
  }, [open]);

  // Đồng hồ chạy để mốc hiển thị không bị "đứng hình" khi dialog mở lâu.
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setNowTick(new Date()), 30_000);
    return () => clearInterval(t);
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
        completion_captured_at: result.capturedAt,
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
      // v5 (nguồn 1 — ma trận dấu chân): tick ngày-công QUA RPC, FE không tự cộng.
      // Fire-and-forget; lỗi nuốt êm phía FE (server đã log salary_award_errors).
      // `supabase.rpc()` trả PostgrestBuilder — chỉ `implements PromiseLike` nên
      // KHÔNG có `.catch()` theo kiểu; bọc `Promise.resolve()` để giữ nguyên chuỗi
      // .then().catch() (ngữ nghĩa y hệt, chỉ chậm thêm đúng 1 microtask).
      void Promise.resolve(
        supabase.rpc("v5_tick_from_job", { p_job_id: job.id }),
      )
        .then(({ data }) => {
          if (jsonProp(data, "ticked")) {
            queryClient.invalidateQueries({ queryKey: ["v5-my-day-summary"] });
          }
        })
        .catch(() => {});
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
        <label className="text-[13px] font-medium block">Thời gian hoàn thành</label>
        <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
          <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="text-[13px] font-medium tabular-nums">{vnClockLabel(nowTick)}</span>
          <span className="ml-auto text-[11px] text-muted-foreground">giờ hệ thống</span>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Mốc này do máy chủ ghi lúc bấm hoàn thành — dùng để tính lương, thưởng ngoài giờ và CN/Lễ.
        </p>
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
