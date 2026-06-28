// =============================================================================
// captureWatermark.ts — dữ liệu + vẽ watermark "Timemark-style" cho ảnh nghiệm
// thu công việc. buildWatermarkLines() trả model đã format (dùng chung cho
// overlay live bằng JSX và burn vào ảnh bằng canvas qua drawWatermark()).
// =============================================================================

export type GeofenceStatus =
  | 'ok' // có toạ độ tòa + trong bán kính
  | 'out_of_range' // có toạ độ tòa + ngoài bán kính
  | 'gps_denied' // không lấy được vị trí (từ chối/timeout)
  | 'no_building_coords' // tòa chưa cấu hình toạ độ → bỏ qua so khoảng cách
  | 'disabled'; // tắt kiểm tra GPS trong Cài đặt

export interface WatermarkBuildingInfo {
  name?: string | null;
  street_address?: string | null;
  ward?: string | null;
  district?: string | null;
  province?: string | null;
}

export interface BuildWatermarkInput {
  at: Date;
  building?: WatermarkBuildingInfo | null;
  gps?: { lat: number; lng: number } | null;
  distanceM?: number | null;
  status: GeofenceStatus;
}

export interface WatermarkModel {
  time: string; // "23:02"
  weekday: string; // "Chủ nhật"
  dateLine: string; // "28 Tháng 6, 2026"
  title: string; // tên tòa (có thể rỗng)
  address: string; // địa chỉ đầy đủ 1 dòng (canvas/CSS tự xuống dòng)
  gpsLine: string; // "" nếu không hiển thị
  gpsAlert: boolean; // true → tô đỏ (ngoài phạm vi)
}

const WEEKDAYS_VI = [
  'Chủ nhật',
  'Thứ Hai',
  'Thứ Ba',
  'Thứ Tư',
  'Thứ Năm',
  'Thứ Sáu',
  'Thứ Bảy',
];

const pad2 = (n: number) => n.toString().padStart(2, '0');

export function formatLatLng(lat: number, lng: number): string {
  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

export function buildWatermarkLines(input: BuildWatermarkInput): WatermarkModel {
  const { at, building, gps, distanceM, status } = input;

  const time = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  const weekday = WEEKDAYS_VI[at.getDay()] ?? '';
  const dateLine = `${at.getDate()} Tháng ${at.getMonth() + 1}, ${at.getFullYear()}`;

  const title = building?.name?.trim() || '';
  const address = [
    building?.street_address,
    building?.ward,
    building?.district,
    building?.province,
  ]
    .map((s) => s?.trim())
    .filter(Boolean)
    .join(', ');

  let gpsLine = '';
  let gpsAlert = false;
  const dist = typeof distanceM === 'number' ? Math.round(distanceM) : null;
  switch (status) {
    case 'ok':
      gpsLine = gps
        ? `GPS ${formatLatLng(gps.lat, gps.lng)}${dist != null ? ` • cách tòa ${dist}m` : ''}`
        : '';
      break;
    case 'out_of_range':
      gpsAlert = true;
      gpsLine = gps
        ? `⚠ Ngoài phạm vi${dist != null ? ` ${dist}m` : ''} — ${formatLatLng(gps.lat, gps.lng)}`
        : '⚠ Ngoài phạm vi';
      break;
    case 'no_building_coords':
      gpsLine = gps ? `GPS ${formatLatLng(gps.lat, gps.lng)}` : '';
      break;
    case 'gps_denied':
      gpsLine = 'GPS không xác định';
      break;
    case 'disabled':
    default:
      gpsLine = '';
  }

  return { time, weekday, dateLine, title, address, gpsLine, gpsAlert };
}

// ---------------------------------------------------------------------------
// Canvas burn
// ---------------------------------------------------------------------------

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  if (!text) return [];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Vẽ watermark vào góc dưới canvas (đã chứa ảnh). Tự co giãn theo bề rộng ảnh.
 */
export function drawWatermark(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  model: WatermarkModel,
): void {
  const margin = Math.round(w * 0.04);
  const fTime = Math.round(w * 0.075);
  const fMeta = Math.round(w * 0.03);
  const fAddr = Math.round(w * 0.028);
  const fGps = Math.round(w * 0.026);
  const gap = Math.round(w * 0.012);
  const family = "system-ui, 'Segoe UI', Roboto, sans-serif";

  // Đo trước chiều cao khối để vẽ nền gradient vừa đủ.
  ctx.textBaseline = 'alphabetic';
  ctx.font = `400 ${fAddr}px ${family}`;
  const addrLines = wrapText(ctx, model.address, w - margin * 2);
  const titleLines = model.title ? wrapText(ctx, model.title, w - margin * 2) : [];

  const timeBlockH = fTime; // hàng giờ + meta
  let blockH = margin; // padding dưới
  blockH += timeBlockH + gap;
  blockH += titleLines.length * (fAddr + gap * 0.4);
  blockH += addrLines.length * (fAddr + gap * 0.4);
  if (model.gpsLine) blockH += fGps + gap;
  blockH += gap;

  const bandH = Math.min(h, Math.max(blockH + margin, h * 0.22));
  const grad = ctx.createLinearGradient(0, h - bandH, 0, h);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(0.35, 'rgba(0,0,0,0.45)');
  grad.addColorStop(1, 'rgba(0,0,0,0.78)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, h - bandH, w, bandH);

  // Layout từ trên xuống bên trong dải.
  let y = h - blockH + timeBlockH;

  // Giờ lớn bên trái
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.font = `700 ${fTime}px ${family}`;
  ctx.fillText(model.time, margin, y);
  const timeW = ctx.measureText(model.time).width;

  // Vạch ngăn + thứ/ngày bên phải giờ
  const sepX = margin + timeW + Math.round(w * 0.03);
  ctx.strokeStyle = '#facc15'; // vàng như Timemark
  ctx.lineWidth = Math.max(2, Math.round(w * 0.004));
  ctx.beginPath();
  ctx.moveTo(sepX, y - fTime + Math.round(fTime * 0.1));
  ctx.lineTo(sepX, y + Math.round(fTime * 0.05));
  ctx.stroke();

  const metaX = sepX + Math.round(w * 0.025);
  ctx.fillStyle = '#ffffff';
  ctx.font = `600 ${fMeta}px ${family}`;
  ctx.fillText(model.dateLine, metaX, y - fTime + fMeta);
  ctx.font = `400 ${fMeta}px ${family}`;
  ctx.fillText(model.weekday, metaX, y - fTime + fMeta * 2 + gap * 0.4);

  // Tên tòa + địa chỉ
  y += gap;
  ctx.font = `600 ${fAddr}px ${family}`;
  ctx.fillStyle = '#ffffff';
  for (const line of titleLines) {
    y += fAddr + gap * 0.4;
    ctx.fillText(line, margin, y);
  }
  ctx.font = `400 ${fAddr}px ${family}`;
  ctx.fillStyle = '#e5e7eb';
  for (const line of addrLines) {
    y += fAddr + gap * 0.4;
    ctx.fillText(line, margin, y);
  }

  // Dòng GPS
  if (model.gpsLine) {
    y += fGps + gap;
    ctx.font = `600 ${fGps}px ${family}`;
    ctx.fillStyle = model.gpsAlert ? '#f87171' : '#86efac';
    ctx.fillText(model.gpsLine, margin, y);
  }
}
