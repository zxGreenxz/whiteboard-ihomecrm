import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Camera, CheckCircle2, Loader2, RefreshCw, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import type { CCCDQrData } from '@/lib/cccdQrParser';
import { useCccdQrCamera } from './useCccdQrCamera';

interface CCCDQrCameraScannerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onParsed: (data: CCCDQrData) => void | Promise<void>;
  onCapture: (file: File) => void | Promise<void>;
}

const VIEWFINDER_RATIO = 0.72;

function beepOk() {
  try {
    const withWebkit = window as typeof window & { webkitAudioContext?: typeof AudioContext };
    const AudioContextConstructor = window.AudioContext ?? withWebkit.webkitAudioContext;
    if (!AudioContextConstructor) return;
    const context = new AudioContextConstructor();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = 1175;
    gain.gain.setValueAtTime(0.001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.25, context.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.18);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.2);
    setTimeout(() => { void context.close(); }, 400);
  } catch { /* Audio feedback is optional. */ }
}

export default function CCCDQrCameraScanner({ open, onOpenChange, onParsed, onCapture }: CCCDQrCameraScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const onCaptureRef = useRef(onCapture);
  const openRef = useRef(open);
  const captureGenerationRef = useRef(0);
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState('');
  onCaptureRef.current = onCapture;
  openRef.current = open;

  useEffect(() => {
    if (!open) {
      ++captureGenerationRef.current;
      setCapturing(false);
      setCaptureError('');
    }
  }, [open]);

  useEffect(() => () => { ++captureGenerationRef.current; }, []);

  const camera = useCccdQrCamera({
    open,
    videoRef,
    containerRef,
    onParsed,
    onAmbiguous: () => toast.error('Khung hình có nhiều QR CCCD. Chỉ giữ một thẻ trong khung.'),
    onClose: () => onOpenChange(false),
    beep: beepOk,
    vibrate: () => { if ('vibrate' in navigator) navigator.vibrate(120); },
  });

  const captureCard = async () => {
    const generation = ++captureGenerationRef.current;
    setCapturing(true);
    setCaptureError('');
    try {
      const file = await camera.captureCard();
      if (generation !== captureGenerationRef.current || !openRef.current) return;
      await onCaptureRef.current(file);
      if (generation !== captureGenerationRef.current || !openRef.current) return;
      onOpenChange(false);
    } catch {
      if (generation !== captureGenerationRef.current || !openRef.current) return;
      setCaptureError('Không chụp được ảnh thẻ. Vui lòng thử lại.');
      setCapturing(false);
    }
  };

  const message = camera.status === 'starting'
    ? 'Đang mở camera...'
    : camera.status === 'paused'
      ? 'Camera tạm dừng khi ứng dụng ở nền'
      : camera.status === 'detected'
        ? 'OK — đã đọc QR'
        : camera.status === 'ambiguous'
          ? 'Có nhiều thẻ trong khung'
          : 'Đưa mã QR vào khung';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md p-0 overflow-hidden gap-0" hideClose aria-describedby={undefined}>
        <DialogTitle className="sr-only">Quét QR CCCD bằng camera</DialogTitle>
        <div ref={containerRef} className="relative bg-black aspect-square w-full">
          <video ref={videoRef} playsInline muted autoPlay className="absolute inset-0 w-full h-full object-cover" />
          <div className="absolute inset-0 pointer-events-none">
            <div data-testid="cccd-camera-viewfinder" className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" style={{ width: `${VIEWFINDER_RATIO * 100}%`, aspectRatio: '1 / 1' }}>
              <div className="absolute -inset-[1000px]" style={{ boxShadow: '0 0 0 1000px rgba(0,0,0,0.55)', borderRadius: '8px' }} />
              <div className={`absolute inset-0 rounded-lg border-2 ${camera.status === 'detected' ? 'border-green-400' : camera.status === 'ambiguous' ? 'border-amber-400' : 'border-white/80'}`} />
              {(camera.status === 'scanning' || camera.status === 'ambiguous') && <div className="absolute inset-x-2 top-0 h-0.5 bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.8)] animate-scan-line" />}
            </div>
          </div>
          <div role="status" className="absolute top-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-black/60 text-white text-sm flex items-center gap-2 backdrop-blur-sm whitespace-nowrap">
            {camera.status === 'starting' ? <Loader2 className="h-4 w-4 animate-spin" /> : camera.status === 'detected' ? <CheckCircle2 className="h-4 w-4 text-green-400" /> : camera.status === 'error' ? <AlertCircle className="h-4 w-4 text-red-400" /> : <span className="h-2 w-2 rounded-full bg-green-400 animate-pulse" />}
            <span>{camera.status === 'error' ? 'Lỗi camera' : message}</span>
          </div>
          <button type="button" onClick={() => onOpenChange(false)} className="absolute top-3 right-3 h-9 w-9 rounded-full bg-black/60 text-white flex items-center justify-center" aria-label="Đóng"><X className="h-5 w-5" /></button>
        </div>

        {camera.status === 'error' ? (
          <div className="p-4 bg-red-50 border-t border-red-100 text-sm">
            <div className="flex items-start gap-2 text-red-700"><AlertCircle className="h-4 w-4 mt-0.5 shrink-0" /><span className="flex-1">{camera.error}</span></div>
            <div className="mt-3 flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>Đóng</Button>
              <Button type="button" size="sm" onClick={camera.retry}><RefreshCw className="h-4 w-4 mr-1" /> Thử lại</Button>
            </div>
          </div>
        ) : (
          <div className="px-4 py-3 bg-gray-50 border-t space-y-2">
            <p className="text-xs text-muted-foreground text-center">Hệ thống tự đọc QR. Nếu QR không nhận, đặt trọn mặt trước CCCD trong ảnh rồi chụp để đọc chữ.</p>
            {captureError && <p role="alert" className="text-xs text-red-600 text-center">{captureError}</p>}
            <Button type="button" variant="outline" className="w-full" disabled={capturing || camera.status === 'starting' || camera.status === 'paused'} onClick={() => { void captureCard(); }}>
              {capturing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Camera className="h-4 w-4 mr-2" />}Đọc chữ trên thẻ
            </Button>
            {camera.devices.length > 1 && (
              <label className="block text-xs text-muted-foreground">Camera
                <select className="mt-1 h-9 w-full rounded-md border bg-white px-2 text-sm" value={camera.settings?.deviceId ?? ''} onChange={(event) => camera.selectDevice(event.target.value)}>
                  {camera.devices.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>)}
                </select>
              </label>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
