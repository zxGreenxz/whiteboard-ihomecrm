import { useProvinces, useDistricts, useWards } from '@/hooks/useAddressData';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface AddressCascadingDropdownsProps {
  // Nhận cả `null`: ba giá trị này đến thẳng từ bản ghi `customers`, nơi cột
  // chưa chọn là `null` chứ không phải `undefined`. Ép người gọi viết
  // `?? undefined` chỉ để vừa kiểu là bẻ dữ liệu cho vừa cái kiểu, và chỗ nào
  // quên thì lỗi lại chui vào baseline.
  provinceValue?: string | null;
  districtValue?: string | null;
  wardValue?: string | null;
  onProvinceChange: (value: string) => void;
  onDistrictChange: (value: string) => void;
  onWardChange: (value: string) => void;
}

export default function AddressCascadingDropdowns({
  provinceValue,
  districtValue,
  wardValue,
  onProvinceChange,
  onDistrictChange,
  onWardChange,
}: AddressCascadingDropdownsProps) {
  const { provinces, isLoading: loadingProvinces } = useProvinces();
  const { districts, isLoading: loadingDistricts } = useDistricts(provinceValue);
  const { wards, isLoading: loadingWards } = useWards(districtValue);

  const handleProvinceChange = (value: string) => {
    onProvinceChange(value);
    onDistrictChange('');
    onWardChange('');
  };

  const handleDistrictChange = (value: string) => {
    onDistrictChange(value);
    onWardChange('');
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {/* Province */}
      <div className="space-y-1.5">
        <label className="text-sm font-medium text-gray-700">Tỉnh/Thành phố</label>
        <Select value={provinceValue || ''} onValueChange={handleProvinceChange}>
          <SelectTrigger>
            <SelectValue placeholder={loadingProvinces ? 'Đang tải...' : 'Chọn Tỉnh/TP'} />
          </SelectTrigger>
          <SelectContent>
            {provinces.map((p) => (
              <SelectItem key={p.code} value={String(p.code)}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* District */}
      <div className="space-y-1.5">
        <label className="text-sm font-medium text-gray-700">Quận/Huyện</label>
        <Select
          value={districtValue || ''}
          onValueChange={handleDistrictChange}
          disabled={!provinceValue}
        >
          <SelectTrigger>
            <SelectValue placeholder={loadingDistricts ? 'Đang tải...' : 'Chọn Quận/Huyện'} />
          </SelectTrigger>
          <SelectContent>
            {districts.map((d) => (
              <SelectItem key={d.code} value={String(d.code)}>
                {d.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Ward */}
      <div className="space-y-1.5">
        <label className="text-sm font-medium text-gray-700">Xã/Phường</label>
        <Select
          value={wardValue || ''}
          onValueChange={onWardChange}
          disabled={!districtValue}
        >
          <SelectTrigger>
            <SelectValue placeholder={loadingWards ? 'Đang tải...' : 'Chọn Xã/Phường'} />
          </SelectTrigger>
          <SelectContent>
            {wards.map((w) => (
              <SelectItem key={w.code} value={String(w.code)}>
                {w.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
