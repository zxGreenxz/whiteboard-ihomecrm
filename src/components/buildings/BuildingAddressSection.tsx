import { useState, useEffect } from 'react';
import { Control, UseFormSetValue, UseFormWatch } from 'react-hook-form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import {
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from '@/components/ui/form';
import { useProvinces, useDistricts, useWards } from '@/hooks/useAddressData';
import type { BuildingFormData } from '@/types/building';

interface BuildingAddressSectionProps {
  control: Control<BuildingFormData>;
  setValue: UseFormSetValue<BuildingFormData>;
  watch: UseFormWatch<BuildingFormData>;
}

/**
 * BuildingAddressSection
 * Cascading dropdowns: Tỉnh/Thành phố → Quận/Huyện → Xã/Phường
 * Plus Địa chỉ chi tiết text input. (Khu vực gán ở dialog "Quản lý khu vực" —
 * N-N, không còn ô chọn khu trong form toà.)
 *
 * The address API uses codes for cascading but the form stores NAMEs.
 * Local state tracks selected province/district codes for fetching children.
 *
 * Requirements: 2.3, 13.1, 13.2, 13.3, 13.4, 13.5
 */
export default function BuildingAddressSection({
  control,
  setValue,
  watch,
}: BuildingAddressSectionProps) {
  // Local state for cascading codes
  const [provinceCode, setProvinceCode] = useState<string | undefined>();
  const [districtCode, setDistrictCode] = useState<string | undefined>();

  // Address data hooks
  const { provinces, isLoading: loadingProvinces } = useProvinces();
  const { districts, isLoading: loadingDistricts } = useDistricts(provinceCode);
  const { wards, isLoading: loadingWards } = useWards(districtCode);

  // Watch form values for edit mode initialization
  const provinceName = watch('province');
  const districtName = watch('district');

  // On edit mode: resolve name → code when provinces load
  useEffect(() => {
    if (provinceName && provinces.length > 0 && !provinceCode) {
      const found = provinces.find((p) => p.name === provinceName);
      if (found) setProvinceCode(String(found.code));
    }
  }, [provinceName, provinces, provinceCode]);

  // On edit mode: resolve district name → code when districts load
  useEffect(() => {
    if (districtName && districts.length > 0 && !districtCode) {
      const found = districts.find((d) => d.name === districtName);
      if (found) setDistrictCode(String(found.code));
    }
  }, [districtName, districts, districtCode]);

  const handleProvinceChange = (code: string) => {
    const province = provinces.find((p) => String(p.code) === code);
    if (province) {
      setValue('province', province.name, { shouldValidate: true });
      setProvinceCode(code);
      // Reset district + ward
      setValue('district', '', { shouldValidate: false });
      setValue('ward', '', { shouldValidate: false });
      setDistrictCode(undefined);
    }
  };

  const handleDistrictChange = (code: string) => {
    const district = districts.find((d) => String(d.code) === code);
    if (district) {
      setValue('district', district.name, { shouldValidate: true });
      setDistrictCode(code);
      // Reset ward
      setValue('ward', '', { shouldValidate: false });
    }
  };

  const handleWardChange = (code: string) => {
    const ward = wards.find((w) => String(w.code) === code);
    if (ward) {
      setValue('ward', ward.name, { shouldValidate: true });
    }
  };

  // Find current selected codes from names for Select value binding
  const currentProvinceCode = provinceCode || '';
  const currentDistrictCode = districtCode || '';
  const currentWardCode = (() => {
    const wardName = watch('ward');
    if (!wardName || wards.length === 0) return '';
    const found = wards.find((w) => w.name === wardName);
    return found ? String(found.code) : '';
  })();

  return (
    <div className="space-y-4">
      {/* Row 1: Tỉnh/Thành phố | Quận/Huyện */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <FormField
          control={control}
          name="province"
          render={() => (
            <FormItem>
              <FormLabel>
                Tỉnh/Thành phố <span className="text-red-500">*</span>
              </FormLabel>
              <Select value={currentProvinceCode} onValueChange={handleProvinceChange}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder={loadingProvinces ? 'Đang tải...' : 'Chọn Tỉnh/TP'} />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {provinces.map((p) => (
                    <SelectItem key={p.code} value={String(p.code)}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={control}
          name="district"
          render={() => (
            <FormItem>
              <FormLabel>
                Quận/Huyện <span className="text-red-500">*</span>
              </FormLabel>
              <Select
                value={currentDistrictCode}
                onValueChange={handleDistrictChange}
                disabled={!provinceCode}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder={loadingDistricts ? 'Đang tải...' : 'Chọn Quận/Huyện'} />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {districts.map((d) => (
                    <SelectItem key={d.code} value={String(d.code)}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

      {/* Row 2: Xã/Phường */}
      <div className="grid grid-cols-1 gap-4">
        <FormField
          control={control}
          name="ward"
          render={() => (
            <FormItem>
              <FormLabel>
                Xã/Phường <span className="text-red-500">*</span>
              </FormLabel>
              <Select
                value={currentWardCode}
                onValueChange={handleWardChange}
                disabled={!districtCode}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder={loadingWards ? 'Đang tải...' : 'Chọn Xã/Phường'} />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {wards.map((w) => (
                    <SelectItem key={w.code} value={String(w.code)}>
                      {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

      </div>

      {/* Row 3: Địa chỉ chi tiết */}
      <FormField
        control={control}
        name="street_address"
        render={({ field }) => (
          <FormItem>
            <FormLabel>
              Địa chỉ chi tiết <span className="text-red-500">*</span>
            </FormLabel>
            <FormControl>
              <Input placeholder="Nhập địa chỉ chi tiết" {...field} value={field.value ?? ''} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}
