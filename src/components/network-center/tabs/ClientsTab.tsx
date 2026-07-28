import { ShieldAlert } from "lucide-react";

import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { NetworkBuilding } from "@/lib/network-center/contracts";

export function ClientsTab({ site, isDemo = true }: { site: NetworkBuilding; isDemo?: boolean }) {
  return (
    <section className="nc-panel">
      <div className="nc-panel-heading"><div><p className="nc-eyebrow">Ảnh chụp kết nối</p><h3>Thiết bị kết nối</h3></div><strong>{site.clients.length} dòng mẫu / {site.activeClients} client</strong></div>
      <Table>
        <TableCaption className="sr-only">Danh sách mẫu thiết bị đang kết nối</TableCaption>
        <TableHeader><TableRow><TableHead scope="col">Thiết bị</TableHead><TableHead scope="col">Người dùng / phiên{isDemo ? " demo" : ""}</TableHead><TableHead scope="col">Địa chỉ{isDemo ? " mô phỏng" : ""}</TableHead><TableHead scope="col">MAC{isDemo ? " mô phỏng" : ""}</TableHead><TableHead scope="col">Kiểu</TableHead><TableHead scope="col">Gợi ý khu</TableHead><TableHead scope="col">RX / TX</TableHead><TableHead scope="col">Cảnh báo</TableHead></TableRow></TableHeader>
        <TableBody>{site.clients.map((client) => (
          <TableRow key={client.id}>
            <TableHead scope="row"><strong>{client.hostname}</strong></TableHead>
            <TableCell><code>{client.userIdentity}</code><br /><small>{client.sessionIdentity}</small></TableCell>
            <TableCell>{client.address}</TableCell>
            <TableCell>{client.macAddress}</TableCell>
            <TableCell>{client.connection.toUpperCase()}</TableCell>
            <TableCell>{client.roomHint}</TableCell>
            <TableCell>{client.rxMbps} / {client.txMbps} Mbps</TableCell>
            <TableCell>{client.randomizedMac ? <span className="nc-inline-icon"><ShieldAlert /> MAC ngẫu nhiên</span> : "Không"}</TableCell>
          </TableRow>
        ))}</TableBody>
      </Table>
      <p className="nc-footnote">{isDemo
        ? "Bảng chỉ là mẫu; tên, phiên và khu vực đều là định danh mô phỏng, không dùng dữ liệu cư dân thật."
        : "Mỗi lần tải hiển thị tối đa 100 client mới nhất; liên kết phòng/khách thuê chỉ xuất hiện trong phạm vi quyền hiện tại."}</p>
    </section>
  );
}
