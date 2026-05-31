import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Copy, Download, Check, ExternalLink, Building2, DoorOpen } from 'lucide-react';
import { toast } from '@/hooks/use-toast';

interface ContractQRDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Mã ngắn của hợp đồng (contracts.public_code) — dựng link /c/<code>. */
  publicCode: string;
  contractLabel: string;
  /** Tên toà nhà — hiện dưới ảnh QR. */
  buildingName?: string | null;
  /** Mã/tên phòng — hiện dưới ảnh QR. */
  roomName?: string | null;
}

const QR_SIZE = 480;

/** Font "dễ thương" (rounded) cho nhãn phòng/toà — load ở index.html. */
const CUTE_FONT = "'Baloo 2', system-ui, sans-serif";

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
const composeExportImage = async (
  qrUrl: string,
  roomName?: string | null,
  buildingName?: string | null,
): Promise<string> => {
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
};

export default function ContractQRDialog({
  open,
  onOpenChange,
  publicCode,
  contractLabel,
  buildingName,
  roomName,
}: ContractQRDialogProps) {
  // dataUrl: ảnh QR thuần (preview trên màn hình).
  // imageUrl: ảnh ghép QR + nhãn phòng/toà (dùng khi Copy / Tải xuống).
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const publicUrl = `${window.location.origin}/c/${publicCode}`;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setImageUrl(null);
    (async () => {
      try {
        const url = await QRCode.toDataURL(publicUrl, {
          width: QR_SIZE,
          margin: 2,
          errorCorrectionLevel: 'M',
          color: { dark: '#000000', light: '#ffffff' },
        });
        if (cancelled) return;
        setDataUrl(url);
        const composed = await composeExportImage(url, roomName, buildingName);
        if (!cancelled) setImageUrl(composed);
      } catch (err: any) {
        if (!cancelled) {
          toast({
            title: 'Lỗi tạo QR',
            description: err?.message || String(err),
            variant: 'destructive',
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, publicUrl, roomName, buildingName]);

  const dataUrlToBlob = async (url: string): Promise<Blob> => {
    const res = await fetch(url);
    return res.blob();
  };

  const handleCopyImage = async () => {
    if (!imageUrl) return;
    try {
      if (!navigator.clipboard || !window.ClipboardItem) {
        throw new Error(
          'Trình duyệt không hỗ trợ copy ảnh. Vui lòng dùng nút Tải xuống.',
        );
      }
      const blob = await dataUrlToBlob(imageUrl);
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': blob }),
      ]);
      setCopied(true);
      toast({ title: 'Đã copy ảnh QR vào clipboard' });
      setTimeout(() => setCopied(false), 2000);
    } catch (e: any) {
      toast({
        title: 'Không copy được',
        description: e?.message || 'Lỗi không xác định',
        variant: 'destructive',
      });
    }
  };

  const handleDownload = () => {
    if (!imageUrl) return;
    const link = document.createElement('a');
    link.download = `QR-${contractLabel.replace(/\s+/g, '_')}.png`;
    link.href = imageUrl;
    link.click();
  };

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(publicUrl);
      toast({ title: 'Đã copy link' });
    } catch {
      toast({ title: 'Không copy được link', variant: 'destructive' });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>QR Code hợp đồng {contractLabel}</DialogTitle>
          <DialogDescription>
            Khách quét QR sẽ xem được hoá đơn mới nhất của hợp đồng này
            (không cần đăng nhập). QR sẽ vô hiệu sau khi thanh lý hợp đồng.
          </DialogDescription>
        </DialogHeader>

        <div className="flex w-full min-w-0 flex-col items-center gap-4 py-2">
          <div className="rounded-lg border bg-white p-3 inline-block max-w-full">
            {dataUrl ? (
              <img
                src={dataUrl}
                alt={`QR hợp đồng ${contractLabel}`}
                width={280}
                height={280}
                className="block h-auto w-full max-w-[280px]"
              />
            ) : (
              <div className="aspect-square w-full max-w-[280px] flex items-center justify-center text-sm text-gray-400">
                Đang tạo QR...
              </div>
            )}
          </div>

          {/* Nhãn phòng + toà nhà (font dễ thương + icon màu sắc) */}
          {(buildingName || roomName) && (
            <div
              className="flex flex-col items-center gap-1.5 text-center"
              style={{ fontFamily: CUTE_FONT }}
            >
              {roomName && (
                <div className="flex items-center gap-2 rounded-full bg-gradient-to-r from-pink-100 via-rose-100 to-amber-100 px-4 py-1 text-xl font-extrabold text-rose-600 shadow-sm ring-1 ring-rose-200">
                  <DoorOpen className="h-5 w-5 text-amber-500" />
                  <span>Phòng {roomName}</span>
                </div>
              )}
              {buildingName && (
                <div className="flex items-center gap-1.5 text-sm font-bold text-violet-600">
                  <Building2 className="h-4 w-4 text-violet-500" />
                  <span>{buildingName}</span>
                </div>
              )}
            </div>
          )}

          <div className="w-full min-w-0">
            <div className="text-xs text-gray-500 mb-1">Link công khai</div>
            <button
              type="button"
              onClick={handleCopyLink}
              className="flex w-full min-w-0 items-center gap-1 text-left text-xs font-mono text-blue-600 hover:text-blue-800"
              title="Bấm để copy"
            >
              <ExternalLink className="h-3 w-3 shrink-0" />
              <span className="truncate">{publicUrl}</span>
            </button>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-2">
          <Button
            onClick={handleCopyImage}
            className="flex-1"
            variant="default"
            disabled={!imageUrl}
          >
            {copied ? (
              <Check className="h-4 w-4 mr-2" />
            ) : (
              <Copy className="h-4 w-4 mr-2" />
            )}
            {copied ? 'Đã copy' : 'Copy ảnh QR'}
          </Button>
          <Button
            onClick={handleDownload}
            variant="outline"
            className="flex-1"
            disabled={!imageUrl}
          >
            <Download className="h-4 w-4 mr-2" />
            Tải xuống
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
