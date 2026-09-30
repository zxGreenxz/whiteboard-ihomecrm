import { networkFeedback } from "@/lib/network-center/feedback";
import { Camera, CheckCircle2 } from "lucide-react";
import { useState } from "react";

import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { NetworkCenterController } from "@/hooks/network-center/useNetworkCenter";
import type { NetworkBuilding } from "@/lib/network-center/contracts";
import { backupAgeText } from "@/lib/network-center/model";
import { ConfigDiffDialog } from "../ConfigDiffDialog";
import { ExecuteButton } from "../ExecuteGuard";
import { NetworkStatus } from "../NetworkStatus";

const revisionSourceLabel = {
  scheduled: "Lịch tự động",
  manual: "Thủ công",
  pre_action: "Trước thao tác",
} as const;

export function BackupsTab({ site, controller }: { site: NetworkBuilding; controller: NetworkCenterController }) {
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const capture = async () => {
    if (capturing || uncertain) return;
    setCapturing(true);
    setError("");
    setResult("");
    try {
      await controller.captureConfiguration(site.buildingId, "Ảnh chụp thủ công");
      setResult(controller.isDemo ? `Đã tạo bản cấu hình mô phỏng của ${site.router.identity}.` : `Đã tiếp nhận yêu cầu sao lưu ${site.router.identity}. Trạng thái hoàn tất sẽ hiển thị khi có bản sao lưu.`);
    } catch (caught) {
      const feedback = networkFeedback(caught, `sao lưu cấu hình ${site.router.identity}`);
      setError(feedback.description);
      setUncertain(feedback.outcome === "unknown");
    } finally {
      setCapturing(false);
    }
  };
  return (
    <section className="nc-panel">
      <div className="nc-panel-heading">
        <div><p className="nc-eyebrow">Bản cấu hình đã làm sạch</p><h3>Sao lưu & so sánh</h3></div>
        <div className="nc-heading-actions">
          <ConfigDiffDialog siteId={site.buildingId} revisions={site.revisions} compare={(from, to) => controller.compareRevisions(site.buildingId, from, to)} />
          <ExecuteButton canExecute={controller.canExecute} rolloutState={site.rolloutState} disabledReason={controller.executeDisabledMessage} disabled={capturing || uncertain} onClick={() => void capture()}>
            <Camera data-icon="inline-start" /> {capturing ? "Đang gửi…" : "Chụp cấu hình"}
          </ExecuteButton>
        </div>
      </div>
      <p className="nc-footnote">{controller.isDemo
        ? "Chụp cấu hình chỉ tạo ảnh chụp đã làm sạch trong bộ nhớ mô phỏng cục bộ."
        : "Yêu cầu sao lưu được đưa vào hàng đợi. Danh sách bên dưới chỉ hiển thị các bản đã hoàn tất, đã ẩn thông tin nhạy cảm."}</p>
      {error ? <p className="nc-form-error" role="alert">{error}</p> : null}
      {result ? <p role="status">{result}</p> : null}
      <div className="nc-backup-summary"><NetworkStatus kind={site.backupStatus} label={site.backupAgeHours < 0 ? "Chưa có bản sao lưu" : `Bản mới nhất ${backupAgeText(site.backupAgeHours)}`} /><span><CheckCircle2 /> Mã băm và nội dung so sánh chỉ dùng dữ liệu đã làm sạch.</span></div>
      <Table>
        <TableCaption className="sr-only">Các bản cấu hình đã làm sạch</TableCaption>
        <TableHeader><TableRow><TableHead scope="col">Bản cấu hình</TableHead><TableHead scope="col">Thời điểm</TableHead><TableHead scope="col">Nguồn</TableHead><TableHead scope="col">SHA-256</TableHead><TableHead scope="col">Thay đổi</TableHead></TableRow></TableHeader>
        <TableBody>{site.revisions.map((revision) => (
          <TableRow key={revision.id}><TableHead scope="row"><strong>{revision.label}</strong></TableHead><TableCell>{new Date(revision.capturedAt).toLocaleString("vi-VN")}</TableCell><TableCell>{revisionSourceLabel[revision.source]}</TableCell><TableCell><code>{revision.hash}</code></TableCell><TableCell>{revision.changeCount}</TableCell></TableRow>
        ))}</TableBody>
      </Table>
    </section>
  );
}
