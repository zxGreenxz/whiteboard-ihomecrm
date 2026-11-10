import { useState } from "react";
import { AlertTriangle, Loader2, Share2, ShieldAlert, UserRoundCheck } from "lucide-react";
import { LoadingState } from "@/components/loading/LoadingState";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCameraShares, useRevokeCameraShare, type CameraShareScope } from "@/hooks/network-center/useCameraShares";
import { cameraTimeLabel } from "@/lib/network-center/cameraArchive";
import type { CameraRecorder } from "@/lib/network-center/cameraContracts";
import {
  CameraShareError, cameraShareChannelLabel, cameraShareStatusLabel, cameraShareWindowLabel, recorderChannelName,
  type CameraShareCreated, type CameraShareRow, type CameraShareStatus,
} from "@/lib/network-center/cameraShare";
import { cn } from "@/lib/utils";
import { CameraShareResultDialog, CreateCameraShareDialog } from "./CameraShareDialogs";

const statusTone: Record<CameraShareStatus, string> = {
  ACTIVE: "border-transparent bg-emerald-600 text-white",
  EXPIRED: "border-transparent bg-muted text-muted-foreground",
  REVOKED: "border-destructive/50 bg-background text-destructive",
};

function ShareItem({ share, recorder, onRevoke }: { share: CameraShareRow; recorder: CameraRecorder; onRevoke(): void }) {
  const label = cameraShareChannelLabel(share.channel, share.channel_name ?? recorderChannelName(recorder, share.channel));
  return (
    <li className="space-y-1.5 rounded-md border p-3" aria-label={`Lượt chia sẻ ${share.code}`}>
      <div className="flex flex-wrap items-center gap-2">
        <strong className="min-w-0 break-words">{label}</strong>
        <Badge variant="outline" className={cn(statusTone[share.status])}>{cameraShareStatusLabel[share.status]}</Badge>
        <span className="font-mono text-xs text-muted-foreground">ID {share.code}</span>
      </div>
      <p className="text-sm">Khung giờ: {cameraShareWindowLabel(share.window_start, share.window_end)}</p>
      {share.note && <p className="break-words text-sm">Ghi chú: {share.note}</p>}
      <p className="text-xs text-muted-foreground">
        Tạo bởi {share.created_by_name ?? "không rõ"} lúc {cameraTimeLabel(share.created_at)}
        {" · "}
        {share.status === "REVOKED" && share.revoked_at ? `Thu hồi lúc ${cameraTimeLabel(share.revoked_at)}` : `${share.status === "ACTIVE" ? "Hết hạn lúc" : "Đã hết hạn lúc"} ${cameraTimeLabel(share.expires_at)}`}
      </p>
      <p className="flex items-center gap-1 text-xs">
        <UserRoundCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {share.login_count > 0 && share.last_login_at
          ? `Khách đã vào ${share.login_count} lần · lần cuối ${cameraTimeLabel(share.last_login_at)}`
          : "Khách chưa vào xem"}
      </p>
      {share.status === "ACTIVE" && <Button type="button" variant="outline" size="sm" className="min-h-11" onClick={onRevoke} aria-label={`Thu hồi lượt chia sẻ ${share.code}`}>Thu hồi</Button>}
    </li>
  );
}

