import { CheckCircle2, CircleDashed, CircleX, Clock3, RotateCcw, SkipForward } from "lucide-react";

import type { JobStage, NetworkBuilding, NetworkJob } from "@/lib/network-center/contracts";

const jobStatus = {
  queued: { label: "Đang chờ", icon: Clock3 },
  running: { label: "Đang chạy", icon: CircleDashed },
  success: { label: "Thành công", icon: CheckCircle2 },
  failed: { label: "Thất bại", icon: CircleX },
  rolled_back: { label: "Đã hoàn tác", icon: RotateCcw },
} satisfies Record<NetworkJob["status"], { label: string; icon: typeof CheckCircle2 }>;

const stageStatus = {
  pending: { label: "Đang chờ", icon: Clock3 },
  running: { label: "Đang chạy", icon: CircleDashed },
  success: { label: "Thành công", icon: CheckCircle2 },
  failed: { label: "Thất bại", icon: CircleX },
  skipped: { label: "Bỏ qua", icon: SkipForward },
} satisfies Record<JobStage["status"], { label: string; icon: typeof CheckCircle2 }>;

function StructuredFields({
  fields,
  emptyLabel,
}: {
  fields: object;
  emptyLabel: string;
}) {
  const entries = Object.entries(fields);
  if (entries.length === 0) return <span>{emptyLabel}</span>;

  return (
    <dl className="mt-1 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
      {entries.map(([key, value]) => (
        <div className="contents" key={key}>
          <dt><code>{key}</code></dt>
          <dd className="break-all">{String(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ChangesTab({ site }: { site: NetworkBuilding }) {
  return (
    <section className="nc-panel">
      <div className="nc-panel-heading"><div><p className="nc-eyebrow">Mô phỏng cục bộ · không gọi router thật</p><h3>Thay đổi</h3></div><strong>{site.jobs.length} lần thực hiện mô phỏng</strong></div>
      {site.jobs.length ? (
        <ol className="nc-job-list" aria-live="polite">
          {site.jobs.map((job) => {
            const currentJobStatus = jobStatus[job.status];
            const JobStatusIcon = currentJobStatus.icon;
            return (
            <li key={job.id}>
              <div className="nc-job-heading"><div><p>{new Date(job.createdAt).toLocaleString("vi-VN")}</p><h4>{job.actionLabel}</h4></div><span className={`nc-job-status nc-status-${job.status}`}><JobStatusIcon /> {currentJobStatus.label}</span></div>
              <p><strong>Lý do:</strong> {job.reason}</p>
              <p><strong>Người thực hiện:</strong> {job.actor.label}</p>
              <p><strong>Mã thao tác:</strong> <code>{job.action}</code></p>
              <div><strong>Mục tiêu thực hiện:</strong><StructuredFields fields={job.target} emptyLabel="Không có mục tiêu" /></div>
              <div className="mt-2"><strong>Tham số thao tác:</strong><StructuredFields fields={job.parameters} emptyLabel="Không có tham số" /></div>
              <ol className="nc-stage-list">{job.stages.map((stage) => {
                const currentStageStatus = stageStatus[stage.status];
                const StageStatusIcon = currentStageStatus.icon;
                return <li className={`nc-stage-${stage.status}`} key={stage.key}><StageStatusIcon /><div><strong>{stage.label}</strong><span>{currentStageStatus.label}</span><p>{stage.detail}</p></div></li>;
              })}</ol>
              <div className="nc-job-result"><strong>Kết quả mô phỏng:</strong> {job.result}</div>
            </li>
          );})}
        </ol>
      ) : <div className="nc-no-results">Chưa có lần thực hiện. Chạy một thao tác được phép trong tab Cấu hình để xem đủ 5 giai đoạn.</div>}
    </section>
  );
}
