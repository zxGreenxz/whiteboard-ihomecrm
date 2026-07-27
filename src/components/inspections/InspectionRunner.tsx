// InspectionRunner — chạy MỘT phiên kiểm tra nhà (FULL/QUICK) theo checklist.
// Tái dùng NGUYÊN pipeline camera JobCaptureCamera (camera-only + watermark + GPS)
// — không fork pipeline (US-2.1). Gate chấm TẠI TOÀ, fail = gain-framing.
// Dwell = đồng hồ THẬT từ lúc bấm Kiểm tra (server chốt, FE hiển thị live);
// mỗi mục chụp KHÔNG giới hạn ảnh — mục đã ✓ vẫn bấm chụp bổ sung được.
import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Camera, Check, ShieldAlert, Wrench } from "lucide-react";
import { toast } from "sonner";
import JobCaptureCamera, { type JobCaptureResult } from "@/components/tasks/JobCaptureCamera";
import { useAcceptanceGeofenceConfig } from "@/hooks/useAcceptanceGeofence";
import { uploadFile } from "@/lib/storage";
import { useAuth } from "@/hooks/useAuth";
import { getSessionUserId } from "@/lib/authSession";
import { v5Copy } from "@/lib/v5Copy";
import {
  fetchGeoOkCount,
  type InspectionSessionState,
  sha256File,
  useCompleteInspection,
  useReportDeviceIssue,
  useStartInspection,
  useSubmitInspectionPhoto,
} from "@/hooks/useMyDay";

