import { CheckCircle2, LockKeyhole, ShieldCheck } from "lucide-react";

import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { NetworkBuilding } from "@/lib/network-center/contracts";

const checks = [
  ["Thông tin đăng nhập", "Không được tải vào giao diện"],
  ["CLI tuỳ ý", "Bị khoá"],
  ["Thao tác ghi Aruba", "Bị khoá"],
  ["NTP", "Đồng bộ mô phỏng"],
  ["Tính toàn vẹn backup", "Mã mô phỏng hợp lệ"],
  ["Độ mới tiến trình", "Không áp dụng trong giao diện demo"],
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

export function AuditTab({ site }: { site: NetworkBuilding }) {
  return (
    <div className="nc-tab-stack">
      <section className="nc-security-grid">
        {checks.map(([label, value]) => <article key={label}><ShieldCheck /><span>{label}</span><strong>{value}</strong></article>)}
      </section>
      <section className="nc-panel">
        <div className="nc-panel-heading"><div><p className="nc-eyebrow">Nhật ký mô phỏng theo trình tự</p><h3>Nhật ký & Bảo mật</h3></div><span><LockKeyhole /> Không chứa dữ liệu bí mật hoặc lệnh CLI gốc</span></div>
        <Table>
          <TableCaption className="sr-only">Nhật ký thao tác và kiểm tra bảo mật mô phỏng cục bộ</TableCaption>
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
                  <strong>Kết quả mô phỏng:</strong>
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
