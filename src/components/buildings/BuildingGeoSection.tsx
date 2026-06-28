import { useState } from 'react';
import { UseFormSetValue, UseFormWatch } from 'react-hook-form';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { MapPin, Loader2, Eraser } from 'lucide-react';
import { toast } from 'sonner';
import { parseLatLngFromMapsUrl, isValidLatLng } from '@/lib/geo';
import type { BuildingFormData } from '@/types/building';

interface BuildingGeoSectionProps {
  setValue: UseFormSetValue<BuildingFormData>;
  watch: UseFormWatch<BuildingFormData>;
}

/**
 * BuildingGeoSection — toạ độ GPS của tòa nhà, dùng làm mốc geo-fence khi
 * nhân viên hoàn thành công việc. Cách nhập:
 *  - Nút "Lấy vị trí hiện tại" (đứng tại tòa bấm 1 lần).
 *  - Dán link Google Maps (tự tách toạ độ).
 *  - Nhập tay lat/lng.
 */
export default function BuildingGeoSection({ setValue, watch }: BuildingGeoSectionProps) {
  const [locating, setLocating] = useState(false);
  const [mapsLink, setMapsLink] = useState('');

  const lat = watch('latitude');
  const lng = watch('longitude');
  const hasCoords = isValidLatLng(lat, lng);

  const setCoords = (la: number, lo: number) => {
    setValue('latitude', Number(la.toFixed(6)), { shouldValidate: true, shouldDirty: true });
    setValue('longitude', Number(lo.toFixed(6)), { shouldValidate: true, shouldDirty: true });
  };

  const handleLocate = () => {
    if (!('geolocation' in navigator)) {
      toast.error('Thiết bị không hỗ trợ định vị');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords(pos.coords.latitude, pos.coords.longitude);
        setLocating(false);
        toast.success(`Đã lấy vị trí (±${Math.round(pos.coords.accuracy)}m)`);
      },
      (err) => {
        setLocating(false);
        toast.error(
          err.code === err.PERMISSION_DENIED
            ? 'Bạn cần cho phép quyền vị trí'
            : 'Không lấy được vị trí, thử lại',
        );
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  };

  const handleMapsLink = (value: string) => {
    setMapsLink(value);
    const parsed = parseLatLngFromMapsUrl(value);
    if (parsed) {
      setCoords(parsed.lat, parsed.lng);
      toast.success('Đã tách toạ độ từ link');
    }
  };

  const handleClear = () => {
    setValue('latitude', null, { shouldDirty: true });
    setValue('longitude', null, { shouldDirty: true });
    setMapsLink('');
  };

  const parseNum = (v: string): number | null => {
    if (v.trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  return (
    <div className="space-y-3 pt-2 border-t">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-medium">
          Toạ độ GPS{' '}
          <span className="text-xs font-normal text-muted-foreground">
            (mốc geo-fence khi nghiệm thu công việc)
          </span>
        </Label>
        {hasCoords && (
          <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={handleClear}>
            <Eraser className="h-3.5 w-3.5 mr-1" /> Xoá
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Vĩ độ (lat)</Label>
          <Input
            type="number"
            step="any"
            inputMode="decimal"
            placeholder="VD: 10.806"
            className="w-36"
            value={lat ?? ''}
            onChange={(e) => setValue('latitude', parseNum(e.target.value), { shouldDirty: true })}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Kinh độ (lng)</Label>
          <Input
            type="number"
            step="any"
            inputMode="decimal"
            placeholder="VD: 106.665"
            className="w-36"
            value={lng ?? ''}
            onChange={(e) => setValue('longitude', parseNum(e.target.value), { shouldDirty: true })}
          />
        </div>
        <Button type="button" variant="outline" onClick={handleLocate} disabled={locating}>
          {locating ? (
            <>
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Đang lấy…
            </>
          ) : (
            <>
              <MapPin className="h-4 w-4 mr-1.5" /> Lấy vị trí hiện tại
            </>
          )}
        </Button>
      </div>

      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">Hoặc dán link Google Maps</Label>
        <Input
          placeholder="https://maps.google.com/?q=10.806,106.665"
          value={mapsLink}
          onChange={(e) => handleMapsLink(e.target.value)}
        />
      </div>

      {hasCoords && (
        <a
          href={`https://www.google.com/maps?q=${lat},${lng}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
        >
          <MapPin className="h-3 w-3" /> Xem trên bản đồ ({lat}, {lng})
        </a>
      )}
    </div>
  );
}
