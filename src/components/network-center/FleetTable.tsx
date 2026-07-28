import { ArrowRight, Users } from "lucide-react";
import { Link } from "react-router-dom";

import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { NetworkBuilding } from "@/lib/network-center/contracts";
import { backupAgeText, summarizeAruba } from "@/lib/network-center/model";
import { NetworkStatus } from "./NetworkStatus";

export function FleetTable({ fleet }: { fleet: NetworkBuilding[] }) {
  if (!fleet.length) {
    return <div className="nc-no-results">Không có toà nhà khớp bộ lọc hiện tại.</div>;
  }

  return (
    <>
      <div className="nc-desktop-table">
        <Table>
          <TableCaption className="sr-only">Trạng thái mạng theo từng toà nhà</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Toà nhà / Router</TableHead>
              <TableHead scope="col">Sức khoẻ</TableHead>
              <TableHead scope="col">WAN</TableHead>
              <TableHead scope="col">CPU / RAM</TableHead>
              <TableHead scope="col">Client</TableHead>
              <TableHead scope="col">Aruba</TableHead>
              <TableHead scope="col">Sự cố</TableHead>
              <TableHead scope="col">Backup</TableHead>
              <TableHead scope="col">Firmware</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {fleet.map((site) => {
              const activeIncidents = site.incidents.filter((incident) => incident.status !== "resolved");
              const aruba = summarizeAruba(site);
              return (
                <TableRow key={site.buildingId}>
                  <TableHead scope="row">
                    <Link className="nc-building-link" to={`/network-center/buildings/${site.buildingId}`}>
                      <strong>{site.buildingName}</strong>
                      <span>{site.router.identity} · {site.router.model}</span>
                      <ArrowRight aria-hidden="true" />
                    </Link>
                  </TableHead>
                  <TableCell><NetworkStatus kind={site.health} /></TableCell>
                  <TableCell><strong>{site.router.wanStatus.toUpperCase()}</strong><small>{site.router.downloadMbps}/{site.router.uploadMbps} Mbps</small></TableCell>
                  <TableCell><strong>{site.router.cpuPercent}% / {site.router.memoryPercent}%</strong></TableCell>
                  <TableCell><span className="nc-inline-icon"><Users aria-hidden="true" /> {site.activeClients}</span></TableCell>
                  <TableCell><strong>{aruba.online === null ? "—" : aruba.online}/{aruba.total}</strong><small>Chỉ theo dõi</small></TableCell>
                  <TableCell><strong>{activeIncidents.length}</strong><small>đang mở</small></TableCell>
                  <TableCell><NetworkStatus kind={site.backupStatus} label={backupAgeText(site.backupAgeHours)} /></TableCell>
                  <TableCell><strong>{site.router.firmware}</strong><small>Chuẩn {site.router.targetFirmware}</small></TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <div className="nc-mobile-cards">
        {fleet.map((site) => {
          const activeIncidents = site.incidents.filter((incident) => incident.status !== "resolved").length;
          const aruba = summarizeAruba(site);
          return (
            <article className="nc-mobile-site" key={site.buildingId}>
              <div className="nc-mobile-site-heading">
                <div><h3>{site.buildingName}</h3><p>{site.router.identity} · {site.router.model}</p></div>
                <NetworkStatus kind={site.health} />
              </div>
              <dl className="nc-mobile-site-grid">
                <div><dt>WAN</dt><dd>{site.router.wanStatus.toUpperCase()} · {site.router.downloadMbps}/{site.router.uploadMbps} Mbps</dd></div>
                <div><dt>CPU / RAM</dt><dd>{site.router.cpuPercent}% / {site.router.memoryPercent}%</dd></div>
                <div><dt>Client</dt><dd>{site.activeClients}</dd></div>
                <div><dt>Aruba</dt><dd>{aruba.online === null ? "—" : aruba.online}/{aruba.total} chỉ theo dõi</dd></div>
                <div><dt>Sự cố</dt><dd>{activeIncidents} đang mở</dd></div>
                <div><dt>Backup</dt><dd>{backupAgeText(site.backupAgeHours)} · {site.backupStatus === "fresh" ? "mới" : "cũ"}</dd></div>
                <div><dt>Firmware</dt><dd>{site.router.firmware} / chuẩn {site.router.targetFirmware}</dd></div>
              </dl>
              <Link className="nc-card-link" to={`/network-center/buildings/${site.buildingId}`}>
                Mở không gian toà nhà <ArrowRight aria-hidden="true" />
              </Link>
            </article>
          );
        })}
      </div>
    </>
  );
}
