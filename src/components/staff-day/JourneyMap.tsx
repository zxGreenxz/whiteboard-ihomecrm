// Bản đồ hành trình một ngày. Leaflet nạp động để không vào chunk đầu của trang.
// Không có ảnh nền (mạng hoặc CSP chặn) thì lùi về danh sách điểm dừng, không để khung trống.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Map as LeafletMap } from "leaflet";
import { ExternalLink } from "lucide-react";
import {
  formatDistance, journeyPath, pathDistanceMeters, vnTime,
  type GpsSlot, type JourneyStop, type OutOfRangePoint,
} from "@/lib/staffDay";

/**
 * Nguồn ảnh nền theo thứ tự thử. Đổi ở đây thì sửa cả `img-src` trong vercel.json và scripts/test-env/chrome.mjs.
 * Có nguồn dự phòng vì đo 09/11/2026: mạng văn phòng không phân giải được tên miền openstreetmap.org
 * (DNS trả NXDOMAIN, đi thẳng IP vẫn HTTP 200). Hai máy chủ cộng đồng OSM Đức/Pháp vẫn tải được.
 * Không dùng CARTO: từ 2026 ảnh không khoá bị đóng dấu «API KEY REQUIRED».
 */
const TILE_PROVIDERS: readonly { url: string; subdomains?: string }[] = [
  { url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png" },
  { url: "https://tile.openstreetmap.de/{z}/{x}/{y}.png" },
  { url: "https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png", subdomains: "abc" },
];
const TILE_ATTRIBUTION = "© OpenStreetMap";

const STOP_COLOR: Record<JourneyStop["state"], string> = {
  passed: "#16a34a",
  open: "#16a34a",
  presence: "#d97706",
  job: "#7c3aed",
  payment: "#ea580c",
};

function StopList({ stops }: { stops: readonly JourneyStop[] }) {
  return (
    <ol className="list-none divide-y">
      {stops.map((stop) => (
        <li key={`${stop.seq}-${stop.firstAt}`} className="flex items-center gap-2 px-3 py-2 text-sm">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white" style={{ background: STOP_COLOR[stop.state] }}>{stop.seq}</span>
          <span className="min-w-0 flex-1 truncate font-medium">{stop.name}</span>
          <span className="text-xs text-muted-foreground">{vnTime(stop.firstAt)}</span>
          <a className="flex h-8 w-8 items-center justify-center text-primary" aria-label={`Mở ${stop.name} trên Google Maps`} target="_blank" rel="noreferrer" href={`https://www.google.com/maps?q=${stop.lat},${stop.lng}`}>
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
          </a>
        </li>
      ))}
    </ol>
  );
}

export function JourneyMap({ stops, slots, outOfRange }: {
  stops: readonly JourneyStop[];
  slots: readonly GpsSlot[];
  outOfRange: readonly OutOfRangePoint[];
}) {
  const holder = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const path = useMemo(() => journeyPath(stops, slots), [stops, slots]);
  const distance = useMemo(() => pathDistanceMeters(path), [path]);
  const signature = useMemo(
    () => JSON.stringify([stops.map((s) => [s.lat, s.lng, s.state]), path.map((p) => [p.lat, p.lng]), outOfRange]),
    [stops, path, outOfRange],
  );
  const hasPoints = path.length > 0;

  useEffect(() => {
    if (!hasPoints || !holder.current) return undefined;
    let cancelled = false;
    let map: LeafletMap | undefined;

    void (async () => {
      const [{ default: L }] = await Promise.all([import("leaflet"), import("leaflet/dist/leaflet.css")]);
      if (cancelled || !holder.current) return;
      map = L.map(holder.current, { scrollWheelZoom: false });

      const target = map;
      const addTiles = (index: number) => {
        const provider = TILE_PROVIDERS[index];
        if (!provider) {
          setFailed(true);
          return;
        }
        let loaded = 0;
        let errors = 0;
        let moved = false;
        const layer = L.tileLayer(provider.url, {
          maxZoom: 19, attribution: TILE_ATTRIBUTION, subdomains: provider.subdomains ?? "abc",
        })
          .on("tileload", () => { loaded += 1; })
          .on("tileerror", () => {
            errors += 1;
            if (errors >= 4 && loaded === 0 && !moved && !cancelled) {
              moved = true;
              target.removeLayer(layer);
              addTiles(index + 1);
            }
          });
        layer.addTo(target);
      };
      addTiles(0);

      const line = path.map((p): [number, number] => [p.lat, p.lng]);
      if (line.length > 1) L.polyline(line, { color: "#3b82f6", weight: 3, dashArray: "6 5" }).addTo(map);

      for (const point of path) {
        if (point.kind !== "gps") continue;
        L.circleMarker([point.lat, point.lng], {
          radius: 5, color: "#ffffff", weight: 2, fillColor: "#8a9690", fillOpacity: 1,
        }).addTo(map);
      }
      for (const point of outOfRange) {
        L.circleMarker([point.lat, point.lng], {
          radius: 8, color: "#dc2626", weight: 1.5, dashArray: "3 2", fillColor: "#ef4444", fillOpacity: 0.15,
        }).addTo(map).bindTooltip(point.distance != null ? `Ảnh ngoài vùng ${formatDistance(point.distance)}` : "Ảnh ngoài vùng");
      }
      for (const stop of stops) {
        // Leaflet gán chuỗi vào innerHTML; tên toà là dữ liệu người dùng nên truyền phần tử dựng bằng textContent.
        const tooltip = document.createElement("span");
        tooltip.textContent = `${stop.name} · ${vnTime(stop.firstAt)}`;
        L.marker([stop.lat, stop.lng], {
          title: stop.name,
          icon: L.divIcon({
            className: "",
            iconSize: [26, 26],
            html: `<div style="width:26px;height:26px;border-radius:999px;background:${STOP_COLOR[stop.state]};border:2.5px solid #fff;color:#fff;font:700 12px/21px system-ui,sans-serif;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.35)">${stop.seq}</div>`,
          }),
        }).addTo(map).bindTooltip(tooltip);
      }

      map.fitBounds(L.latLngBounds(line), { padding: [32, 32], maxZoom: 16 });
    })().catch(() => { if (!cancelled) setFailed(true); });

    return () => {
      cancelled = true;
      map?.remove();
    };
    // `signature` đại diện cho toàn bộ dữ liệu vẽ; đổi tham chiếu mảng mà không đổi dữ liệu thì không vẽ lại.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, hasPoints]);

  return (
    <section aria-label="Bản đồ dấu chân trong ngày" className="overflow-hidden rounded-2xl border bg-white shadow-sm">
      {!hasPoints ? (
        <p className="p-4 text-sm text-muted-foreground">Ngày này chưa có dấu chân nào có toạ độ để vẽ bản đồ.</p>
      ) : failed ? (
        <>
          <p role="status" className="border-b px-3 py-2 text-xs text-muted-foreground">Chưa tải được bản đồ nền. Danh sách điểm dừng theo thứ tự:</p>
          <StopList stops={stops} />
        </>
      ) : (
        <div ref={holder} className="isolate h-[250px] w-full lg:h-[360px]" />
      )}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t px-3 py-2.5 text-[11px] text-slate-700">
        <span className="flex items-center gap-1.5"><span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-emerald-600" />Kiểm tra nhà</span>
        <span className="flex items-center gap-1.5"><span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-violet-600" />Việc</span>
        <span className="flex items-center gap-1.5"><span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-[#8a9690]" />Điểm danh</span>
        <span className="flex items-center gap-1.5"><span aria-hidden="true" className="h-2.5 w-2.5 rounded-full border-2 border-dashed border-red-600" />Ảnh ngoài bán kính</span>
        {distance > 0 ? <span className="ml-auto text-muted-foreground">~{formatDistance(distance)} theo dấu chân</span> : null}
      </div>
    </section>
  );
}
