import { CheckCircle2, LockKeyhole, ShieldCheck } from "lucide-react";

import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { NetworkBuilding } from "@/lib/network-center/contracts";

const checks = (isDemo: boolean) => [
  ["Thông tin đăng nhập", "Không được tải vào giao diện"],
  ["CLI tuỳ ý", "Bị khoá"],
  ["Thao tác ghi Aruba", "Bị khoá"],
  ["NTP", isDemo ? "Đồng bộ mô phỏng" : "Theo thời gian worker"],
  ["Tính toàn vẹn backup", isDemo ? "Mã mô phỏng hợp lệ" : "SHA-256 đã xác minh"],
  ["Độ mới tiến trình", isDemo ? "Không áp dụng trong giao diện demo" : "Theo heartbeat worker"],
];

function StructuredFields({
  fields,
  emptyLabel,
}: {
  fields: Record<string, string | number | boolean>;
  emptyLabel: string;
}) {
  const entries = Object.entries(fields);
  if (entries.length === 0) return <span>{emptyLabel}</span>;

  return (
    <dl className="mt-1 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
      {entries.map(([key, value]) => (
        <div className="contents" key={key}>
          <dt><code>{key}</code></dt>
          <dd className="break-all">{String(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function AuditTab({ site, isDemo = true }: { site: NetworkBuilding; isDemo?: boolean }) {
  return (
    <div className="nc-tab-stack">
      <section className="nc-security-grid">
        {checks(isDemo).map(([label, value]) => <article key={label}><ShieldCheck /><span>{label}</span><strong>{value}</strong></article>)}
      </section>
      <section className="nc-panel">
        <div className="nc-panel-heading"><div><p className="nc-eyebrow">{isDemo ? "Nhật ký mô phỏng theo trình tự" : "Nhật ký bất biến theo trình tự"}</p><h3>Nhật ký & Bảo mật</h3></div><span><LockKeyhole /> Không chứa dữ liệu bí mật hoặc lệnh CLI gốc</span></div>
        <Table>
          <TableCaption className="sr-only">Nhật ký thao tác và kiểm tra bảo mật</TableCaption>
          <TableHeader><TableRow><TableHead scope="col">Thời điểm</TableHead><TableHead scope="col">Người thực hiện</TableHead><TableHead scope="col">Hành động</TableHead><TableHead scope="col">Mục tiêu</TableHead><TableHead scope="col">Chi tiết</TableHead><TableHead scope="col">Kết quả</TableHead></TableRow></TableHeader>
          <TableBody>{site.audit.map((record) => (
            <TableRow key={record.id}>
              <TableHead scope="row">{new Date(record.at).toLocaleString("vi-VN")}</TableHead>
              <TableCell>{record.actor}</TableCell>
              <TableCell><strong>{record.action}</strong><br /><code>{record.actionType}</code></TableCell>
              <TableCell>{record.target.buildingName} · {record.target.routerIdentity}{record.target.interfaceName ? ` · ${record.target.interfaceName}` : ""}</TableCell>
              <TableCell>
                <p>{record.detail}</p>
                <p className="mt-2"><strong>Lý do ghi nhật ký:</strong> {record.reason}</p>
                <div className="mt-2"><strong>Tham số ghi nhận:</strong><StructuredFields fields={record.parameters} emptyLabel="Không có tham số" /></div>
              </TableCell>
              <TableCell>
                <span className="nc-inline-icon"><CheckCircle2 /> {record.outcome === "success" ? "Thành công" : "Thông tin"}</span>
                <div className="mt-2">
                  <strong>{isDemo ? "Kết quả mô phỏng:" : "Kết quả ghi nhận:"}</strong>
                  <dl className="mt-1 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                    <dt>Trạng thái</dt><dd>{record.outcome}</dd>
                    <dt>Kiểm tra</dt><dd>{record.validation}</dd>
                    <dt>Kết quả</dt><dd>{record.result}</dd>
                  </dl>
                </div>
              </TableCell>
            </TableRow>
          ))}</TableBody>
        </Table>
      </section>
    </div>
  );
}
