// =============================================
// QR ảnh hợp đồng — dùng chung cho ContractQRDialog (xem/tải/copy) và
// hành động "click ô Vị trí để copy QR" ở danh sách hợp đồng.
// Ảnh xuất ra = QR (trên) + nhãn "Phòng <mã>" (pill hồng) + tên toà (chữ tím).
// =============================================

import QRCode from 'qrcode';

export const QR_SIZE = 480;

export interface ContractQrLabels {
  /** Mã/tên phòng — hiện dưới QR ("Phòng <roomName>"). */
  roomName?: string | null;
  /** Tên toà nhà — hiện dưới QR. */
  buildingName?: string | null;
}

/** Link công khai của hợp đồng: /c/<public_code>. */
export function buildPublicContractUrl(publicCode: string): string {
  return `${window.location.origin}/c/${publicCode}`;
}

/** Tạo ảnh QR thuần (PNG dataURL) cho 1 URL. */
export function createQrDataUrl(url: string): Promise<string> {
  return QRCode.toDataURL(url, {
    width: QR_SIZE,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#ffffff' },
  });
}

const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });

/** Vẽ path hình chữ nhật bo tròn (không dùng ctx.roundRect để tương thích rộng). */
const roundRectPath = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) => {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
};

/**
 * Ghép ảnh xuất ra: QR ở trên, dưới là "Phòng <mã>" (pill hồng) + tên toà
 * nhà (chữ tím), dùng font Baloo 2. Trả về dataURL PNG. Nếu không có nhãn
 * thì trả về luôn ảnh QR gốc.
 */
export async function composeContractQrImage(
  qrUrl: string,
  { roomName, buildingName }: ContractQrLabels,
): Promise<string> {
  const hasLabel = !!(roomName || buildingName);
  if (!hasLabel) return qrUrl;

  const qrImg = await loadImage(qrUrl);
  const size = QR_SIZE;

  // Đảm bảo font Baloo 2 sẵn sàng trước khi vẽ canvas (nếu bị chặn → fallback).
  try {
    const fonts = (document as any).fonts;
    if (fonts?.load) {
      await Promise.all([
        fonts.load("800 40px 'Baloo 2'"),
        fonts.load("700 30px 'Baloo 2'"),
      ]);
    }
  } catch {
    /* fallback system-ui */
  }

  const gapTop = 26;
  const pillH = roomName ? 60 : 0;
  const midGap = roomName && buildingName ? 12 : 0;
  const bldgH = buildingName ? 44 : 0;
  const bottomPad = 30;
  const width = size;
  const height = size + gapTop + pillH + midGap + bldgH + bottomPad;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return qrUrl;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(qrImg, 0, 0, size, size);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let y = size + gapTop;

  if (roomName) {
    const text = `Phòng ${roomName}`;
    ctx.font = "800 40px 'Baloo 2', system-ui, sans-serif";
    const tw = ctx.measureText(text).width;
    const pillW = Math.min(tw + 56, width - 24);
    const pillX = (width - pillW) / 2;
    roundRectPath(ctx, pillX, y, pillW, pillH, pillH / 2);
    ctx.fillStyle = '#ffe4e6'; // rose-100
    ctx.fill();
    ctx.fillStyle = '#e11d48'; // rose-600
    ctx.fillText(text, width / 2, y + pillH / 2 + 2);
    y += pillH + midGap;
  }
  if (buildingName) {
    ctx.font = "700 30px 'Baloo 2', system-ui, sans-serif";
    ctx.fillStyle = '#7c3aed'; // violet-600
    ctx.fillText(buildingName, width / 2, y + bldgH / 2);
  }

  return canvas.toDataURL('image/png');
}

/** Tạo thẳng ảnh QR đã ghép nhãn từ public_code của hợp đồng. */
export async function createContractQrImage(
  opts: { publicCode: string } & ContractQrLabels,
): Promise<string> {
  const qr = await createQrDataUrl(buildPublicContractUrl(opts.publicCode));
  return composeContractQrImage(qr, opts);
}

export async function dataUrlToBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  return res.blob();
}

/**
 * Ghi 1 ảnh PNG vào clipboard, GIỮ "user gesture": truyền thẳng Promise<Blob>
 * vào ClipboardItem để clipboard.write được gọi đồng bộ trong cú click (Safari
 * sẽ reject NotAllowedError nếu await blob trước rồi mới write). Ném lỗi nếu
 * trình duyệt không hỗ trợ.
 */
function writePngToClipboard(
  blob: Blob | Promise<Blob>,
  unsupportedMsg: string,
): Promise<void> {
  if (!navigator.clipboard || typeof window.ClipboardItem === 'undefined') {
    return Promise.reject(new Error(unsupportedMsg));
  }
  return navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

/** Copy 1 ảnh PNG (dataURL) đã có sẵn vào clipboard (gesture-safe). */
export function copyImageDataUrlToClipboard(dataUrl: string): Promise<void> {
  return writePngToClipboard(
    dataUrlToBlob(dataUrl),
    'Trình duyệt không hỗ trợ copy ảnh. Vui lòng dùng nút Tải xuống.',
  );
}

/**
 * Copy ảnh QR (đã ghép nhãn) vào clipboard từ public_code — tự tạo ảnh rồi
 * ghi, vẫn gesture-safe vì Promise<Blob> được truyền thẳng vào ClipboardItem.
 */
export function copyContractQrToClipboard(
  opts: { publicCode: string } & ContractQrLabels,
): Promise<void> {
  return writePngToClipboard(
    createContractQrImage(opts).then(dataUrlToBlob),
    'Trình duyệt không hỗ trợ copy ảnh. Mở chi tiết hợp đồng để tải QR.',
  );
}
