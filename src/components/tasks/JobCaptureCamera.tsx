// =============================================================================
// JobCaptureCamera — chụp ảnh TRỰC TIẾP (không cho chọn từ thư viện) cho bước
// "Hoàn thành công việc". Burn watermark ngày/giờ/thứ + ĐỊA CHỈ QUY ĐỔI TỪ GPS
// (reverse-geocode, KHÔNG phải địa chỉ tòa) vào ảnh — Timemark-style. Chốt toạ
// độ + khoảng cách tới tòa lúc bấm chụp. Không bao giờ CHẶN — chỉ ghi audit.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Camera, X, MapPin, Loader2, RotateCcw, Check, AlertTriangle } from 'lucide-react';
import {
  buildWatermarkLines,
  type GeofenceStatus,
  type WatermarkModel,
} from '@/lib/captureWatermark';
import { distanceMeters, isValidLatLng } from '@/lib/geo';
import { reverseGeocode, GEOCODE_ATTRIBUTION } from '@/lib/reverseGeocode';

export interface JobCaptureBuilding {
  latitude?: number | null;
  longitude?: number | null;
}

export interface JobCaptureResult {
  file: File;
  lat: number | null;
  lng: number | null;
  distanceM: number | null;
  status: GeofenceStatus;
  /** Địa chỉ reverse-geocode từ GPS (null nếu chưa lấy được). */
  address: string | null;
}

interface JobCaptureCameraProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  building?: JobCaptureBuilding | null;
  geofenceEnabled: boolean;
  radiusM: number;
  onCaptured: (result: JobCaptureResult) => void;
}

type GeoState = 'locating' | 'ok' | 'denied' | 'unavailable';
type CamState = 'starting' | 'live' | 'error';

interface Gps {
  lat: number;
  lng: number;
  accuracy: number;
}

function computeStatus(
  geofenceEnabled: boolean,
  buildingHasCoords: boolean,
  gps: Gps | null,
  distanceM: number | null,
  radiusM: number,
): GeofenceStatus {
  if (!geofenceEnabled) return 'disabled';
  if (!gps) return 'gps_denied';
  if (!buildingHasCoords) return 'no_building_coords';
  return distanceM != null && distanceM > radiusM ? 'out_of_range' : 'ok';
}

/** Overlay watermark hiển thị live (trùng dữ liệu với bản burn vào canvas). */
function WatermarkOverlay({
  model,
  addrLoading,
}: {
  model: WatermarkModel;
  addrLoading: boolean;
}) {
  return (
    <div className="absolute inset-x-0 bottom-0 p-4 pb-6 bg-gradient-to-t from-black/80 via-black/45 to-transparent text-white pointer-events-none">
      <div className="flex items-end gap-3">
        <div className="text-4xl font-bold leading-none tabular-nums">{model.time}</div>
        <div className="w-0.5 self-stretch bg-yellow-400 rounded" />
        <div className="leading-tight">
          <div className="text-sm font-semibold">{model.dateLine}</div>
          <div className="text-xs opacity-90">{model.weekday}</div>
        </div>
      </div>
      <div className="mt-1.5 text-sm text-zinc-100 leading-snug min-h-[1.1rem]">
        {model.address || (addrLoading ? 'Đang lấy địa chỉ…' : '')}
      </div>
      {model.gpsLine && (
        <div
          className={`mt-0.5 text-xs font-semibold ${
            model.gpsAlert ? 'text-red-400' : 'text-green-300'
          }`}
        >
          {model.gpsLine}
        </div>
      )}
      {model.address && (
        <div className="mt-0.5 text-[10px] text-zinc-400">{GEOCODE_ATTRIBUTION}</div>
      )}
    </div>
  );
}