/** Chia sẻ một kênh của đầu ghi cho khách xem lại trong khung giờ có hạn. Danh sách gộp theo tòa, lọc theo đầu ghi này. */
export default function CameraSharePanel({ recorder, buildingName, scope }: { recorder: CameraRecorder; buildingName: string; scope: CameraShareScope }) {
  const sharesQuery = useCameraShares(scope);
  const revoke = useRevokeCameraShare(scope);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CameraShareCreated | null>(null);
  const [revoking, setRevoking] = useState<CameraShareRow | null>(null);
  const [revokeError, setRevokeError] = useState("");
  const [notice, setNotice] = useState("");
  const shares = (sharesQuery.data ?? []).filter((share) => share.recorder_id === recorder.id);
  const listError = sharesQuery.error;
  const denied = listError instanceof CameraShareError && listError.kind === "permission";

  const confirmRevoke = async () => {
    if (!revoking) return;
    setRevokeError("");
    try {
      const result = await revoke.mutateAsync(revoking.id);
      setNotice(result.status === "REVOKED" ? `Đã thu hồi lượt chia sẻ ${revoking.code}. Khách đang xem sẽ bị ngắt trong giây lát.` : `Lượt chia sẻ ${revoking.code} đã kết thúc trước đó.`);
      setRevoking(null);
    } catch (error) {
      setRevokeError(error instanceof CameraShareError ? error.message : "Chưa thu hồi được. Vui lòng thử lại.");
    }
  };

  return (
    <section className="nc-panel" aria-label={`Chia sẻ camera ${recorder.display_name}`}>
      <div className="nc-panel-heading">
        <div><p className="nc-eyebrow">Xem lại có thời hạn</p><h3 className="flex items-center gap-2"><Share2 className="h-5 w-5" aria-hidden="true" />Chia sẻ cho khách · {recorder.display_name}</h3></div>
        <Button type="button" disabled={denied || !recorder.enabled} onClick={() => { setNotice(""); setCreating(true); }}>
          <Share2 className="mr-2 h-4 w-4" aria-hidden="true" />Chia sẻ camera
        </Button>
      </div>
      <div className="space-y-3 p-4">
        <p className="text-sm text-muted-foreground">Tạo ID + mật khẩu để khách tự xem lại một camera trong khung giờ đã chọn (tối đa 24 giờ). Link tự hết hạn; thu hồi được bất cứ lúc nào.</p>
        {!recorder.enabled && <p className="text-sm" role="status">Đầu ghi đang tạm dừng theo dõi nên chưa tạo được lượt chia sẻ mới.</p>}
        {notice && <p role="status" className="text-sm">{notice}</p>}
        {sharesQuery.isPending && sharesQuery.fetchStatus !== "idle" ? <LoadingState label="danh sách chia sẻ" variant="list" rows={2} /> : null}
        {listError ? (
          <div role="alert" className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/40 p-3 text-sm">
            {denied ? <ShieldAlert className="h-5 w-5 shrink-0" aria-hidden="true" /> : <AlertTriangle className="h-5 w-5 shrink-0" aria-hidden="true" />}
            <p className="min-w-0 flex-1">{listError instanceof CameraShareError ? listError.message : "Không tải được danh sách chia sẻ."}</p>
            {!denied && <Button type="button" variant="outline" disabled={sharesQuery.isFetching} onClick={() => void sharesQuery.refetch()}>Tải lại danh sách</Button>}
          </div>
        ) : null}
        {sharesQuery.isSuccess && shares.length === 0 && <p className="nc-empty-copy">Chưa có lượt chia sẻ nào của đầu ghi này trong 30 ngày qua.</p>}
        {shares.length > 0 && <ul className="space-y-2" aria-label="Các lượt chia sẻ">
          {shares.map((share) => <ShareItem key={share.id} share={share} recorder={recorder} onRevoke={() => { setRevokeError(""); setRevoking(share); }} />)}
        </ul>}
      </div>
      <CreateCameraShareDialog open={creating} onOpenChange={setCreating} recorder={recorder} scope={scope} onCreated={setCreated} />
      <CameraShareResultDialog result={created} recorder={recorder} buildingName={buildingName} onClose={() => setCreated(null)} />
      <AlertDialog open={revoking !== null} onOpenChange={(open) => { if (!open && !revoke.isPending) setRevoking(null); }}>
        <AlertDialogContent className="max-w-[calc(100vw-1.5rem)] sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Thu hồi lượt chia sẻ?</AlertDialogTitle>
            <AlertDialogDescription>
              {revoking ? `ID ${revoking.code} · ${cameraShareChannelLabel(revoking.channel, revoking.channel_name ?? recorderChannelName(recorder, revoking.channel))}. ` : ""}
              Khách không mở lại được link; người đang xem bị ngắt trong khoảng 30 giây. Không hoàn tác được — muốn cho xem tiếp phải tạo lượt mới.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {revokeError && <p role="alert" className="text-sm text-destructive">{revokeError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoke.isPending}>Huỷ</AlertDialogCancel>
            <Button type="button" variant="destructive" disabled={revoke.isPending} onClick={() => void confirmRevoke()}>
              {revoke.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}Thu hồi ngay
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
