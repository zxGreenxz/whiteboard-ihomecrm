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
import { Camera, Loader2, X, MapPin } from "lucide-react";
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
import type { GeofenceStatus } from "@/lib/captureWatermark";
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

interface GeoMeta {
  lat: number | null;
  lng: number | null;
  distanceM: number | null;
  status: GeofenceStatus;
}

// Mức "nghiêm trọng" để giữ lại reading tệ nhất trong các lần chụp.
const STATUS_SEVERITY: Record<GeofenceStatus, number> = {
  out_of_range: 3,
  gps_denied: 2,
  no_building_coords: 1,
  ok: 0,
  disabled: 0,
};

export default function TaskCompleteDialog({
  open,
  onOpenChange,
  job,
  onSuccess,
}: TaskCompleteDialogProps) {
  const { data: authUser } = useAuth();
  const completeJob = useCompleteJob();
  const isMobile = useIsMobile();
  const { data: geofence } = useAcceptanceGeofenceConfig();
  const [completionTime, setCompletionTime] = useState("");
  const [newAttachments, setNewAttachments] = useState<string[]>([]);
  const [geoMeta, setGeoMeta] = useState<GeoMeta | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (open) {
      setCompletionTime(nowLocalDatetimeValue());
      setNewAttachments([]);
      setGeoMeta(null);
      setCameraOpen(false);
    }
  }, [open]);

  if (!job) return null;

  const existingAttachments = job.attachments ?? [];
  const canSubmit = !!completionTime && !completeJob.isPending && !uploading;

  const handleCaptured = async (result: JobCaptureResult) => {
    setUploading(true);
    try {
      const userId = authUser?.id ?? "anon";
      const url = await uploadFile(
        "job-attachments",
        `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`,
        result.file,
      );
      setNewAttachments((prev) => [...prev, url]);
      // Giữ reading "tệ nhất" để ghi vào job (ưu tiên out_of_range, rồi xa nhất).
      setGeoMeta((prev) => {
        const next: GeoMeta = {
          lat: result.lat,
          lng: result.lng,
          distanceM: result.distanceM,
          status: result.status,
        };
        if (!prev) return next;
        const ds = STATUS_SEVERITY[next.status] - STATUS_SEVERITY[prev.status];
        if (ds > 0) return next;
        if (ds === 0 && (next.distanceM ?? -1) > (prev.distanceM ?? -1)) return next;
        return prev;
      });
    } catch {
      toast.error("Không tải được ảnh lên, vui lòng thử lại");
    } finally {
      setUploading(false);
    }
  };

  const handleRemoveNew = (url: string) => {
    setNewAttachments((prev) => prev.filter((u) => u !== url));
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    const merged = [...existingAttachments, ...newAttachments];
    try {
      await completeJob.mutateAsync({
        id: job.id,
        completion_time: new Date(completionTime).toISOString(),
        completion_attachments: merged.length ? merged : null,
        completion_lat: geoMeta?.lat ?? null,
        completion_lng: geoMeta?.lng ?? null,
        completion_distance_m: geoMeta?.distanceM ?? null,
        completion_geofence_status: geoMeta?.status ?? null,
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
      <div className="space-y-1.5">
        <label className="text-[13px] font-medium block">
          Ảnh đã làm
          {existingAttachments.length > 0 && (
            <span className="ml-1 text-[11px] font-normal text-muted-foreground">
              (bổ sung vào {existingAttachments.length} ảnh đã có)
            </span>
          )}
        </label>

        {/* Lưới ảnh: ảnh đã có (chỉ xem) + ảnh vừa chụp (có thể xoá) */}
        {(existingAttachments.length > 0 || newAttachments.length > 0) && (
          <div className="grid grid-cols-3 gap-2">
            {existingAttachments.map((url) => (
              <div
                key={`old-${url}`}
                className="relative aspect-square rounded-lg overflow-hidden border bg-muted"
              >
                <StorageImage value={url} className="w-full h-full object-cover" />
              </div>
            ))}
            {newAttachments.map((url) => (
              <div
                key={`new-${url}`}
                className="relative aspect-square rounded-lg overflow-hidden border bg-muted"
              >
                <StorageImage value={url} className="w-full h-full object-cover" />
                <button
                  type="button"
                  onClick={() => handleRemoveNew(url)}
                  className="absolute top-1 right-1 h-6 w-6 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black/80"
                  aria-label="Xoá ảnh"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        <Button
          type="button"
          variant="outline"
          className="w-full h-11 border-dashed"
          disabled={uploading}
          onClick={() => setCameraOpen(true)}
        >
          {uploading ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Đang tải ảnh…
            </>
          ) : (
            <>
              <Camera className="h-4 w-4 mr-2" /> Chụp ảnh
            </>
          )}
        </Button>
        <p className="text-[11px] text-muted-foreground flex items-center gap-1">
          <MapPin className="h-3 w-3" />
          {geofence?.enabled
            ? `Chỉ chụp trực tiếp — ảnh được gắn ngày giờ, địa chỉ & vị trí GPS (bán kính ${geofence.radiusM}m).`
            : "Chỉ chụp trực tiếp — ảnh được gắn ngày giờ & địa chỉ."}
        </p>
      </div>
    </>
  );

  return (
    <>
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