export default function JobCaptureCamera({
  open,
  onOpenChange,
  building,
  geofenceEnabled,
  radiusM,
  onCaptured,
}: JobCaptureCameraProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [camState, setCamState] = useState<CamState>('starting');
  const [camError, setCamError] = useState('');
  const [geoState, setGeoState] = useState<GeoState>('locating');
  const [gps, setGps] = useState<Gps | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [geoAddress, setGeoAddress] = useState<string | null>(null);
  const [addrLoading, setAddrLoading] = useState(false);
  const lastGeoRef = useRef<{ lat: number; lng: number } | null>(null);
  const [preview, setPreview] = useState<{ url: string; result: JobCaptureResult } | null>(null);

  const buildingHasCoords = isValidLatLng(building?.latitude, building?.longitude);
  const liveDistance =
    gps && geofenceEnabled && buildingHasCoords
      ? distanceMeters(gps.lat, gps.lng, building!.latitude!, building!.longitude!)
      : null;
  const liveStatus = computeStatus(geofenceEnabled, buildingHasCoords, gps, liveDistance, radiusM);

  const liveModel = buildWatermarkLines({
    at: now,
    address: geoAddress,
    gps,
    distanceM: liveDistance,
    status: liveStatus,
  });

  // ---- Camera lifecycle ----
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCamState('starting');
    setCamError('');
    setPreview(null);

    (async () => {
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
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => {});
        }
        setCamState('live');
      } catch (e) {
        if (cancelled) return;
        const msg =
          e instanceof Error
            ? e.name === 'NotAllowedError'
              ? 'Bạn cần cho phép truy cập camera để chụp ảnh nghiệm thu'
              : e.name === 'NotFoundError'
                ? 'Không tìm thấy camera trên thiết bị'
                : e.message
            : 'Không mở được camera';
        setCamError(msg);
        setCamState('error');
      }
    })();

    return () => {
      cancelled = true;
      const stream = streamRef.current;
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      const video = videoRef.current;
      if (video) video.srcObject = null;
    };
  }, [open]);

  // ---- Geolocation watch (LUÔN chạy để lấy địa chỉ; geofence chỉ điều khiển
  //      việc so khoảng cách) ----
  useEffect(() => {
    if (!open) return;
    setGeoAddress(null);
    lastGeoRef.current = null;
    if (!('geolocation' in navigator)) {
      setGeoState('unavailable');
      return;
    }
    setGeoState('locating');
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        setGps({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        });
        setGeoState('ok');
      },
      (err) => {
        setGeoState(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable');
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [open]);

  // ---- Reverse-geocode địa chỉ từ GPS (debounce + ngưỡng dịch chuyển 20m) ----
  useEffect(() => {
    if (!open || !gps) return;
    if (
      lastGeoRef.current &&
      distanceMeters(gps.lat, gps.lng, lastGeoRef.current.lat, lastGeoRef.current.lng) < 20
    ) {
      return; // đã có địa chỉ cho điểm gần đây
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      setAddrLoading(true);
      const addr = await reverseGeocode(gps.lat, gps.lng);
      if (cancelled) return;
      setAddrLoading(false);
      lastGeoRef.current = { lat: gps.lat, lng: gps.lng }; // đánh dấu đã thử (kể cả null)
      if (addr) setGeoAddress(addr);
    }, 700);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, gps]);

  // ---- Đồng hồ live ----
  useEffect(() => {
    if (!open || preview) return;
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, [open, preview]);

  // ---- Chụp ----
  const handleCapture = useCallback(async () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;
    const at = new Date();
    const frozenGps = gps;
    const frozenDistance =
      frozenGps && geofenceEnabled && buildingHasCoords
        ? distanceMeters(frozenGps.lat, frozenGps.lng, building!.latitude!, building!.longitude!)
        : null;
    const status = computeStatus(
      geofenceEnabled,
      buildingHasCoords,
      frozenGps,
      frozenDistance,
      radiusM,
    );

    // Bảo đảm có địa chỉ trên ảnh: nếu chưa kịp geocode, thử lấy ngay (có timeout).
    let address = geoAddress;
    if (!address && frozenGps) {
      address = await reverseGeocode(frozenGps.lat, frozenGps.lng);
      if (address) setGeoAddress(address);
    }

    const model = buildWatermarkLines({ at, address, gps: frozenGps, distanceM: frozenDistance, status });

    const w = video.videoWidth;
    const h = video.videoHeight;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, w, h);
    const { drawWatermark } = await import('@/lib/captureWatermark');
    drawWatermark(ctx, w, h, model);

    const blob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.9),
    );
    if (!blob) return;
    const file = new File([blob], `cong-viec-${Date.now()}.jpg`, { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    setPreview({
      url,
      result: {
        file,
        lat: frozenGps?.lat ?? null,
        lng: frozenGps?.lng ?? null,
        distanceM: frozenDistance,
        status,
        address: address ?? null,
      },
    });
  }, [gps, geoAddress, building, buildingHasCoords, geofenceEnabled, radiusM]);

  const handleRetake = useCallback(() => {
    if (preview) URL.revokeObjectURL(preview.url);
    setPreview(null);
  }, [preview]);

  const handleConfirm = useCallback(() => {
    if (!preview) return;
    onCaptured(preview.result);
    URL.revokeObjectURL(preview.url);
    setPreview(null);
    onOpenChange(false);
  }, [preview, onCaptured, onOpenChange]);

  // dọn object URL khi đóng
  useEffect(() => {
    if (!open && preview) {
      URL.revokeObjectURL(preview.url);
      setPreview(null);
    }
  }, [open, preview]);

  const geoChip = (() => {
    if (geoState === 'locating')
      return { icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />, text: 'Đang lấy vị trí…', cls: 'bg-black/60' };
    if (geoState === 'ok' && liveStatus === 'out_of_range')
      return { icon: <AlertTriangle className="h-3.5 w-3.5" />, text: `Ngoài phạm vi ${Math.round(liveDistance ?? 0)}m`, cls: 'bg-red-600/80' };
    if (geoState === 'ok' && liveStatus === 'ok')
      return { icon: <MapPin className="h-3.5 w-3.5" />, text: `Trong phạm vi · ${Math.round(liveDistance ?? 0)}m`, cls: 'bg-green-600/80' };
    if (geoState === 'ok' && liveStatus === 'no_building_coords')
      return { icon: <MapPin className="h-3.5 w-3.5" />, text: 'Tòa chưa có toạ độ', cls: 'bg-amber-600/80' };
    if (geoState === 'ok' && liveStatus === 'disabled')
      return { icon: <MapPin className="h-3.5 w-3.5" />, text: 'Đã ghi vị trí', cls: 'bg-black/60' };
    if (geoState === 'denied')
      return { icon: <AlertTriangle className="h-3.5 w-3.5" />, text: 'Không có quyền vị trí', cls: 'bg-amber-600/80' };
    if (geoState === 'unavailable')
      return { icon: <AlertTriangle className="h-3.5 w-3.5" />, text: 'GPS không khả dụng', cls: 'bg-amber-600/80' };
    return null;
  })();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-full w-screen h-[100dvh] p-0 gap-0 border-0 rounded-none !top-0 !left-0 !translate-x-0 !translate-y-0 bg-black"
        onInteractOutside={(e) => e.preventDefault()}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogTitle className="sr-only">Chụp ảnh nghiệm thu công việc</DialogTitle>

        <div className="relative w-full h-full overflow-hidden bg-black">
          {/* Video live */}
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            className={`absolute inset-0 w-full h-full object-cover ${preview ? 'hidden' : ''}`}
          />

          {/* Ảnh preview sau khi chụp */}
          {preview && (
            <img src={preview.url} alt="Ảnh vừa chụp" className="absolute inset-0 w-full h-full object-contain bg-black" />
          )}

          {/* Overlay watermark live */}
          {!preview && camState === 'live' && (
            <WatermarkOverlay model={liveModel} addrLoading={addrLoading} />
          )}

          {/* Chip trạng thái GPS (top center) */}
          {!preview && geoChip && (
            <div className={`absolute top-4 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full text-white text-xs flex items-center gap-1.5 backdrop-blur-sm ${geoChip.cls}`}>
              {geoChip.icon}
              <span>{geoChip.text}</span>
            </div>
          )}

          {/* Nút đóng */}
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="absolute top-4 right-4 h-10 w-10 rounded-full bg-black/60 text-white flex items-center justify-center backdrop-blur-sm hover:bg-black/80"
            aria-label="Đóng"
          >
            <X className="h-5 w-5" />
          </button>

          {/* Trạng thái đang mở camera */}
          {camState === 'starting' && !preview && (
            <div className="absolute inset-0 flex items-center justify-center text-white gap-2">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span>Đang mở camera…</span>
            </div>
          )}

          {/* Lỗi camera */}
          {camState === 'error' && !preview && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-white gap-3 px-8 text-center">
              <AlertTriangle className="h-8 w-8 text-amber-400" />
              <p className="text-sm">{camError}</p>
              <Button variant="secondary" onClick={() => onOpenChange(false)}>
                Đóng
              </Button>
            </div>
          )}

          {/* Thanh hành động dưới cùng */}
          {preview ? (
            <div className="absolute inset-x-0 bottom-0 p-4 pb-7 flex gap-3 bg-gradient-to-t from-black/85 to-transparent">
              <Button
                type="button"
                variant="outline"
                className="flex-1 h-12 bg-white/10 text-white border-white/30 hover:bg-white/20"
                onClick={handleRetake}
              >
                <RotateCcw className="h-5 w-5 mr-1.5" /> Chụp lại
              </Button>
              <Button
                type="button"
                className="flex-1 h-12 bg-green-600 hover:bg-green-700 text-white"
                onClick={handleConfirm}
              >
                <Check className="h-5 w-5 mr-1.5" /> Dùng ảnh này
              </Button>
            </div>
          ) : (
            camState === 'live' && (
              <div className="absolute inset-x-0 bottom-0 h-28 flex items-center justify-center pointer-events-none">
                <button
                  type="button"
                  onClick={handleCapture}
                  className="pointer-events-auto rounded-full bg-white/95 ring-4 ring-white/40 flex items-center justify-center active:scale-95 transition-transform shadow-lg"
                  style={{ height: '4.5rem', width: '4.5rem' }}
                  aria-label="Chụp ảnh"
                >
                  <Camera className="h-7 w-7 text-zinc-900" />
                </button>
              </div>
            )
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
