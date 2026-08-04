import { LockKeyhole } from "lucide-react";

import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { NetworkBuilding } from "@/lib/network-center/contracts";
import { NetworkStatus } from "../NetworkStatus";

export function InterfacesTab({ site, isDemo = true }: { site: NetworkBuilding; isDemo?: boolean }) {
  return (
    <section className="nc-panel">
      <div className="nc-panel-heading"><div><p className="nc-eyebrow">MikroTik</p><h3>Cổng giao tiếp</h3></div><span>WAN/uplink được bảo vệ khỏi thao tác ghi</span></div>
      <Table>
        <TableCaption className="sr-only">Trạng thái và lưu lượng từng cổng MikroTik</TableCaption>
        <TableHeader><TableRow><TableHead scope="col">Cổng</TableHead><TableHead scope="col">Vai trò</TableHead><TableHead scope="col">Link</TableHead><TableHead scope="col">RX / TX</TableHead><TableHead scope="col">Sử dụng</TableHead><TableHead scope="col">Error / Discard</TableHead><TableHead scope="col">Bảo vệ</TableHead></TableRow></TableHeader>
        <TableBody>{site.interfaces.map((item) => (
          <TableRow key={item.id}>
            <TableHead scope="row"><strong>{item.name}</strong></TableHead>
            <TableCell>{item.role.toUpperCase()}</TableCell>
            <TableCell><NetworkStatus kind={item.status === "up" ? "online" : "offline"} label={item.status.toUpperCase()} /></TableCell>
            <TableCell>{item.rxMbps} / {item.txMbps} Mbps</TableCell>
            <TableCell><progress max={100} value={item.utilizationPercent} aria-label={`Sử dụng ${item.name}`} /> {item.utilizationPercent}%</TableCell>
            <TableCell>{item.errors} / {item.discards}</TableCell>
            <TableCell>{item.protected ? <span className="nc-inline-icon"><LockKeyhole /> Đã khoá</span> : item.status === "up" ? (isDemo ? "Cho phép mô phỏng tắt/bật" : "Cho phép tắt/bật có kiểm soát") : "Không khả dụng khi link down"}</TableCell>
          </TableRow>
        ))}</TableBody>
      </Table>
    </section>
  );
}
