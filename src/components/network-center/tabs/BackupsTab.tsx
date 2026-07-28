import { Camera, CheckCircle2 } from "lucide-react";

import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { NetworkCenterController } from "@/hooks/network-center/useNetworkCenter";
import type { NetworkBuilding } from "@/lib/network-center/contracts";
import { ConfigDiffDialog } from "../ConfigDiffDialog";
import { ExecuteButton } from "../ExecuteGuard";
import { NetworkStatus } from "../NetworkStatus";

const revisionSourceLabel = {
  scheduled: "Lịch tự động",
  manual: "Thủ công",
  pre_action: "Trước thao tác",
} as const;

export function BackupsTab({ site, controller }: { site: NetworkBuilding; controller: NetworkCenterController }) {
  return (
    <section className="nc-panel">
      <div className="nc-panel-heading">
        <div><p className="nc-eyebrow">Bản cấu hình đã làm sạch</p><h3>Sao lưu & so sánh</h3></div>
        <div className="nc-heading-actions">
          <ConfigDiffDialog siteId={site.buildingId} revisions={site.revisions} compare={(from, to) => controller.compareRevisions(site.buildingId, from, to)} />
          <ExecuteButton canExecute={controller.canExecute} disabledReason={controller.executeDisabledMessage} onClick={() => controller.captureConfiguration(site.buildingId, "Ảnh chụp thủ công") }>
            <Camera data-icon="inline-start" /> Chụp cấu hình
          </ExecuteButton>
        </div>
      </div>
      <p className="nc-footnote">Chụp cấu hình chỉ tạo ảnh chụp đã làm sạch trong bộ nhớ mô phỏng cục bộ.</p>
      <div className="nc-backup-summary"><NetworkStatus kind={site.backupStatus} label={`Bản mới nhất ${site.backupAgeHours} giờ`} /><span><CheckCircle2 /> Mã băm và nội dung so sánh chỉ dùng dữ liệu đã làm sạch.</span></div>
      <Table>
        <TableCaption className="sr-only">Các bản cấu hình đã làm sạch trong mô phỏng cục bộ</TableCaption>
        <TableHeader><TableRow><TableHead scope="col">Bản cấu hình</TableHead><TableHead scope="col">Thời điểm</TableHead><TableHead scope="col">Nguồn</TableHead><TableHead scope="col">SHA-256 mô phỏng cục bộ</TableHead><TableHead scope="col">Thay đổi</TableHead></TableRow></TableHeader>
        <TableBody>{site.revisions.map((revision) => (
          <TableRow key={revision.id}><TableHead scope="row"><strong>{revision.label}</strong></TableHead><TableCell>{new Date(revision.capturedAt).toLocaleString("vi-VN")}</TableCell><TableCell>{revisionSourceLabel[revision.source]}</TableCell><TableCell><code>{revision.hash}</code></TableCell><TableCell>{revision.changeCount}</TableCell></TableRow>
        ))}</TableBody>
      </Table>
    </section>
  );
}
