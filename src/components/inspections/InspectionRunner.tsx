// InspectionRunner — chạy MỘT phiên kiểm tra nhà (FULL/QUICK) theo checklist.
// Tái dùng NGUYÊN pipeline camera JobCaptureCamera (camera-only + watermark + GPS)
// — không fork pipeline (US-2.1). Gate chấm TẠI TOÀ, fail = gain-framing.
import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Camera, Check, ShieldAlert, Wrench } from "lucide-react";
import { toast } from "sonner";
import JobCaptureCamera, { type JobCaptureResult } from "@/components/tasks/JobCaptureCamera";
import { useAcceptanceGeofenceConfig } from "@/hooks/useAcceptanceGeofence";
import { uploadFile } from "@/lib/storage";
import { useAuth } from "@/hooks/useAuth";
import { v5Copy } from "@/lib/v5Copy";
import {
  type InspectionSessionState,
  sha256File,
  useCompleteInspection,
  useReportDeviceIssue,
  useStartInspection,
  useSubmitInspectionPhoto,
} from "@/hooks/useMyDay";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  buildingId: string;
  buildingName: string;
  buildingCoords?: { latitude?: number | null; longitude?: number | null } | null;
  type: "FULL" | "QUICK";
  pairedIncomeExpenseId?: string;
  onDone?: () => void;
}

