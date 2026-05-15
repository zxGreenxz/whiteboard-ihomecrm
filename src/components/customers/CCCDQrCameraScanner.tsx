import { useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CheckCircle2, Loader2, AlertCircle, RefreshCw, X } from 'lucide-react';
import { decodeQrFromRoi, type Roi } from '@/lib/qrDecoder';
import { parseCccdQr, type CCCDQrData } from '@/lib/cccdQrParser';
import { toast } from 'sonner';

interface CCCDQrCameraScannerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onParsed: (data: CCCDQrData) => void;
}

type ScannerStatus = 'starting' | 'scanning' | 'detected' | 'error';

/**
 * Hộp khung quét hình vuông ở giữa video. Tỉ lệ so với cạnh ngắn để vừa
 * cả landscape lẫn portrait. ROI gửi vào decoder cũng dùng đúng vùng này.
 */
const VIEWFINDER_RATIO = 0.72;

function beepOk() {
  try {
    const Ctx =
      (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
        .AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 1175;
    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
    setTimeout(() => ctx.close().catch(() => {}), 400);
  } catch {
    /* no audio */
  }
}

export default function CCCDQrCameraScanner({
  open,
  onOpenChange,
  onParsed,
}: CCCDQrCameraScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const stopFlagRef = useRef(false);
  const [status, setStatus] = useState<ScannerStatus>('starting');
  const [errorMsg, setErrorMsg] = useState<string>('');

  useEffect(() => {
    if (!open) return;
    stopFlagRef.current = false;
    setStatus('starting');
    setErrorMsg('');

    let cancelled = false;

    const start = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('Trình duyệt không hỗ trợ camera');
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play().catch(() => {});
        setStatus('scanning');
        scanLoop();
      } catch (e) {
        if (cancelled) return;
        const msg =
          e instanceof Error
            ? e.name === 'NotAllowedError'
              ? 'Bạn cần cho phép truy cập camera để quét QR'
              : e.name === 'NotFoundError'
                ? 'Không tìm thấy camera trên thiết bị'
                : e.message
            : 'Không mở được camera';
        setErrorMsg(msg);
        setStatus('error');
      }
    };

    const scanLoop = async () => {
      while (!stopFlagRef.current && !cancelled) {
        const video = videoRef.current;
        if (video && video.readyState >= 2 && video.videoWidth > 0) {
          const w = video.videoWidth;
          const h = video.videoHeight;
          const side = Math.round(Math.min(w, h) * VIEWFINDER_RATIO);
          const roi: Roi = {
            x: Math.round((w - side) / 2),
            y: Math.round((h - side) / 2),
            width: side,
            height: side,
          };
          try {
            const raw = await decodeQrFromRoi(video, roi);
            if (raw) {
              let parsed: CCCDQrData | null = null;
              try {
                parsed = parseCccdQr(raw);
              } catch (err) {
                // QR đọc được nhưng không đúng format CCCD — báo lỗi nhẹ và tiếp tục quét
                const m = err instanceof Error ? err.message : 'QR không đúng định dạng CCCD';
                toast.error(m);
                await new Promise((r) => setTimeout(r, 800));
                continue;
              }
              if (parsed) {
                stopFlagRef.current = true;
                setStatus('detected');
                beepOk();
                if ('vibrate' in navigator) {
                  try {
                    navigator.vibrate(120);
                  } catch {
                    /* ignore */
                  }
                }
                onParsed(parsed);
                toast.success('Đã đọc thông tin từ QR CCCD');
                setTimeout(() => onOpenChange(false), 600);
                return;
              }
            }
          } catch {
            // decoder fail trên 1 frame — bỏ qua, thử frame kế
          }
        }
        await new Promise((r) => setTimeout(r, 150));
      }
    };

    void start();

    return () => {
      cancelled = true;
      stopFlagRef.current = true;
      const stream = streamRef.current;
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      const video = videoRef.current;
      if (video) {
        video.srcObject = null;
      }
    };
  }, [open, onParsed, onOpenChange]);

  const handleRetry = () => {
    setStatus('starting');
    setErrorMsg('');
    onOpenChange(false);
    setTimeout(() => onOpenChange(true), 50);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md p-0 overflow-hidden gap-0"
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogTitle className="sr-only">Quét QR CCCD bằng camera</DialogTitle>
        <div className="relative bg-black aspect-square w-full">
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            className="absolute inset-0 w-full h-full object-cover"
          />

          {/* Viewfinder overlay */}
          <div className="absolute inset-0 pointer-events-none">
            <div
              className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
              style={{ width: `${VIEWFINDER_RATIO * 100}%`, aspectRatio: '1 / 1' }}
            >
              {/* Mask làm tối ngoài khung */}
              <div
                className="absolute -inset-[1000px] pointer-events-none"
                style={{
                  boxShadow: '0 0 0 1000px rgba(0,0,0,0.55)',
                  borderRadius: '8px',
                }}
              />
              {/* 4 góc khung quét */}
              <div
                className={`absolute inset-0 rounded-lg border-2 transition-colors ${
                  status === 'detected'
                    ? 'border-green-400'
                    : status === 'scanning'
                      ? 'border-white/80'
                      : 'border-white/40'
                }`}
              />
              {/* Scan line */}
              {status === 'scanning' && (
                <div className="absolute inset-x-2 top-0 h-0.5 bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.8)] animate-scan-line" />
              )}
            </div>
          </div>

          {/* Status badge */}
          <div className="absolute top-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-black/60 text-white text-sm flex items-center gap-2 backdrop-blur-sm">
            {status === 'starting' && (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Đang mở camera...</span>
              </>
            )}
            {status === 'scanning' && (
              <>
                <span className="h-2 w-2 rounded-full bg-green-400 animate-pulse" />
                <span>Đưa mã QR vào khung</span>
              </>
            )}
            {status === 'detected' && (
              <>
                <CheckCircle2 className="h-4 w-4 text-green-400" />
                <span>OK — đã đọc QR</span>
              </>
            )}
            {status === 'error' && (
              <>
                <AlertCircle className="h-4 w-4 text-red-400" />
                <span>Lỗi camera</span>
              </>
            )}
          </div>

          {/* Close button */}
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="absolute top-3 right-3 h-9 w-9 rounded-full bg-black/60 text-white flex items-center justify-center backdrop-blur-sm hover:bg-black/80"
            aria-label="Đóng"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Error footer */}
        {status === 'error' && (
          <div className="p-4 bg-red-50 border-t border-red-100 text-sm">
            <div className="flex items-start gap-2 text-red-700">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span className="flex-1">{errorMsg}</span>
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onOpenChange(false)}
              >
                Đóng
              </Button>
              <Button type="button" size="sm" onClick={handleRetry}>
                <RefreshCw className="h-4 w-4 mr-1" /> Thử lại
              </Button>
            </div>
          </div>
        )}

        {status !== 'error' && (
          <div className="px-4 py-3 text-xs text-muted-foreground text-center bg-gray-50 border-t">
            Hệ thống sẽ tự đọc QR khi đưa vào khung — không cần bấm chụp.
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