/** Dòng "còn thiếu" do server trả về khi chưa có ảnh nào trong bán kính toà. */
const GEO_MISSING = "Cần ≥1 ảnh trong bán kính toà";

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
  const [slotCounts, setSlotCounts] = useState<Record<string, number>>({});
  const [cameraSlot, setCameraSlot] = useState<string | null>(null);
  const [hasIssue, setHasIssue] = useState(false);
  const [issueNote, setIssueNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState<string[] | null>(null);
  const [nowTs, setNowTs] = useState(() => Date.now());
  /** Số ảnh đã được chấm "trong bán kính toà" — server đòi ≥1 mới chốt ngày công. */
  const [geoOkCount, setGeoOkCount] = useState(0);

  useEffect(() => {
    if (!open) { setSess(null); setSlotCounts({}); setMissing(null); setHasIssue(false); setIssueNote(""); setGeoOkCount(0); return; }
    startM.mutateAsync({ buildingId, type, pairedIncomeExpenseId })
      .then(async (s) => {
        setSess(s);
        setSlotCounts(s.slot_counts ?? {});
        setGeoOkCount(await fetchGeoOkCount(s.session_id)); // resume phiên dở: biết ngay còn thiếu vị trí không
      })
      .catch(() => { toast.error("Không mở được phiên — thử lại nhé"); onOpenChange(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, buildingId, type]);

  // Đồng hồ dwell live: tick 15s để "đã ở X phút / còn Y phút" tự chạy, không cần bấm lại
  useEffect(() => {
    if (!open || !sess || sess.type !== "FULL") return;
    const t = setInterval(() => setNowTs(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [open, sess]);

  const doneCount = useMemo(
    () => (sess?.checklist ?? []).filter((c) => c.done).length,
    [sess],
  );

  // Dwell hiển thị = max(dwell server đã chốt, now - started_at) — khớp cách server chấm
  const dwellLiveSec = useMemo(() => {
    if (!sess) return 0;
    const fromStart = sess.started_at ? Math.floor((nowTs - new Date(sess.started_at).getTime()) / 1000) : 0;
    return Math.min(Math.max(sess.dwell_seconds, fromStart, 0), 900);
  }, [sess, nowTs]);
  const dwellRemainMin = sess ? Math.max(0, Math.ceil((sess.reqs.dwell_min_seconds - dwellLiveSec) / 60)) : 0;

  // Banner "còn thiếu" cập nhật LIVE theo việc vừa làm: dwell đếm lùi theo giờ
  // thật, mục vừa chụp thì rụng khỏi danh sách, có ảnh trong bán kính thì dòng
  // GPS tự biến mất — người dùng thấy mình đang tiến tới đâu, không phải bấm
  // Hoàn tất lại mới biết.
  const missingLive = useMemo(() => {
    if (!missing) return null;
    const doneLabels = new Set((sess?.checklist ?? []).filter((c) => c.done).map((c) => c.label));
    return missing
      .map((m) => {
        if (m.startsWith("Ở lại thêm")) return dwellRemainMin > 0 ? `Ở lại thêm ${dwellRemainMin} phút nữa` : null;
        if (m === GEO_MISSING) return geoOkCount > 0 ? null : m;
        if (m.startsWith("Còn ") && m.endsWith("ảnh nữa")) {
          const need = (sess?.reqs.photos_min ?? 0) - (sess?.photos_count ?? 0);
          return need > 0 ? `Còn ${need} ảnh nữa` : null;
        }
        return doneLabels.has(m) ? null : m;
      })
      .filter((m): m is string => !!m);
  }, [missing, dwellRemainMin, geoOkCount, sess]);

  const handleCaptured = async (result: JobCaptureResult) => {
    if (!sess || !cameraSlot) return;
    setBusy(true);
    try {
      const uid = authUser?.id ?? (await getSessionUserId()) ?? "anon";
      const upload = () =>
        uploadFile("job-attachments", `${uid}/inspections/${sess.session_id}/${Date.now()}-${cameraSlot}.jpg`, result.file);
      let url: string;
      try {
        url = await upload();
      } catch {
        url = await upload(); // mạng chập chờn: tự thử lại 1 lần (key mới theo timestamp)
      }
      const hash = await sha256File(result.file);
      const res = await photoM.mutateAsync({
        sessionId: sess.session_id, slot: cameraSlot, storagePath: url, sha256: hash,
        lat: result.lat, lng: result.lng,
      });
      if (!res.accepted) {
        toast.warning(res.message ?? "Ảnh chưa được nhận — chụp ảnh mới nhé");
      } else {
        const slot = cameraSlot;
        setSlotCounts((c) => ({ ...c, [slot]: (c[slot] ?? 0) + 1 }));
        setSess((s) => s ? {
          ...s,
          photos_count: s.photos_count + 1,
          checklist: s.checklist.map((c) => (c.key === slot ? { ...c, done: true } : c)),
        } : s);
        // Báo NGAY nếu ảnh không có bằng chứng vị trí — đừng để tới lúc bấm
        // Hoàn tất mới biết, khi mọi mục đã ✓ và không còn gì để bấm chụp.
        if (res.geofence_status === "ok") {
          setGeoOkCount((n) => n + 1);
        } else if (res.geofence_status === "out_of_range") {
          toast.warning(
            `Ảnh này cách toà ${Math.round(res.distance_m ?? 0)}m — ngoài bán kính. Cần ≥1 ảnh chụp sát toà để chốt ngày công.`,
            { duration: 7000 },
          );
        } else {
          toast.warning(
            "Ảnh đã lưu nhưng CHƯA bắt được vị trí. Ra chỗ thoáng (sân/vỉa hè) chụp thêm 1 tấm — cả buổi chỉ cần 1 ảnh có vị trí.",
            { duration: 7000 },
          );
        }
      }
    } catch (e: any) {
      const detail = e?.message ? ` (${e.message})` : "";
      toast.error(`Không tải được ảnh — kiểm tra mạng rồi thử lại, phiên vẫn còn nguyên${detail}`);
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
                {type === "FULL" && <> · tại toà ≥{Math.round(sess.reqs.dwell_min_seconds / 60)} phút (đã ở {Math.floor(dwellLiveSec / 60)}p)</>}
                {" · "}đã chụp {sess.photos_count} ảnh · {doneCount}/{sess.checklist.length} mục
                {geoOkCount > 0 && <> · <span className="text-emerald-600">{geoOkCount} ảnh có vị trí ✓</span></>}
              </div>

              {/* Thiếu bằng chứng vị trí — hiện NGAY từ ảnh đầu tiên, kèm việc cần làm */}
              {!missing && sess.photos_count > 0 && geoOkCount === 0 && (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
                  <div className="font-medium">Còn thiếu 1 ảnh có vị trí tại toà</div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Ảnh đã chụp chưa bắt được GPS (hay gặp khi đứng trong nhà/hầm bơm). Ra chỗ
                    thoáng — sân, vỉa hè, cạnh cửa sổ — chụp thêm 1 tấm bất kỳ là đủ. Mục đã ✓ vẫn
                    chụp thêm được.
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button size="sm" disabled={busy} onClick={() => setCameraSlot(sess.checklist[0]?.key ?? "gps")}>
                      <Camera className="mr-1 h-3.5 w-3.5" /> Chụp ảnh có vị trí
                    </Button>
                    <Button size="sm" variant="outline" disabled={busy} onClick={reportDevice}>
                      <ShieldAlert className="mr-1 h-3.5 w-3.5" /> GPS trục trặc — báo chủ duyệt
                    </Button>
                  </div>
                </div>
              )}

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
                    <span className="flex-1 pr-2">
                      {item.label}
                      {(slotCounts[item.key] ?? 0) > 0 && (
                        <span className="ml-1.5 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                          {slotCounts[item.key]} ảnh
                        </span>
                      )}
                    </span>
                    {item.done ? (
                      <span className="flex shrink-0 items-center gap-1.5">
                        <Check className="h-4 w-4 text-emerald-600" />
                        <Camera className="h-3.5 w-3.5 text-emerald-500" />
                      </span>
                    ) : (
                      <Camera className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                  </button>
                ))}
              </div>
              <p className="-mt-1 text-[11px] text-muted-foreground">
                Mục đã ✓ vẫn bấm chụp thêm được — không giới hạn số ảnh.
              </p>

              {missingLive && missingLive.length > 0 && (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
                  <div className="font-medium">{v5Copy.failBanner(missingLive.length)}</div>
                  <ul className="mt-1 list-inside list-disc text-xs text-muted-foreground">
                    {missingLive.map((m) => <li key={m}>{m}</li>)}
                  </ul>
                  {/* Dòng "cần ≥1 ảnh trong bán kính" KHÔNG ứng với mục checklist nào —
                      không có nút thì người dùng bí thật sự (mọi mục đã ✓). */}
                  {missingLive.includes(GEO_MISSING) && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button size="sm" disabled={busy} onClick={() => setCameraSlot(sess.checklist[0]?.key ?? "gps")}>
                        <Camera className="mr-1 h-3.5 w-3.5" /> Chụp ảnh có vị trí
                      </Button>
                      <Button size="sm" variant="outline" disabled={busy} onClick={reportDevice}>
                        <ShieldAlert className="mr-1 h-3.5 w-3.5" /> GPS trục trặc — báo chủ duyệt
                      </Button>
                    </div>
                  )}
                </div>
              )}
              {missing && missingLive && missingLive.length === 0 && (
                <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm font-medium text-emerald-700">
                  Đã đủ điều kiện — bấm Hoàn tất để chốt ngày công ✅
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
                Tắt app cũng không mất: phiên được lưu, mở lại từ "Ngày hôm nay của tôi".
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