export default function InspectionRunner({
  open, onOpenChange, buildingId, buildingName, buildingCoords, type, pairedIncomeExpenseId, onDone,
}: Props) {
  const { data: authUser } = useAuth();
  const { data: geofence } = useAcceptanceGeofenceConfig();
  const startM = useStartInspection();
  const photoM = useSubmitInspectionPhoto();
  const completeM = useCompleteInspection();
  const deviceM = useReportDeviceIssue();

  const [sess, setSess] = useState<InspectionSessionState | null>(null);
  const [cameraSlot, setCameraSlot] = useState<string | null>(null);
  const [hasIssue, setHasIssue] = useState(false);
  const [issueNote, setIssueNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState<string[] | null>(null);

  useEffect(() => {
    if (!open) { setSess(null); setMissing(null); setHasIssue(false); setIssueNote(""); return; }
    startM.mutateAsync({ buildingId, type, pairedIncomeExpenseId })
      .then(setSess)
      .catch(() => { toast.error("Không mở được phiên — thử lại nhé"); onOpenChange(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, buildingId, type]);

  const doneCount = useMemo(
    () => (sess?.checklist ?? []).filter((c) => c.done).length,
    [sess],
  );

  const handleCaptured = async (result: JobCaptureResult) => {
    if (!sess || !cameraSlot) return;
    setBusy(true);
    try {
      const path = `${authUser?.id ?? "anon"}/inspections/${sess.session_id}/${Date.now()}-${cameraSlot}.jpg`;
      const url = await uploadFile("job-attachments", path, result.file);
      const hash = await sha256File(result.file);
      const res = await photoM.mutateAsync({
        sessionId: sess.session_id, slot: cameraSlot, storagePath: url, sha256: hash,
        lat: result.lat, lng: result.lng,
      });
      if (!res.accepted) {
        toast.warning(res.message ?? "Ảnh chưa được nhận — chụp ảnh mới nhé");
      } else {
        setSess((s) => s ? {
          ...s,
          photos_count: s.photos_count + 1,
          checklist: s.checklist.map((c) => (c.key === cameraSlot ? { ...c, done: true } : c)),
        } : s);
      }
    } catch {
      toast.error("Không tải được ảnh — kiểm tra mạng rồi thử lại (phiên vẫn còn nguyên)");
    } finally {
      setBusy(false);
      setCameraSlot(null);
    }
  };

  const handleComplete = async () => {
    if (!sess) return;
    setBusy(true);
    try {
      const res = await completeM.mutateAsync({
        sessionId: sess.session_id,
        conditionNote: hasIssue && issueNote.trim() ? issueNote.trim() : "OK",
      });
      if (res.status === "passed" || res.status === "quick_done") {
        const t = res.tick;
        if (t?.day_rate) {
          toast.success(
            t.streak?.next
              ? v5Copy.tickedToast(Number(t.day_rate), Number(t.streak?.current ?? 0), Number(t.streak.next.days_to_go), Number(t.streak.next.delta))
              : v5Copy.tickedToastNoNext(Number(t.day_rate), Number(t.streak?.current ?? 0)),
            { duration: 6000 },
          );
        } else if (res.status === "quick_done") {
          toast.success(v5Copy.quickCheckDone);
        }
        if (res.spawned_job_id) toast.info("Đã tự tạo việc sửa chữa từ ghi nhận của bạn 🔧");
        onDone?.();
        onOpenChange(false);
      } else if (res.status === "presence") {
        setMissing(res.missing ?? []);
        toast.info(res.message ?? v5Copy.presenceSaved, { duration: 6000 });
      } else {
        toast.info(res.message ?? res.status);
        onOpenChange(false);
      }
    } catch {
      toast.error("Chưa chốt được phiên — thử lại nhé");
    } finally {
      setBusy(false);
    }
  };

  const reportDevice = async () => {
    if (!sess) return;
    try {
      await deviceM.mutateAsync({ sessionId: sess.session_id, reason: "GPS/thiết bị trục trặc tại toà" });
      toast.success("Đã báo sự cố thiết bị — chủ sẽ duyệt ngày công thủ công");
    } catch {
      toast.error("Chưa gửi được — thử lại nhé");
    }
  };

  return (
    <>
      <Dialog open={open && !cameraSlot} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {type === "FULL" ? "Kiểm tra nhà" : "Check nhanh"} · {buildingName}
            </DialogTitle>
          </DialogHeader>

          {!sess ? (
            <div className="py-8 text-center text-sm text-muted-foreground">Đang mở phiên…</div>
          ) : (
            <div className="space-y-3">
              <div className="text-xs text-muted-foreground">
                Cần ≥{type === "QUICK" ? 2 : sess.reqs.photos_min} ảnh
                {type === "FULL" && <> · tại toà ≥{Math.round(sess.reqs.dwell_min_seconds / 60)} phút</>}
                {" · "}đã chụp {sess.photos_count} ảnh · {doneCount}/{sess.checklist.length} mục
              </div>

              <div className="space-y-2">
                {sess.checklist.map((item) => (
                  <button
                    key={item.key}
                    className={`flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-left text-sm ${
                      item.done ? "border-emerald-300 bg-emerald-50" : "border-border bg-background"
                    }`}
                    disabled={busy}
                    onClick={() => setCameraSlot(item.key)}
                  >
                    <span className="flex-1 pr-2">{item.label}</span>
                    {item.done
                      ? <Check className="h-4 w-4 shrink-0 text-emerald-600" />
                      : <Camera className="h-4 w-4 shrink-0 text-muted-foreground" />}
                  </button>
                ))}
              </div>

              {missing && missing.length > 0 && (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
                  <div className="font-medium">{v5Copy.failBanner(missing.length)}</div>
                  <ul className="mt-1 list-inside list-disc text-xs text-muted-foreground">
                    {missing.map((m) => <li key={m}>{m}</li>)}
                  </ul>
                </div>
              )}

              {type === "FULL" && (
                <div className="rounded-lg border p-3">
                  <div className="mb-2 text-sm font-medium">Tình trạng nhà</div>
                  <div className="flex gap-2">
                    <Button size="sm" variant={hasIssue ? "outline" : "default"} onClick={() => setHasIssue(false)}>
                      Tốt
                    </Button>
                    <Button size="sm" variant={hasIssue ? "default" : "outline"} onClick={() => setHasIssue(true)}>
                      <Wrench className="mr-1 h-3.5 w-3.5" /> Có vấn đề
                    </Button>
                  </div>
                  {hasIssue && (
                    <textarea
                      className="mt-2 w-full rounded-md border p-2 text-sm"
                      rows={2}
                      placeholder="Mô tả ngắn (sẽ tự tạo việc sửa chữa)"
                      value={issueNote}
                      onChange={(e) => setIssueNote(e.target.value)}
                    />
                  )}
                </div>
              )}

              <div className="flex items-center gap-2 pt-1">
                <Button className="flex-1" disabled={busy} onClick={handleComplete}>
                  Hoàn tất
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={reportDevice} title="GPS/máy trục trặc">
                  <ShieldAlert className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-center text-[11px] text-muted-foreground">
                Chưa đủ mục? Cứ Hoàn tất — hệ ghi nhận có mặt và bạn bổ sung được tới 23:59 hôm nay.
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <JobCaptureCamera
        open={!!cameraSlot}
        onOpenChange={(o) => { if (!o) setCameraSlot(null); }}
        building={buildingCoords ?? null}
        geofenceEnabled={geofence?.enabled ?? true}
        radiusM={geofence?.radiusM ?? 70}
        onCaptured={handleCaptured}
      />
    </>
  );
}
